/** One bounded cloud campaign: first five clients, three pages, $2,000.
 * Durable claims precede transmission. Uncertain attempts are never retried.
 * Each tick sends at most one message; initial + two delivered-only follow-ups.
 */
import { planMarketingReply, type MarketingMessage, type MarketingConversation } from './marketing-conversation.js';
import { createHash, randomUUID } from 'node:crypto';
import { acquireCrmLease, releaseCrmLease, dbReadKv, dbWriteKv } from './crm-db.js';
import { listDiscoveredLeads } from './crm-discovery-store.js';
import type { DiscoveredLead } from './crm-discovery-types.js';
import {readLegacyBaseline,legacyHistoryReady} from './marketing-legacy-baseline.js';
import { buildDaily20Cohort } from './daily-20-pipeline.js';
import { type LeadQueueItem, extractDomain } from './lead-queue.js';
import { readSnapshot } from './crm-sync-store.js';
import { listDurableSuppressions, recordDurableSuppression } from './crm-suppressions.js';
import { importGraphReplies, readGraphTokens, resolveAccessToken } from './graph-sender.js';
import { sendViaResend, type ResendSendEnv } from './resend-send.js';
import { listUnsubscribeHeaders, complianceFooter, buildUnsubscribeUrl } from './outreach-policy.js';
import { getCalendar } from '../api/booking-core.js';
import { businessDaysBetweenLa } from './follow-up-drafts.js';
import { pacificParts } from './pacific-time.js';
import type { SchedulerEnv } from './daily-outreach-scheduler.js';

export type MarketingEnv = SchedulerEnv & ResendSendEnv & {
  MARKETING_AUTOMATION_ENABLED?: string;
  RESEND_READ_API_KEY?: string;
};
export const MARKETING_STATE = 'marketing:first-five:v1';
export const MARKETING_LEASE = 'marketing:send';
type Receipt = 'UNKNOWN' | 'DELIVERED' | 'BOUNCED' | 'COMPLAINED' | 'FAILED';
export type MarketingAttempt = {
  id: string; leadId: string; email: string; business: string; domain: string;
  replyTo?: string; step: number; claimedAt: string; subject: string; body: string;
  status: 'CLAIMED' | 'SUBMITTED' | 'UNCERTAIN';
  providerId: string | null; receipt: Receipt; checkedAt: string | null;
};
export type MarketingState = {
  conversations?: MarketingConversation[];
  paused: boolean;
  attempts: MarketingAttempt[]; stoppedEmails: string[];
  clients: Array<{ email: string; evidence: string; confirmedAt: string }>;
  lastRun: { at: string; status: string; message: string } | null;
};
export async function readMarketingState(env: MarketingEnv): Promise<MarketingState> {
  return dbReadKv(MARKETING_STATE, { paused:false, attempts: [], stoppedEmails: [], clients: [], lastRun: null }, env);
}

export async function updateMarketingControl(env: MarketingEnv, input: { paused?: boolean; client_email?: string; evidence?: string }) {
  const lease=await acquireCrmLease(MARKETING_LEASE,env);
  if (!lease) throw new Error('Campaign busy; retry after the current tick.');
  try {
    const state=await readMarketingState(env);
    if (typeof input.paused === 'boolean') state.paused=input.paused;
    if (input.client_email) {
      if (!input.client_email.includes('@') || !input.evidence?.trim()) throw new Error('Confirmed client email and actual payment/owner evidence required.');
      const email=emailKey(input.client_email);
      if (!state.clients.some(c=>c.email===email)) state.clients.push({email,evidence:input.evidence,confirmedAt:new Date().toISOString()});
    }
    await dbWriteKv(MARKETING_STATE,state,env);return state;
  } finally { await releaseCrmLease(MARKETING_LEASE,lease,env); }
}
const emailKey = (value: string) => value.trim().toLowerCase();
const businessKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
const enabled = (value?: string) => value === 'true';
export function marketingConfigBlockers(env: MarketingEnv): string[] {
  return [
    !enabled(env.MARKETING_AUTOMATION_ENABLED) && 'MARKETING_AUTOMATION_ENABLED',
    env.EMAIL_DRY_RUN !== 'false' && 'EMAIL_DRY_RUN_must_be_false',
    !(env.CRM_DATABASE_URL || env.DATABASE_URL) && env.CRM_DATABASE_MEMORY !== '1' && 'DATABASE_URL',
    !env.RESEND_API_KEY && 'RESEND_API_KEY', !env.UNSUBSCRIBE_SECRET && 'UNSUBSCRIBE_SECRET',
    !env.BUSINESS_POSTAL_ADDRESS && 'BUSINESS_POSTAL_ADDRESS',
    !env.CRON_SECRET && 'CRON_SECRET',
    !env.SESSION_SECRET && 'SESSION_SECRET',
    !(env.MICROSOFT_GRAPH_CLIENT_ID && env.MICROSOFT_GRAPH_CLIENT_SECRET && env.MICROSOFT_GRAPH_TENANT_ID) && 'OUTLOOK_APP_CONFIGURATION',
    !((env as NodeJS.ProcessEnv).GOOGLE_CALENDAR_ID && ((env as NodeJS.ProcessEnv).GOOGLE_REFRESH_TOKEN || (env as NodeJS.ProcessEnv).GOOGLE_PRIVATE_KEY)) && 'GOOGLE_BOOKING_CALENDAR',
    !/hello@bbl\.studio/i.test(env.RESEND_FROM || '') && 'RESEND_FROM_must_be_hello_at_bbl',
  ].filter(Boolean) as string[];
}
export function renderMarketingEmail(item: Pick<LeadQueueItem, 'business_name' | 'contact_name' | 'website_observation'>, step = 0) {
  const name = item.business_name.replace(/[\r\n]/g,' ');
  const observation = String(item.website_observation || '').trim().replace(/\.+$/, '');
  if (!observation || step < 0 || step > 2) throw new Error('Verified observation and supported step required.');
  const intro = step === 0 ? `I noticed ${observation}.` : step === 1
    ? `Following up on the website idea for ${name}.` : `One last note about the website idea for ${name}.`;
  return {
    subject: `${step ? 'Re: ' : ''}A website idea for ${name}`,
    body: [`Hi ${item.contact_name || `${name} team`},`, '', intro, '',
      "I'm Safa from BBL Studio. For my first five clients, I'm offering a three-page informational website for $2,000, with mobile layouts and two revision rounds. Hosting, domain and third-party fees are separate; we'd agree on the scope before starting.", '',
      step === 2 ? "If this isn't a priority, no need to reply; I won't follow up again." : 'Would you like me to email a short outline for your business?', '',
      'Safa', 'Founder, BBL Studio', 'hello@bbl.studio · www.bbl.studio', '', 'This is a business service offer.'].join('\n'),
  };
}

export type MarketingDeps = {
  candidates(): Promise<LeadQueueItem[]>;
  inbox(emails: Set<string>): Promise<{ ok: boolean; replies: string[]; optouts: string[]; messages?: MarketingMessage[] }>;
  bookings(): Promise<string[]>;
  providerReady(): Promise<boolean>;
  receipt(attempt: MarketingAttempt): Promise<Receipt>;
  send(attempt: MarketingAttempt): Promise<{ ok: boolean; id?: string }>;
};
export function hasVerifiedMarketingNeed(lead: DiscoveredLead): boolean {
  return lead.evidence.some(e=>e.signal==='verified_website_need' && /^https:\/\//.test(e.source)
    && e.detail.trim()===lead.weak_website_signals?.[0]?.trim());
}
function liveDeps(env: MarketingEnv): MarketingDeps {
  const readHeaders = { Authorization: `Bearer ${env.RESEND_READ_API_KEY || env.RESEND_API_KEY}` };
  const get = async (path: string) => {
    const res = await fetch(`https://api.resend.com/${path}`, { headers: readHeaders, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error('Resend delivery read unavailable; verify BBL account and read access.');
    return res.json() as Promise<Record<string, unknown>>;
  };
  return {
    async candidates() {
      const [cohort, discovered] = await Promise.all([buildDaily20Cohort({}, env), listDiscoveredLeads({}, env)]);
      // Automatic qualification needs a fresh official-site contact source, not just a CRM note.
      return cohort.qualified.filter(item => discovered.some(d =>
        d.id === item.discovery_id && hasVerifiedMarketingNeed(d) && d.enrichment.email_verified_public &&
        ['website_mailto','website_text'].includes(d.enrichment.email_source) &&
        emailKey(d.public_email || '') === emailKey(item.email) &&
        Date.now() - Date.parse(d.last_verified_at) >= 0 && Date.now() - Date.parse(d.last_verified_at) < 7 * 86400000 &&
        d.evidence.some(e => /^https:\/\//.test(e.source))));
    },
    async inbox(emails) {
      const result = await importGraphReplies({ known_emails: emails }, env);
      if (!result.ok) return { ok: false, replies: [], optouts: [] };
      return { ok: true, replies: result.marked_replied, messages: result.messages,
        optouts: result.items.filter(i => /\b(unsubscribe|remove me|stop emailing|no thanks|not interested)\b/i.test(`${i.subject} ${i.snippet}`)).map(i => i.from_email) };
    },
    async bookings() {
      const calendar = getCalendar(env as NodeJS.ProcessEnv);
      if (!calendar || calendar.mode !== 'google') throw new Error('Live booking calendar unavailable.');
      const events = await calendar.overlapping(new Date(Date.now()-90*86400000), new Date(Date.now()+90*86400000));
      return events.map(e => e.attendeeEmail || '').filter(Boolean);
    },
    async providerReady() {
      const token = await readGraphTokens(env);
      if (!token) return false;
      const access=await resolveAccessToken(env);
      if (!access.ok) return false;
      const me=await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', {headers:{Authorization:`Bearer ${access.token}`},signal:AbortSignal.timeout(5000)});
      if (!me.ok) return false;
      const identity=await me.json() as {mail?:string;userPrincipalName?:string};
      if (emailKey(identity.mail || identity.userPrincipalName || '') !== 'hello@bbl.studio') return false;
      const domains = await get('domains');
      return (domains.data as Array<{ name: string; status: string }> || []).some(d => d.name === 'bbl.studio' && d.status === 'verified');
    },
    async receipt(attempt) {
      if (!attempt.providerId) return 'UNKNOWN';
      const result = await get(`emails/${encodeURIComponent(attempt.providerId)}`);
      const to = Array.isArray(result.to) ? result.to.map(String).map(emailKey) : [];
      if (result.id !== attempt.providerId || !to.includes(attempt.email)) throw new Error('Delivery record does not match recipient/message.');
      switch (result.last_event) {
        case 'delivered': return 'DELIVERED';
        case 'bounced': return 'BOUNCED'; case 'complained': return 'COMPLAINED';
        case 'failed': case 'suppressed': return 'FAILED';
        default: return 'UNKNOWN'; // Open/click pixels are not delivery proof.
      }
    },
    async send(attempt) {
      return sendViaResend({ to: attempt.email, subject: attempt.subject, text: attempt.body,
        headers: listUnsubscribeHeaders(buildUnsubscribeUrl(attempt.email,attempt.leadId,env)),
        idempotencyKey: createHash('sha256').update(attempt.id).digest('hex') }, env);
    },
  };
}

/** Owner-only setup probe. Never calls candidates, receipt or send. */
export async function checkMarketingIntegrations(env: MarketingEnv) {
  const io = liveDeps(env);
  const checks = await Promise.allSettled([
    io.providerReady(), io.inbox(new Set<string>()), io.bookings(), readSnapshot(env), listDurableSuppressions(env),
  ]);
  const [provider, inbox, calendar, history, suppressions] = checks;
  const historyAt = history.status === 'fulfilled' ? history.value?.last_synced_at : null;
  const baseline=await readLegacyBaseline(env);
  return {
    provider_and_bbl_identity: provider.status === 'fulfilled' && provider.value === true,
    full_inbox_read: inbox.status === 'fulfilled' && inbox.value.ok,
    booking_calendar_read: calendar.status === 'fulfilled',
    history_read: history.status === 'fulfilled',
    history_last_synced_at: historyAt || null,
    history_fresh: Boolean(historyAt && Date.now() - Date.parse(historyAt) < 86400000),
    history_ready: legacyHistoryReady(historyAt,baseline),
    retired_legacy_source: Boolean(baseline && baseline.snapshot_synced_at===historyAt),
    suppressions_read: suppressions.status === 'fulfilled',
    transmitted: 0,
  };
}

export async function runMarketingTick(env: MarketingEnv, deps?: MarketingDeps, now = Date.now()) {
  const blockers = marketingConfigBlockers(env);
  if (blockers.length) return { ok: false, status: 'BLOCKED', blockers, transmitted: 0 };
  const lease = await acquireCrmLease(MARKETING_LEASE, env);
  if (!lease) return { ok: true, status: 'BUSY', transmitted: 0 };
  let state: MarketingState | undefined;
  const finish = async (status: string, message: string, transmitted = 0) => {
    if (state) { state.lastRun = { at: new Date(now).toISOString(), status, message }; await dbWriteKv(MARKETING_STATE,state,env); }
    return { ok: status !== 'BLOCKED', status, message, transmitted };
  };
  try {
    state = await readMarketingState(env);
    const io = deps || liveDeps(env);
    // Delivery and replies are checked even after reaching capacity or outside send hours.
    const candidates = await io.candidates();
    const emails = new Set([...candidates.map(c => emailKey(c.email)), ...state.attempts.map(a => a.email)]);
    const inbox = await io.inbox(emails);
    const [bookings, providerReady] = await Promise.all([io.bookings(), io.providerReady()]);
    if (!inbox.ok || !providerReady) return finish('BLOCKED','A fresh complete inbox scan, verified BBL sender and delivery read access are required.');
    for (const email of inbox.optouts) await recordDurableSuppression(email,0,'reply_optout',env);
    state.stoppedEmails = [...new Set([...state.stoppedEmails,...inbox.replies,...bookings].map(emailKey))];
    for (const attempt of state.attempts.filter(a => a.status === 'SUBMITTED')) {
      const receipt = await io.receipt(attempt);
      if (receipt !== 'UNKNOWN') attempt.receipt = receipt;
      attempt.checkedAt = new Date(now).toISOString();
      if (['BOUNCED','COMPLAINED','FAILED'].includes(attempt.receipt)) {
        state.stoppedEmails.push(attempt.email);
        await recordDurableSuppression(attempt.email,0,attempt.receipt.toLowerCase(),env);
      }
    }
    if (state.clients.length >= 5) return finish('COMPLETE','Five confirmed clients; introductory outreach stopped.');
    if (state.paused) return finish('IDLE','Campaign paused by owner.');
    if (state.attempts.some(a => ['BOUNCED','COMPLAINED','FAILED'].includes(a.receipt))) return finish('BLOCKED','Delivery problem requires review; campaign held.');
    if (state.attempts.some(a => a.status !== 'SUBMITTED')) return finish('BLOCKED','An uncertain attempt requires provider reconciliation; never resend automatically.');
    if (state.attempts.some(a=>a.receipt==='UNKNOWN' && now-Date.parse(a.claimedAt)>86400000)) return finish('BLOCKED','Delivery remains unverified after 24 hours; review before further sends.');
    const pt = pacificParts(now);
    if (['Sat','Sun'].includes(pt.weekday) || pt.hour < 9 || pt.hour >= 16) return finish('IDLE','Outside weekday 09:00–16:00 Pacific send window.');
    if (state.attempts.filter(a => pacificParts(Date.parse(a.claimedAt)).dayKey === pt.dayKey).length >= 5) return finish('IDLE','Daily five-message cap reached.');
    const suppressions = new Set((await listDurableSuppressions(env)).map(s => emailKey(s.email)));
    state.conversations ||= [];
    // Respond only to a newer message from the exact contacted address, using complete text.
    // Other addresses on the same business domain stop cold follow-ups but never trigger replies.
    const messages = (inbox.messages || []).filter(m=>!m.automated && !suppressions.has(emailKey(m.email)))
      .sort((a,b)=>Date.parse(b.receivedAt)-Date.parse(a.receivedAt));
    for (const message of messages) {
      const email=emailKey(message.email);
      const original=state.attempts.find(a=>a.email===email && !a.replyTo && a.status==='SUBMITTED');
      if (!original || !Number.isFinite(Date.parse(message.receivedAt)) || Date.parse(message.receivedAt)<=Date.parse(original.claimedAt) || Date.parse(message.receivedAt)>now) continue;
      let conversation=state.conversations.find(c=>c.email===email);
      if (!conversation) {conversation={email,processedIds:[],status:'DISCUSSING'};state.conversations.push(conversation);}
      if (conversation.status==='READY' || conversation.processedIds.includes(message.id)) continue;
      const plan=planMarketingReply(message);
      // Mark all older messages as processed so an old question never follows a newer answer.
      conversation.processedIds.push(...messages.filter(m=>emailKey(m.email)===email && Date.parse(m.receivedAt)<=Date.parse(message.receivedAt)).map(m=>m.id));
      if (!plan) continue;
      if (plan.ready) {
        conversation.status='READY';conversation.evidence=plan.evidence;conversation.receivedAt=message.receivedAt;
        if (!state.clients.some(c=>c.email===email)) state.clients.push({email,evidence:plan.evidence!,confirmedAt:new Date(now).toISOString()});
      }
      const attempt:MarketingAttempt={...original,id:randomUUID(),replyTo:message.id,step:0,claimedAt:new Date(now).toISOString(),subject:`Re: ${original.subject.replace(/^Re: /i,'')}`,body:plan.body+complianceFooter({email,leadId:original.leadId,env}),status:'CLAIMED',providerId:null,receipt:'UNKNOWN',checkedAt:null};
      state.attempts.push(attempt);
      await dbWriteKv(MARKETING_STATE,state,env);
      const sent=await io.send(attempt);
      attempt.status=sent.ok && sent.id?'SUBMITTED':'UNCERTAIN';attempt.providerId=sent.id || null;
      return finish(sent.ok && sent.id?'SUBMITTED':'BLOCKED',plan.ready?'Client explicitly accepted the package and supplied a start brief; owner handoff ready.':'Routine scope reply submitted; waiting for client details and explicit acceptance.',sent.ok && sent.id?1:0);
    }
    const snapshot = await readSnapshot(env);
    if (!deps && !legacyHistoryReady(snapshot?.last_synced_at,await readLegacyBaseline(env),now)) return finish('BLOCKED','Import fresh legacy history or complete the verified old-sender retirement before live marketing.');
    const contacted = new Set([...(snapshot?.email_history || []).filter(h => !h.dry_run && (h.status === 'SENT' || h.accepted === 'YES')).map(h=>emailKey(h.email)), ...(snapshot?.leads || []).filter(l=>l.last_contacted_at || l.email_accepted === 'YES' || l.replied === 'YES' || l.booked === 'YES' || l.suppressed || l.unsubscribed).map(l=>emailKey(l.email))]);
    let chosen: LeadQueueItem | undefined; let step = 0;
    for (const item of candidates) {
      const email = emailKey(item.email);
      if (!item.contactable || state.stoppedEmails.includes(email) || suppressions.has(email)) continue;
      const prior = state.attempts.filter(a => a.email === email).sort((a,b)=>b.step-a.step);
      if (prior.length) {
        const last = prior[0]!;
        const due = last.step === 0 ? 5 : 7;
        if (last.step >= 2 || last.receipt !== 'DELIVERED' || businessDaysBetweenLa(Date.parse(last.claimedAt),now)<due) continue;
        step = last.step+1;
      } else {
        if (contacted.has(email)) continue;
        const site = extractDomain(item.website) || '';
        if (state.attempts.some(a => a.domain && a.domain === site || businessKey(a.business) === businessKey(item.business_name))) continue;
        step = 0;
      }
      chosen = item; break;
    }
    if (!chosen) return finish('IDLE','No fresh qualified recipient or delivered follow-up is due.');
    const copy = renderMarketingEmail(chosen,step);
    const attempt: MarketingAttempt = { id: randomUUID(), leadId: chosen.id, email: emailKey(chosen.email), business: chosen.business_name,
      domain: extractDomain(chosen.website) || '', step, claimedAt: new Date(now).toISOString(), ...copy,
      body: copy.body+complianceFooter({ email: chosen.email,leadId:chosen.id,env }), status:'CLAIMED',providerId:null,receipt:'UNKNOWN',checkedAt:null };
    state.attempts.push(attempt);
    await dbWriteKv(MARKETING_STATE,state,env); // durable claim BEFORE provider call
    const sent = await io.send(attempt);
    if (sent.ok && sent.id) { attempt.status='SUBMITTED'; attempt.providerId=sent.id; }
    else attempt.status='UNCERTAIN';
    return finish(sent.ok && sent.id ? 'SUBMITTED' : 'BLOCKED',sent.ok && sent.id ? 'Provider accepted one message; delivery is UNKNOWN until verified.' : 'Provider outcome uncertain; held for review.',sent.ok && sent.id ? 1 : 0);
  } catch {
    return finish('BLOCKED','A required provider, inbox, calendar or persistence check failed. Inspect service logs; no automatic retry of claimed messages.');
  } finally { await releaseCrmLease(MARKETING_LEASE,lease,env); }
}
