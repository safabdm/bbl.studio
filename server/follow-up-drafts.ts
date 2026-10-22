/**
 * Follow-up draft generator — 3–5 business days after send.
 * Drafts only; never auto-sends. Interested replies → notify flag for owner.
 */
import { dbReadKv, dbWriteKv, type CrmDbEnv } from './crm-db.js';
import {
  BOOKING_CTA_URL,
  CONSULT_MINUTES,
  appendComplianceIfNeeded,
  personalizeLead,
  type PolicyEnv,
} from './outreach-policy.js';
import { OWNER_SIGNATURE } from './email-studio.js';
import { laDayKey } from './daily-cap.js';
import type { CrmEmailHistoryItem, CrmInboxItem, CrmLead } from './crm-types.js';

export const FOLLOWUP_DRAFTS_KV = 'outreach:followup_drafts';
export const INTERESTED_NOTIFY_KV = 'outreach:interested_notify';

export const FOLLOWUP_MIN_BIZ_DAYS = 3;
export const FOLLOWUP_MAX_BIZ_DAYS = 5;

export type FollowUpDraft = {
  id: string;
  lead_id: string;
  email: string;
  business_name: string;
  subject: string;
  body: string;
  based_on_sent_at: string;
  eligible_on: string;
  status: 'draft' | 'approved' | 'dismissed';
  created_at: string;
};

export type InterestedNotify = {
  id: string;
  from_email: string;
  lead_id: string | null;
  subject: string | null;
  snippet: string | null;
  received_at: string | null;
  notified_at: string;
  acknowledged: boolean;
};

function nowIso(ms = Date.now()): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Add N business days in America/Los_Angeles calendar (skip Sat/Sun). */
export function addBusinessDaysLa(fromMs: number, bizDays: number): number {
  let remaining = Math.max(0, bizDays);
  let cursor = fromMs;
  const oneDay = 24 * 60 * 60 * 1000;
  while (remaining > 0) {
    cursor += oneDay;
    const wd = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      weekday: 'short',
    }).format(new Date(cursor));
    if (wd !== 'Sat' && wd !== 'Sun') remaining -= 1;
  }
  return cursor;
}

export function businessDaysBetweenLa(fromMs: number, toMs: number): number {
  if (toMs <= fromMs) return 0;
  let count = 0;
  let cursor = fromMs;
  const oneDay = 24 * 60 * 60 * 1000;
  while (cursor + oneDay <= toMs) {
    cursor += oneDay;
    const wd = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      weekday: 'short',
    }).format(new Date(cursor));
    if (wd !== 'Sat' && wd !== 'Sun') count += 1;
  }
  return count;
}

const FOLLOWUP_TEMPLATE = {
  subject: 'Re: A quick idea for {{business_name}}',
  body: [
    'Hi {{contact_name}},',
    '',
    'Quick follow-up in case my last note got buried.',
    '',
    `If helpful, I can still walk through a complimentary ${CONSULT_MINUTES}-minute website review for {{business_name}} — including the note that {{website_observation}}.`,
    '',
    `Book here: ${BOOKING_CTA_URL}`,
    '',
    OWNER_SIGNATURE,
    '',
    '{{BUSINESS_POSTAL_ADDRESS}}',
    '',
    'Prefer not to receive these emails? Unsubscribe:',
    '{{signed_unsubscribe_url}}',
  ].join('\n'),
};

export type FollowUpEnv = CrmDbEnv & PolicyEnv;

export function buildFollowUpDraftForLead(
  lead: Partial<CrmLead> & { id: string | number; email: string; business_name: string },
  sentAt: string,
  env: FollowUpEnv = process.env,
  nowMs = Date.now(),
): FollowUpDraft | null {
  const observation = String(lead.website_observation || lead.outreach_observation || '').trim();
  if (!observation) return null;
  const sentMs = Date.parse(sentAt);
  if (!Number.isFinite(sentMs)) return null;
  const biz = businessDaysBetweenLa(sentMs, nowMs);
  if (biz < FOLLOWUP_MIN_BIZ_DAYS) return null;

  const crm: CrmLead = {
    id: lead.id,
    business_name: lead.business_name,
    contact_name: lead.contact_name,
    email: lead.email,
    website_observation: observation,
    email_accepted: 'UNKNOWN',
    delivered: 'UNKNOWN',
    bounced: 'UNKNOWN',
    replied: 'UNKNOWN',
    booked: 'NO',
  };
  let subject = personalizeLead(FOLLOWUP_TEMPLATE.subject, crm, env);
  let body = personalizeLead(FOLLOWUP_TEMPLATE.body, crm, env);
  body = appendComplianceIfNeeded(body, crm, env);

  const eligibleMs = addBusinessDaysLa(sentMs, FOLLOWUP_MIN_BIZ_DAYS);
  return {
    id: `fu_${lead.id}_${laDayKey(sentMs)}`,
    lead_id: String(lead.id),
    email: lead.email.toLowerCase(),
    business_name: lead.business_name,
    subject,
    body,
    based_on_sent_at: sentAt,
    eligible_on: nowIso(eligibleMs),
    status: 'draft',
    created_at: nowIso(nowMs),
  };
}

/**
 * From email history + leads: create follow-up drafts for nonresponders
 * at 3–5 business days. Skips replied / bounced / dry-run.
 */
export async function generateFollowUpDrafts(
  opts: {
    history: CrmEmailHistoryItem[];
    leads: CrmLead[];
    repliedEmails?: Set<string>;
    nowMs?: number;
  },
  env: FollowUpEnv = process.env,
): Promise<FollowUpDraft[]> {
  const nowMs = opts.nowMs ?? Date.now();
  const byEmail = new Map(
    opts.leads.map((l) => [String(l.email || '').toLowerCase(), l] as const),
  );
  const replied = opts.repliedEmails || new Set(
    opts.leads.filter((l) => l.replied === 'YES').map((l) => String(l.email).toLowerCase()),
  );

  const existing = await listFollowUpDrafts(env);
  const existingKeys = new Set(existing.map((d) => d.id));
  const created: FollowUpDraft[] = [];

  for (const row of opts.history) {
    if (row.dry_run) continue;
    const email = String(row.email || '')
      .trim()
      .toLowerCase();
    if (!email || replied.has(email)) continue;
    if (row.bounced === 'YES') continue;
    if (row.replied === 'YES') continue;
    const status = String(row.status || '').toUpperCase();
    if (!['SENT', 'ACCEPTED', 'DELIVERED', 'QUEUED', 'SUBMITTED'].includes(status) && row.accepted !== 'YES') {
      continue;
    }
    const sentAt = row.sent_at;
    if (!sentAt) continue;
    const sentMs = Date.parse(sentAt);
    if (!Number.isFinite(sentMs)) continue;
    const biz = businessDaysBetweenLa(sentMs, nowMs);
    if (biz < FOLLOWUP_MIN_BIZ_DAYS || biz > FOLLOWUP_MAX_BIZ_DAYS + 2) continue;

    const lead = byEmail.get(email) || {
      id: row.lead_id || email,
      business_name: row.business_name || email,
      email,
      website_observation: '',
      email_accepted: 'UNKNOWN' as const,
      delivered: 'UNKNOWN' as const,
      bounced: 'UNKNOWN' as const,
      replied: 'UNKNOWN' as const,
      booked: 'NO' as const,
    };
    if (!lead.website_observation && !lead.outreach_observation) continue;

    const draft = buildFollowUpDraftForLead(lead, sentAt, env, nowMs);
    if (!draft || existingKeys.has(draft.id)) continue;
    created.push(draft);
    existingKeys.add(draft.id);
  }

  if (created.length) {
    await dbWriteKv(FOLLOWUP_DRAFTS_KV, [...created, ...existing].slice(0, 300), env);
  }
  return created;
}

export async function listFollowUpDrafts(env: FollowUpEnv = process.env): Promise<FollowUpDraft[]> {
  const raw = await dbReadKv<FollowUpDraft[]>(FOLLOWUP_DRAFTS_KV, [], env);
  return Array.isArray(raw) ? raw : [];
}

const INTERESTED_RE = /\b(interested|love to|let'?s (?:chat|talk|book)|schedule|sounds good|tell me more)\b/i;

export function looksInterested(subject: string | null | undefined, snippet: string | null | undefined): boolean {
  return INTERESTED_RE.test(`${subject || ''} ${snippet || ''}`);
}

/** Flag interested replies for owner notify — never auto-responds. */
export async function recordInterestedFromInbox(
  items: CrmInboxItem[],
  env: FollowUpEnv = process.env,
): Promise<InterestedNotify[]> {
  const prev = await dbReadKv<InterestedNotify[]>(INTERESTED_NOTIFY_KV, [], env);
  const existing = new Set((Array.isArray(prev) ? prev : []).map((n) => n.id));
  const added: InterestedNotify[] = [];
  for (const item of items) {
    if (!looksInterested(item.subject, item.snippet)) continue;
    if (existing.has(item.id)) continue;
    const row: InterestedNotify = {
      id: item.id,
      from_email: item.from_email,
      lead_id: item.lead_id != null ? String(item.lead_id) : null,
      subject: item.subject || null,
      snippet: item.snippet || null,
      received_at: item.received_at || null,
      notified_at: nowIso(),
      acknowledged: false,
    };
    added.push(row);
  }
  if (added.length) {
    await dbWriteKv(INTERESTED_NOTIFY_KV, [...added, ...(Array.isArray(prev) ? prev : [])].slice(0, 200), env);
  }
  return added;
}

export async function listInterestedNotify(env: FollowUpEnv = process.env): Promise<InterestedNotify[]> {
  const raw = await dbReadKv<InterestedNotify[]>(INTERESTED_NOTIFY_KV, [], env);
  return Array.isArray(raw) ? raw : [];
}
