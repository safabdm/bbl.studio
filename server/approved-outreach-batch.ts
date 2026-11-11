/** Explicit one-off owner approval. No cron, queue drain, or global live-send toggle. */
import { createHash } from 'node:crypto';
import { acquireCrmLease, releaseCrmLease, dbReadKv, dbWriteKv, isDurableDbConfigured } from './crm-db.js';
import { buildLeadQueue, extractDomain } from './lead-queue.js';
import { isPublicContactEmail } from './public-contact-email.js';
import { readSnapshot } from './crm-sync-store.js';
import { isEmailDurablySuppressed } from './crm-suppressions.js';
import { checkMarketingIntegrations, readMarketingState, MARKETING_LEASE, MARKETING_STATE, type MarketingEnv } from './marketing-automation.js';
import { complianceFooter, buildUnsubscribeUrl, listUnsubscribeHeaders } from './outreach-policy.js';
import { sendViaResend, recordAcceptedSendsBatch } from './resend-send.js';
import { readDailyCapState, remainingSends, recordSuccessfulSend } from './daily-cap.js';
import { readSendControls, shouldAutoPause } from './send-controls.js';

export type ApprovedBatchEnv = MarketingEnv & { OWNER_APPROVED_OUTREACH_SHA256?: string };
export type ApprovedCopy = { lead_id: string; email: string; subject: string; body: string };
type Entry = ApprovedCopy & { status: 'PREPARED' | 'CLAIMED' | 'ACCEPTED' | 'FAILED' | 'UNCERTAIN'; provider_id?: string; at?: string; error?: string; crm_recorded?: boolean; sent_text?: string };
type Batch = { digest: string; from: 'hello@bbl.studio'; authorization_recorded_at: string; authorization_source: 'owner-configured-production-manifest'; entries: Entry[] };
export type BatchChecks = { provider_and_bbl_identity: boolean; full_inbox_read: boolean; booking_calendar_read: boolean; history_ready: boolean; suppressions_read: boolean; send_health_ready: boolean };
export type BatchDeps = {
  checks(): Promise<BatchChecks>;
  eligible(copy: ApprovedCopy): Promise<boolean>;
  send(copy: ApprovedCopy, text: string, key: string): Promise<{ ok: boolean; id?: string; message: string; status?: number }>;
  record(copy: ApprovedCopy, id: string, at: string, sentText: string): Promise<void>;
};
const batchKey = (digest: string) => `outreach:approved-batch:${digest}`;
const recipientKey = (email: string) => `outreach:approved-recipient:${createHash('sha256').update(email).digest('hex')}`;

export function parseApprovedCopies(value: unknown): ApprovedCopy[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) throw new Error('Approve between one and five exact messages.');
  const copies = value.map(raw => {
    const r = raw as Record<string, unknown>;
    if (!r || ['lead_id', 'email', 'subject', 'body'].some(k => typeof r[k] !== 'string')) throw new Error('Exact lead, recipient, subject and body required.');
    const copy = { lead_id: String(r.lead_id).trim(), email: String(r.email).trim().toLowerCase(), subject: String(r.subject), body: String(r.body) };
    if (!copy.lead_id || copy.lead_id.length > 200 || !isPublicContactEmail(copy.email) || !copy.subject.trim() || /[\r\n]/.test(copy.subject) || copy.subject.length > 200 || !copy.body.trim() || copy.body.length > 12000) throw new Error('Invalid approved message.');
    return copy;
  }).sort((a,b) => a.email < b.email ? -1 : a.email > b.email ? 1 : 0);
  if (new Set(copies.map(c => c.email)).size !== copies.length || new Set(copies.map(c => c.lead_id)).size !== copies.length) throw new Error('Duplicate recipients or leads.');
  return copies;
}
export function approvedBatchDigest(copies: ApprovedCopy[]): string {
  return createHash('sha256').update(JSON.stringify({ version: 1, from: 'hello@bbl.studio', copies: parseApprovedCopies(copies) })).digest('hex');
}
export async function recordApprovedAccepted(copy: ApprovedCopy, id: string, at: string, sentText: string, env: ApprovedBatchEnv) {
  await recordAcceptedSendsBatch([{lead_id:copy.lead_id,email:copy.email,subject:copy.subject,campaign_name:'Exact owner-approved outreach',provider_message_id:id,sent_at:at}],env);
  const [queue,state]=await Promise.all([buildLeadQueue({},env),readMarketingState(env)]);
  if (state.attempts.some(a=>a.providerId===id)) return;
  const lead=[...queue.items,...queue.excluded].find(q=>q.id===copy.lead_id && q.email.toLowerCase()===copy.email);
  state.attempts.push({id:`approved_${id}`,leadId:copy.lead_id,email:copy.email,business:lead?.business_name || copy.email,domain:extractDomain(lead?.website) || copy.email.split('@')[1],website:lead?.website,observation:lead?.website_observation || undefined,step:0,claimedAt:at,subject:copy.subject,body:sentText,status:'SUBMITTED',providerId:id,receipt:'UNKNOWN',checkedAt:null});
  await dbWriteKv(MARKETING_STATE,state,env);
}
function liveDeps(env: ApprovedBatchEnv): BatchDeps {
  return {
    async checks() {
      const [checks,controls,marketing]=await Promise.all([checkMarketingIntegrations(env),readSendControls(env),readMarketingState(env)]);
      return {...checks,send_health_ready:!controls.paused && !controls.cancelled && !shouldAutoPause(controls).pause && !marketing.paused && !marketing.attempts.some(a=>a.status!=='SUBMITTED' || ['BOUNCED','COMPLAINED','FAILED'].includes(a.receipt) || (a.receipt==='UNKNOWN' && Date.now()-Date.parse(a.claimedAt)>86400000))};
    },
    async eligible(copy) {
      if (await isEmailDurablySuppressed(copy.email, env)) return false;
      const controls=await readSendControls(env);
      if (controls.paused || controls.cancelled || shouldAutoPause(controls).pause) return false;
      const [queue, snap, marketing] = await Promise.all([buildLeadQueue({}, env), readSnapshot(env), readMarketingState(env)]);
      if (marketing.paused || marketing.stoppedEmails.includes(copy.email) || marketing.attempts.some(a => a.email === copy.email) || marketing.clients.length >= 5) return false;
      if ((snap?.email_history || []).some(h => !h.dry_run && h.email?.toLowerCase() === copy.email && (h.accepted === 'YES' || ['SENT','DELIVERED','ACCEPTED'].includes(h.status || '')))) return false;
      if ((snap?.inbox || []).some(m => m.from_email?.toLowerCase() === copy.email) || (snap?.bookings || []).some(b => b.email?.toLowerCase() === copy.email)) return false;
      return queue.items.some(q => q.id === copy.lead_id && q.email.toLowerCase() === copy.email && q.contactable && Boolean(q.website_observation) && !['hold','rejected','suppressed','bounced'].includes(q.queue_status));
    },
    send: (copy, text, key) => sendViaResend({ to: copy.email, subject: copy.subject, text, idempotencyKey: key, headers: listUnsubscribeHeaders(buildUnsubscribeUrl(copy.email, copy.lead_id, env)) }, env),
    record: (copy,id,at,text) => recordApprovedAccepted(copy,id,at,text,env),
  };
}

/** Caller requires owner session + same-origin, or the existing server credential.
 * Sending also requires the exact owner-configured Production manifest hash. */
export async function runApprovedOutreachBatch(input: { messages?: unknown; confirm_send?: boolean }, env: ApprovedBatchEnv, injected?: BatchDeps) {
  const copies = parseApprovedCopies(input.messages);
  const digest = approvedBatchDigest(copies);
  if (!isDurableDbConfigured(env)) throw new Error('Durable CRM required.');
  const io = injected || liveDeps(env);
  const lease = await acquireCrmLease(MARKETING_LEASE, env, 300);
  if (!lease) throw new Error('Outreach busy. No email sent.');
  try {
    let batch = await dbReadKv<Batch | null>(batchKey(digest), null, env);
    if (!batch) {
      batch = {digest, from:'hello@bbl.studio', authorization_recorded_at:new Date().toISOString(), authorization_source:'owner-configured-production-manifest', entries:copies.map(c => ({...c, status:'PREPARED'}))};
      await dbWriteKv(batchKey(digest), batch, env);
    }
    // Reconcile a confirmed provider ID after a CRM-write interruption, never retransmit it.
    for (const e of batch.entries.filter(e => e.status === 'ACCEPTED' && !e.crm_recorded)) {
      await io.record(e, e.provider_id!, e.at!, e.sent_text || e.body); e.crm_recorded = true;
      await dbWriteKv(batchKey(digest), batch, env);
    }
    const enabled = env.OWNER_APPROVED_OUTREACH_SHA256 === digest;
    if (!input.confirm_send) return {ok:true, transmitted:0, enabled, batch};
    if (!enabled) throw new Error('This exact manifest is not enabled for production sending.');
    if (env.EMAIL_OUTREACH_ENABLED === 'true' || env.MANUAL_SEND_LIVE_ENABLED === 'true') throw new Error('Other live send paths must remain off for this bounded batch.');
    if (!/^(?:hello@bbl\.studio|[A-Za-z0-9 ._-]{1,80} <hello@bbl\.studio>)$/i.test(String(env.RESEND_FROM || '').trim())) throw new Error('Verified hello@bbl.studio sender required.');
    if (!env.BUSINESS_POSTAL_ADDRESS?.trim() || !env.UNSUBSCRIBE_SECRET || !env.RESEND_API_KEY) throw new Error('Sender, postal address and signed unsubscribe configuration required.');
    const pending = batch.entries.filter(e => e.status === 'PREPARED');
    if (batch.entries.some(e => ['CLAIMED','UNCERTAIN','FAILED'].includes(e.status))) return {ok:false, transmitted:0, blocked:'reconciliation_required', batch};
    if (!pending.length) return {ok:true, transmitted:0, batch};
    const checks = await io.checks();
    if (!checks.provider_and_bbl_identity || !checks.full_inbox_read || !checks.booking_calendar_read || !checks.history_ready || !checks.suppressions_read || !checks.send_health_ready) return {ok:false, transmitted:0, blocked:'integration_preflight', checks, batch};
    if (remainingSends(await readDailyCapState(env)) < pending.length) throw new Error('Daily cap insufficient; no messages transmitted.');
    let transmitted = 0;
    for (const e of pending) {
      if (await dbReadKv<string | null>(recipientKey(e.email), null, env)) { e.status='FAILED'; e.error='Recipient already claimed; reconcile before any retry.'; await dbWriteKv(batchKey(digest),batch,env); continue; }
      if (!await io.eligible(e)) { e.status='FAILED'; e.error='Live suppression, contact history or lead eligibility blocked this recipient.'; await dbWriteKv(batchKey(digest),batch,env); continue; }
      e.status='CLAIMED'; e.at=new Date().toISOString();
      e.sent_text=e.body.trimEnd()+'\n'+complianceFooter({email:e.email,leadId:e.lead_id,env});
      await dbWriteKv(recipientKey(e.email),digest,env);
      await dbWriteKv(batchKey(digest),batch,env);
      // Conservative reservation: an uncertain transmission still consumes cap.
      await recordSuccessfulSend(1,env);
      const text=e.sent_text;
      try {
        if (!injected) await new Promise(resolve=>setTimeout(resolve,650));
        const response=await io.send(e,text,`${digest}:${createHash('sha256').update(e.email).digest('hex')}`);
        if (response.ok && response.id) { e.status='ACCEPTED'; e.provider_id=response.id; transmitted++; }
        else { e.status=response.status && response.status>=400 && response.status<500 ? 'FAILED':'UNCERTAIN'; e.error=response.message; }
      } catch { e.status='UNCERTAIN'; e.error='Provider outcome uncertain. Do not resend automatically.'; }
      await dbWriteKv(batchKey(digest),batch,env);
      if (e.status==='ACCEPTED') { await io.record(e,e.provider_id!,e.at,text); e.crm_recorded=true; await dbWriteKv(batchKey(digest),batch,env); }
      // Stop on any provider failure/unknown result; remaining entries stay untransmitted.
      if (e.status!=='ACCEPTED') break;
    }
    return {ok:batch.entries.every(e=>e.status==='ACCEPTED'),transmitted,batch};
  } finally { await releaseCrmLease(MARKETING_LEASE,lease,env); }
}
