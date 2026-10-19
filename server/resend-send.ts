/**
 * Gated Resend live send for manual CRM campaigns.
 * Never auto-sends. Requires maySendLive + confirm_live + server-side leads.
 * Full tests must mock global fetch — never hit the network in CI.
 */
import { randomBytes } from 'node:crypto';
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
import type { CrmDbEnv } from './crm-db.js';

export const DEFAULT_BATCH_CAP = 10;
export const DEDUPE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type ResendSendEnv = SafetyEnv &
  PolicyEnv &
  PreviewTokenEnv &
  SuppressionEnv &
  CrmDbEnv & {
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
      if (!row.sent_at && row.accepted !== 'YES') continue;
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
  },
  env: ResendSendEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; id?: string; message: string; status?: number }> {
  const apiKey = String(env.RESEND_API_KEY || '').trim();
  if (!apiKey) {
    return { ok: false, message: 'RESEND_API_KEY is not configured.' };
  }
  const response = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
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

  const excluded = [...obsExcluded, ...safetyExcluded];
  const afterDedupe: CrmLead[] = [];
  for (const lead of included as CrmLead[]) {
    const email = String(lead.email || '');
    if (await isEmailDurablySuppressed(email, env)) {
      excluded.push({ id: lead.id, reason: 'suppressed' });
      continue;
    }
    if (wasContactedWithinWindow(email, history, now)) {
      excluded.push({ id: lead.id, reason: 'contacted_within_30d' });
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
      excluded.push({ id: lead.id, reason: 'batch_cap', email: lead.email });
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
  const failures: string[] = [];

  for (const lead of batch) {
    const unsub = buildUnsubscribeUrl(String(lead.email), lead.id, env);
    const subject = personalizeLead(request.subject, lead, env);
    let body = personalizeLead(request.body, lead, env);
    body = appendComplianceIfNeeded(body, lead, env);
    const headers = listUnsubscribeHeaders(unsub);
    const result = await sendViaResend(
      { to: String(lead.email), subject, text: body, headers },
      env,
      fetchImpl,
    );
    if (result.ok && result.id) {
      sentIds.push(result.id);
    } else {
      failures.push(`${lead.email}: ${result.message}`);
      excluded.push({ id: lead.id, reason: 'send_failed', email: lead.email });
    }
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
