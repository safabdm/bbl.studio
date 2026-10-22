/**
 * Daily 20-Client Outreach prep pipeline (Mon–Fri).
 * Discover/qualify cohort → best 20 for owner approval.
 * Never invents website_observation or prices. Never auto-sends.
 */
import { randomUUID } from 'node:crypto';
import { dbReadKv, dbWriteKv, type CrmDbEnv } from './crm-db.js';
import {
  buildLeadQueue,
  extractDomain,
  type LeadQueueEnv,
  type LeadQueueItem,
} from './lead-queue.js';
import { listStudioDrafts, renderStudioDraft, upsertStudioDraftFromLead } from './email-studio.js';
import { effectiveCap, laDayKey, readDailyCapState, remainingSends, type DailyCapEnv } from './daily-cap.js';
import type { CrmEmailHistoryItem, CrmLead } from './crm-types.js';
import type { DiscoveredLead } from './crm-discovery-types.js';

export const DAILY_20_KV = 'outreach:daily_20_cohort';
export const DAILY_20_TARGET_DISCOVER = 30;
export const DAILY_20_QUALIFY_CAP = 20;

/** Batch 1 SENT 6/6 — hard exclude from daily prep forever. */
export const BATCH_1_BLOCKLIST_EMAILS = [
  'laguna@spadelrio.com',
  'info@biorevivespa.com',
  'info@bodycentredayspa.com',
  'info@immaculatebrows.com',
  'contact@oceannailbar.com',
  'info@lashtasticbyhana.com',
] as const;

/** Competitor / own domains — never cold-email. */
export const COMPETITOR_DOMAINS = [
  'bbl.studio',
  'bbls.studio',
  'sapphirex.com',
  'wix.com',
  'squarespace.com',
  'godaddy.com',
  'shopify.com',
] as const;

/** Priority niches (substring match on category / business name). */
export const PRIORITY_NICHE_RE =
  /\b(med\s*spa|medical\s*spa|beauty|salon|wellness|spa|aesthetic|dermat|clinic|healthcare|health\s*care|dental|plastic|laser|boutique|premium)\b/i;

export type Daily20Env = LeadQueueEnv & DailyCapEnv & CrmDbEnv;

export type Daily20Candidate = LeadQueueItem & {
  preview_subject: string | null;
  preview_body: string | null;
  qualified_for_daily: boolean;
  exclusion_detail: string | null;
  niche_priority: number;
};

export type Daily20Cohort = {
  id: string;
  /** YYYY-MM-DD America/Los_Angeles */
  day_key: string;
  weekday: boolean;
  created_at: string;
  target_discover: number;
  target_qualify: number;
  discovered_count: number;
  qualified: Daily20Candidate[];
  rejected_pool: Array<{ id: string; reason: string; business_name: string; email: string }>;
  message: string;
};

function nowIso(ms = Date.now()): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Mon–Fri in America/Los_Angeles (1=Mon … 5=Fri). */
export function isWeekdayLa(ms = Date.now()): boolean {
  const wd = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'short',
  }).format(new Date(ms));
  return !['Sat', 'Sun'].includes(wd);
}

export function isBatch1Email(email: string): boolean {
  const e = email.trim().toLowerCase();
  return (BATCH_1_BLOCKLIST_EMAILS as readonly string[]).includes(e);
}

export function isCompetitorDomain(emailOrDomain: string | null | undefined): boolean {
  const domain = extractDomain(emailOrDomain) || String(emailOrDomain || '').toLowerCase();
  if (!domain) return false;
  return (COMPETITOR_DOMAINS as readonly string[]).some(
    (c) => domain === c || domain.endsWith(`.${c}`),
  );
}

export function nichePriority(item: Pick<LeadQueueItem, 'category' | 'business_name' | 'location'>): number {
  const hay = `${item.category || ''} ${item.business_name || ''}`;
  let score = 0;
  if (PRIORITY_NICHE_RE.test(hay)) score += 40;
  if (/\bmed\s*spa|medical\s*spa|aesthetic|dermat/i.test(hay)) score += 20;
  if (/\bwellness|spa|salon|beauty/i.test(hay)) score += 10;
  const loc = String(item.location || '').toLowerCase();
  // OC first
  if (
    /irvine|newport|costa mesa|huntington|laguna|anaheim|orange|santa ana|fullerton|tustin|mission viejo|lake forest|yorba/.test(
      loc,
    )
  ) {
    score += 30;
  } else if (/los angeles|santa monica|pasadena|beverly|culver|long beach/.test(loc)) {
    score += 10; // LA expand later — lower than OC
  } else if (/san diego|la jolla/.test(loc)) {
    score += 5;
  }
  return score;
}

export type QualifyOpts = {
  crmLeads?: CrmLead[];
  discovered?: DiscoveredLead[];
  history?: CrmEmailHistoryItem[];
  suppressedEmails?: Set<string>;
  now?: number;
  fixturesOnly?: boolean;
  qualifyCap?: number;
};

/**
 * Build today's review cohort: filter → score → top N qualified.
 * Requires verified website observation + public email + website URL when from discovery.
 */
export async function buildDaily20Cohort(
  opts: QualifyOpts = {},
  env: Daily20Env = process.env,
): Promise<Daily20Cohort> {
  const now = opts.now ?? Date.now();
  const day = laDayKey(now);
  const weekday = isWeekdayLa(now);
  const qualifyCap = opts.qualifyCap ?? DAILY_20_QUALIFY_CAP;

  const built = await buildLeadQueue(
    {
      crmLeads: opts.crmLeads,
      discovered: opts.discovered,
      history: opts.history,
      suppressedEmails: opts.suppressedEmails,
      fixturesOnly: opts.fixturesOnly,
      now,
    },
    env,
  );

  const rejected_pool: Daily20Cohort['rejected_pool'] = [];
  const eligible: Daily20Candidate[] = [];

  const consider = (item: LeadQueueItem, alreadyExcluded?: string) => {
    const email = item.email.trim().toLowerCase();
    let reason = alreadyExcluded || item.excluded_reason;

    if (!reason && !email) reason = 'missing_public_email';
    if (!reason && isBatch1Email(email)) reason = 'batch_1_sent';
    if (!reason && isCompetitorDomain(email)) reason = 'competitor_or_platform';
    if (!reason && !item.website_observation?.trim()) reason = 'missing_website_observation';
    // Prefer having a website URL when discovery-sourced
    if (!reason && item.sources.includes('discovery') && !item.website?.trim()) {
      reason = 'missing_website';
    }
    if (!reason && item.queue_status === 'rejected') reason = 'owner_rejected';
    if (!reason && item.outreach_status === 'bounced') reason = 'bounced';

    if (reason) {
      rejected_pool.push({
        id: item.id,
        reason,
        business_name: item.business_name,
        email,
      });
      return;
    }

    const niche = nichePriority(item);
    eligible.push({
      ...item,
      preview_subject: null,
      preview_body: null,
      qualified_for_daily: true,
      exclusion_detail: null,
      niche_priority: niche,
    });
  };

  for (const item of built.items) consider(item);
  for (const item of built.excluded) consider(item, item.excluded_reason || 'excluded');

  eligible.sort(
    (a, b) =>
      b.niche_priority - a.niche_priority ||
      (b.score_total || 0) - (a.score_total || 0) ||
      a.business_name.localeCompare(b.business_name),
  );

  const qualified = eligible.slice(0, qualifyCap);

  // Attach personalized previews (observation already verified)
  for (const q of qualified) {
    const draft = renderStudioDraft(q, {}, env);
    q.preview_subject = draft.subject;
    q.preview_body = draft.body;
  }

  const discovered_count = built.items.length + built.excluded.length;
  let message: string;
  if (!weekday) {
    message = `Weekend (${day}) — daily prep idle. Cohort still built for review (${qualified.length} qualified).`;
  } else if (qualified.length < qualifyCap) {
    message = `Only ${qualified.length}/${qualifyCap} qualified (need ≥${DAILY_20_TARGET_DISCOVER} discovered with observation+email). Run Discover Leads or sync CRM.`;
  } else if (discovered_count < DAILY_20_TARGET_DISCOVER) {
    message = `Qualified ${qualified.length} but discovered pool is ${discovered_count} (<${DAILY_20_TARGET_DISCOVER}). Expand discovery before send day.`;
  } else {
    message = `Daily cohort ready: ${qualified.length} qualified from ${discovered_count} pooled leads (${day} PT).`;
  }

  const cohort: Daily20Cohort = {
    id: `daily20_${day}`,
    day_key: day,
    weekday,
    created_at: nowIso(now),
    target_discover: DAILY_20_TARGET_DISCOVER,
    target_qualify: qualifyCap,
    discovered_count,
    qualified,
    rejected_pool: rejected_pool.slice(0, 200),
    message,
  };

  await dbWriteKv(DAILY_20_KV, cohort, env);
  return cohort;
}

export async function readDaily20Cohort(env: Daily20Env = process.env): Promise<Daily20Cohort | null> {
  const raw = await dbReadKv<Daily20Cohort | null>(DAILY_20_KV, null, env);
  return raw && raw.id ? raw : null;
}

export async function getDaily20Dashboard(
  env: Daily20Env = process.env,
  opts: QualifyOpts & { refresh?: boolean } = {},
): Promise<{
  cohort: Daily20Cohort;
  daily_cap: { effective_cap: number; remaining: number; sent_today: number; day_key: string };
  drafts_approved: number;
}> {
  const now = opts.now ?? Date.now();
  let cohort = opts.refresh === false ? await readDaily20Cohort(env) : null;
  if (!cohort || cohort.day_key !== laDayKey(now) || opts.refresh !== false) {
    cohort = await buildDaily20Cohort(opts, env);
  }
  const cap = await readDailyCapState(env, now);
  const drafts = await listStudioDrafts(env);
  const draftIds = new Set(cohort.qualified.map((q) => q.id));
  const drafts_approved = drafts.filter((d) => draftIds.has(d.lead_id) && d.approved).length;
  return {
    cohort,
    daily_cap: {
      effective_cap: effectiveCap(cap, now),
      remaining: remainingSends(cap, now),
      sent_today: cap.sent_today,
      day_key: cap.day_key,
    },
    drafts_approved,
  };
}

/** Bulk-approve qualified IDs (after owner review) — creates/approves Email Studio drafts. */
export async function bulkApproveDaily20(
  leadIds: string[],
  env: Daily20Env = process.env,
): Promise<{
  approved: string[];
  blocked: Array<{ lead_id: string; reasons: string[] }>;
}> {
  const cohort = (await readDaily20Cohort(env)) || (await buildDaily20Cohort({ fixturesOnly: true }, env));
  const byId = new Map(cohort.qualified.map((q) => [q.id, q]));
  const approved: string[] = [];
  const blocked: Array<{ lead_id: string; reasons: string[] }> = [];

  for (const id of leadIds.map(String)) {
    const item = byId.get(id);
    if (!item) {
      blocked.push({ lead_id: id, reasons: ['not_in_daily_cohort'] });
      continue;
    }
    const draft = await upsertStudioDraftFromLead(item, { regenerate: true }, env);
    if (draft.blocked_reasons.length || !draft.observation_verified) {
      blocked.push({
        lead_id: id,
        reasons: draft.blocked_reasons.length ? draft.blocked_reasons : ['missing_website_observation'],
      });
      continue;
    }
    // Mark approved in studio
    const { approveStudioDrafts } = await import('./email-studio.js');
    const result = await approveStudioDrafts([id], env);
    if (result.approved.length) approved.push(id);
    else blocked.push({ lead_id: id, reasons: result.blocked[0]?.reasons || ['approve_failed'] });
  }

  return { approved, blocked };
}

/** Test helper — synthetic cohort id */
export function daily20CohortId(dayKey: string): string {
  return `daily20_${dayKey || randomUUID().slice(0, 8)}`;
}
