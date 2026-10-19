/**
 * Gated Resend live send for manual CRM campaigns.
 * Never auto-sends. Requires maySendLive + confirm_live + server-side leads.
 * Full tests must mock global fetch — never hit the network in CI.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { CrmLead, CrmEmailHistoryItem, ManualSendRequest, ManualSendResult } from './crm-types.js';
import {
  filterSendableRecipients,
  isDryRun,
  maySendLive,
  validateManualSendGate,
  type SafetyEnv,
} from './crm-safety.js';
import {
  appendComplianceIfNeeded,
  buildUnsubscribeUrl,
  evaluateCopyPolicy,
  filterObservationRequired,
  listUnsubscribeHeaders,
  personalizeLead,
  policyBlocksSend,
  type Exclusion,
  type PolicyEnv,
} from './outreach-policy.js';
import {
  createSignedPreviewToken,
  previewMatchesComposition,
  verifySignedPreviewToken,
  type PreviewTokenEnv,
} from './preview-token.js';
import { isEmailDurablySuppressed, type SuppressionEnv } from './crm-suppressions.js';
import { fetchEmailHistory, fetchLeads } from './crm-lead-client.js';
import {
  isDurableDbConfigured,
  requiresDurableDb,
  type CrmDbEnv,
} from './crm-db.js';
import {
  computeOverviewFromLeads,
  emptySnapshot,
  readSnapshot,
  upsertEmailHistory,
  writeSnapshot,
  type CrmSyncStoreEnv,
} from './crm-sync-store.js';

export const DEFAULT_BATCH_CAP = 10;
export const DEDUPE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type ResendSendEnv = SafetyEnv &
  PolicyEnv &
  PreviewTokenEnv &
  SuppressionEnv &
  CrmDbEnv &
  CrmSyncStoreEnv & {
    RESEND_API_KEY?: string;
    RESEND_FROM?: string;
    MANUAL_SEND_BATCH_CAP?: string;
    BBL_EMAIL?: string;
    EMAIL_MODE?: string;
  };

function batchCap(env: ResendSendEnv): number {
  const raw = Number.parseInt(String(env.MANUAL_SEND_BATCH_CAP || ''), 10);
  if (Number.isFinite(raw) && raw > 0) return Math.min(raw, 100);
  return DEFAULT_BATCH_CAP;
}

function fromAddress(env: ResendSendEnv): string {
  return String(env.RESEND_FROM || 'BBL Studio <hello@bbl.studio>').trim();
}

function nowIso(ms = Date.now()): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Resend Idempotency-Key = sha256(preview_token + email). */
export function resendIdempotencyKey(previewToken: string, email: string): string {
  return createHash('sha256')
    .update(`${previewToken}${String(email || '').trim().toLowerCase()}`)
    .digest('hex');
}

export function wasContactedWithinWindow(
  email: string,
  history: CrmEmailHistoryItem[],
  now = Date.now(),
  windowMs = DEDUPE_WINDOW_MS,
): boolean {
  const needle = email.trim().toLowerCase();
  for (const row of history) {
    if (row.dry_run) continue;
    if (String(row.email || '').trim().toLowerCase() !== needle) continue;
    const status = String(row.status || '').toUpperCase();
    if (status === 'DRY_RUN_SENT') continue;
    if (!['SENT', 'ACCEPTED', 'DELIVERED', 'QUEUED'].includes(status) && row.accepted !== 'YES') {
      // Still treat any non-dry-run history with a sent_at as a contact.
      if (!row.sent_at) continue;
    }
    const sentAt = row.sent_at ? Date.parse(String(row.sent_at)) : NaN;
    if (!Number.isFinite(sentAt)) {
      // Unknown timestamp but live history exists — fail closed.
      return true;
    }
    if (now - sentAt <= windowMs) return true;
  }
  return false;
}

export type AcceptedSendRecord = {
  lead_id: number | string;
  email: string;
  subject: string;
  campaign_name: string;
  provider_message_id: string;
  sent_at: string;
};

/**
 * Persist accepted Resend sends in ONE snapshot write:
 * email_history rows + lead last_contacted_at / provider_message_ids.
 */
export async function recordAcceptedSendsBatch(
  sends: AcceptedSendRecord[],
  env: ResendSendEnv = process.env,
): Promise<void> {
  if (!sends.length) return;
  const snap = (await readSnapshot(env)) || emptySnapshot();
  let history = [...(snap.email_history || [])];
  let leads = [...(snap.leads || [])];

  for (const send of sends) {
    history = upsertEmailHistory(history, {
      id: `resend:${send.provider_message_id}`,
      lead_id: send.lead_id,
      email: send.email,
      subject: send.subject,
      campaign_name: send.campaign_name,
      provider_message_id: send.provider_message_id,
      status: 'SENT',
      dry_run: false,
      accepted: 'YES',
      delivered: 'UNKNOWN',
      bounced: 'UNKNOWN',
      replied: 'UNKNOWN',
      sent_at: send.sent_at,
    });

    leads = leads.map((lead) => {
      if (String(lead.id) !== String(send.lead_id)) return lead;
      const ids = new Set(lead.provider_message_ids || []);
      ids.add(send.provider_message_id);
      return {
        ...lead,
        last_contacted_at: send.sent_at,
        last_activity_at: send.sent_at,
        email_accepted: 'YES' as const,
        email_outreach_status: 'CONTACTED',
        provider_message_ids: [...ids],
      };
    });
  }

  await writeSnapshot(
    {
      ...snap,
      leads,
      email_history: history,
      overview: computeOverviewFromLeads(leads, history),
    },
    env,
  );
}

export type LiveSendOpts = {
  /** Injected for tests — defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** When provided, skip fetchLeads (tests). Production live path ignores client leads. */
  serverLeads?: CrmLead[];
  serverHistory?: CrmEmailHistoryItem[];
  now?: number;
};

async function resolveServerLeads(env: ResendSendEnv, opts?: LiveSendOpts): Promise<CrmLead[]> {
  if (opts?.serverLeads) return opts.serverLeads;
  const remote = await fetchLeads('', env);
  return remote.data || [];
}

async function resolveHistory(env: ResendSendEnv, opts?: LiveSendOpts): Promise<CrmEmailHistoryItem[]> {
  if (opts?.serverHistory) return opts.serverHistory;
  const remote = await fetchEmailHistory(env);
  return remote.data || [];
}

export async function sendViaResend(
  payload: {
    to: string;
    subject: string;
    text: string;
    headers?: Record<string, string>;
    /** When set, sent as Resend request Idempotency-Key. */
    idempotencyKey?: string;
  },
  env: ResendSendEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; id?: string; message: string; status?: number }> {
  const apiKey = String(env.RESEND_API_KEY || '').trim();
  if (!apiKey) {
    return { ok: false, message: 'RESEND_API_KEY is not configured.' };
  }
  const requestHeaders: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (payload.idempotencyKey) {
    requestHeaders['Idempotency-Key'] = payload.idempotencyKey;
  }
  const response = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify({
      from: fromAddress(env),
      to: [payload.to],
      subject: payload.subject,
      text: payload.text,
      headers: payload.headers || {},
    }),
  });
  const status = response.status;
  let data: { id?: string; message?: string } = {};
  try {
    data = (await response.json()) as { id?: string; message?: string };
  } catch {
    data = {};
  }
  if (!response.ok) {
    return {
      ok: false,
      status,
      message: data.message || `Resend HTTP ${status}`,
    };
  }
  return { ok: true, id: data.id, status, message: 'accepted' };
}

/**
 * Manual campaign send with policy, durable suppressions, 30d dedupe, batch cap.
 * Live ESP only when maySendLive; otherwise dry-run log path (caller handles logging).
 */
export async function executeApprovedManualSend(
  request: ManualSendRequest,
  /** Client-supplied leads — used for dry-run preview only. Live path reloads server-side. */
  clientLeads: CrmLead[],
  env: ResendSendEnv = process.env,
  opts?: LiveSendOpts,
): Promise<ManualSendResult & { policy_issues?: ReturnType<typeof evaluateCopyPolicy>; sent_ids?: string[] }> {
  const now = opts?.now ?? Date.now();
  const session = verifySignedPreviewToken(request.preview_token, env, now);
  const gate = validateManualSendGate({
    recipient_ids: request.recipient_ids,
    preview_token: request.preview_token,
    expected_preview_token: session ? request.preview_token : undefined,
    confirmed: request.confirmed,
  });

  const policyIssues = evaluateCopyPolicy(request.subject, request.body, env);
  if (policyBlocksSend(policyIssues)) {
    return {
      ok: false,
      dry_run: true,
      live: false,
      campaign_id: '',
      recipient_count: 0,
      excluded_count: 0,
      excluded: [],
      intended: [],
      message: policyIssues.find((i) => i.severity === 'block')?.message || 'Copy fails outreach policy.',
      policy_issues: policyIssues,
    };
  }

  if (!gate.ok) {
    return {
      ok: false,
      dry_run: true,
      live: false,
      campaign_id: '',
      recipient_count: 0,
      excluded_count: 0,
      excluded: [],
      intended: [],
      message: gate.message,
      policy_issues: policyIssues,
    };
  }

  if (!session || !previewMatchesComposition(session, request.recipient_ids, request.subject, request.body)) {
    return {
      ok: false,
      dry_run: true,
      live: false,
      campaign_id: '',
      recipient_count: 0,
      excluded_count: 0,
      excluded: [],
      intended: [],
      message: 'Preview is out of date. Preview again after changing recipients or copy.',
      policy_issues: policyIssues,
    };
  }

  const live = maySendLive({ confirm_live: request.confirm_live }, env);
  const leads = live ? await resolveServerLeads(env, opts) : clientLeads.length ? clientLeads : await resolveServerLeads(env, opts);
  const history = await resolveHistory(env, opts);

  const { included: withObs, excluded: obsExcluded } = filterObservationRequired(leads, request.recipient_ids);
  const { included, excluded: safetyExcluded } = filterSendableRecipients(withObs, request.recipient_ids);

  const excluded: Exclusion[] = [
    ...obsExcluded,
    ...safetyExcluded.map((row) => ({ id: row.id, reason: row.reason })),
  ];
  const afterDedupe: CrmLead[] = [];
  for (const lead of included as CrmLead[]) {
    const email = String(lead.email || '');
    if (await isEmailDurablySuppressed(email, env)) {
      excluded.push({ id: lead.id, reason: 'suppressed', email });
      continue;
    }
    if (wasContactedWithinWindow(email, history, now)) {
      excluded.push({ id: lead.id, reason: 'contacted_within_30d', email });
      continue;
    }
    afterDedupe.push(lead);
  }

  const cap = batchCap(env);
  let batch = afterDedupe;
  if (batch.length > cap) {
    const overflow = batch.slice(cap);
    batch = batch.slice(0, cap);
    for (const lead of overflow) {
      excluded.push({ id: lead.id, reason: 'batch_cap', email: String(lead.email || '') });
    }
  }

  const intended = batch.map((lead) => ({
    id: lead.id,
    email: String(lead.email),
    subject: personalizeLead(request.subject, lead, env),
  }));
  const campaignId = `camp_${randomBytes(8).toString('hex')}`;

  if (!live) {
    return {
      ok: true,
      dry_run: true,
      live: false,
      campaign_id: campaignId,
      recipient_count: intended.length,
      excluded_count: excluded.length,
      excluded,
      intended,
      message: isDryRun(env)
        ? `Dry-run only: ${intended.length} recipient(s) prepared. No emails were sent.`
        : `Manual live send is disabled (MANUAL_SEND_LIVE_ENABLED≠true or confirm_live off). ${intended.length} recipient(s) logged as dry-run.`,
      policy_issues: policyIssues,
    };
  }

  if (requiresDurableDb(env) && !isDurableDbConfigured(env)) {
    return {
      ok: false,
      dry_run: false,
      live: false,
      campaign_id: campaignId,
      recipient_count: 0,
      excluded_count: excluded.length,
      excluded,
      intended,
      message: 'durable suppressions unavailable',
      policy_issues: policyIssues,
    };
  }

  if (!String(env.RESEND_API_KEY || '').trim()) {
    return {
      ok: false,
      dry_run: false,
      live: false,
      campaign_id: campaignId,
      recipient_count: intended.length,
      excluded_count: excluded.length,
      excluded,
      intended,
      message: 'Live send flagged but RESEND_API_KEY is missing. Aborting without sending.',
      policy_issues: policyIssues,
    };
  }

  const fetchImpl = opts?.fetchImpl || fetch;
  const sentIds: string[] = [];
  const acceptedSends: AcceptedSendRecord[] = [];
  const failures: string[] = [];
  const sentAt = nowIso(now);

  for (const lead of batch) {
    const email = String(lead.email);
    const unsub = buildUnsubscribeUrl(email, lead.id, env);
    const subject = personalizeLead(request.subject, lead, env);
    let body = personalizeLead(request.body, lead, env);
    body = appendComplianceIfNeeded(body, lead, env);
    const headers = listUnsubscribeHeaders(unsub);
    const result = await sendViaResend(
      {
        to: email,
        subject,
        text: body,
        headers,
        idempotencyKey: resendIdempotencyKey(request.preview_token, email),
      },
      env,
      fetchImpl,
    );
    if (result.ok && result.id) {
      sentIds.push(result.id);
      acceptedSends.push({
        lead_id: lead.id,
        email,
        subject,
        campaign_name: request.campaign_name,
        provider_message_id: result.id,
        sent_at: sentAt,
      });
    } else {
      failures.push(`${lead.email}: ${result.message}`);
      excluded.push({ id: lead.id, reason: 'send_failed', email: String(lead.email || '') });
    }
  }

  if (acceptedSends.length) {
    await recordAcceptedSendsBatch(acceptedSends, env);
  }

  const ok = sentIds.length > 0;
  return {
    ok,
    dry_run: false,
    live: true,
    campaign_id: campaignId,
    recipient_count: sentIds.length,
    excluded_count: excluded.length,
    excluded,
    intended,
    sent_ids: sentIds,
    message: ok
      ? `Live send: ${sentIds.length} accepted by Resend.${failures.length ? ` Failures: ${failures.length}.` : ''}`
      : `Live send failed for all recipients. ${failures[0] || ''}`.trim(),
    policy_issues: policyIssues,
  };
}

/** Re-export for callers that create tokens at preview time. */
export { createSignedPreviewToken };
