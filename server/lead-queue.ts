/**
 * One Lead Queue — bridge Neon discovered leads + Mac CRM snapshot.
 * Dedupe by domain + email + place_id. Exclude suppressed / unsubscribed /
 * contacted in last 30d. Persist queue actions + audit in Neon crm_kv.
 */
import { randomUUID } from 'node:crypto';
import { dbReadKv, dbWriteKv, type CrmDbEnv } from './crm-db.js';
import { listDiscoveredLeads } from './crm-discovery-store.js';
import type { DiscoveredLead } from './crm-discovery-types.js';
import { listDurableSuppressions, type SuppressionEnv } from './crm-suppressions.js';
import { DEDUPE_WINDOW_MS, wasContactedWithinWindow } from './resend-send.js';
import { readSnapshot, type CrmSyncStoreEnv } from './crm-sync-store.js';
import type { CrmEmailHistoryItem, CrmLead } from './crm-types.js';
import { normalizeOutreachStatus, type OutreachStatus } from './outreach-status.js';

export const LEAD_QUEUE_KV = 'outreach:lead_queue_state';
export const LEAD_QUEUE_AUDIT_KV = 'outreach:lead_queue_audit';

export type LeadQueueAction = 'approve' | 'reject' | 'save_for_later' | 'draft_email';

export type LeadQueueRecordStatus =
  | 'new'
  | 'approved'
  | 'rejected'
  | 'saved'
  | 'drafted'
  | 'excluded';

export type LeadQueueSource = 'crm_snapshot' | 'discovery' | 'merged';

export type LeadQueueItem = {
  id: string;
  sources: LeadQueueSource[];
  business_name: string;
  contact_name: string | null;
  email: string;
  domain: string | null;
  place_id: string | null;
  location: string | null;
  category: string | null;
  website: string | null;
  website_observation: string | null;
  score_total: number | null;
  scores: DiscoveredLead['scores'] | null;
  evidence: DiscoveredLead['evidence'];
  crm_lead_id: number | string | null;
  discovery_id: string | null;
  queue_status: LeadQueueRecordStatus;
  outreach_status: OutreachStatus;
  reject_reason: string | null;
  contactable: boolean;
  excluded_reason: string | null;
  last_contacted_at: string | null;
  updated_at: string;
};

export type LeadQueuePersisted = {
  by_id: Record<
    string,
    {
      queue_status: LeadQueueRecordStatus;
      reject_reason: string | null;
      outreach_status?: OutreachStatus;
      updated_at: string;
    }
  >;
};

export type LeadQueueAuditEntry = {
  id: string;
  lead_id: string;
  action: LeadQueueAction | 'status_set';
  reason: string | null;
  at: string;
  actor: 'owner' | 'system';
};

export type LeadQueueEnv = CrmDbEnv & SuppressionEnv & CrmSyncStoreEnv;

function nowIso(ms = Date.now()): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function extractDomain(emailOrUrl: string | null | undefined): string | null {
  const raw = String(emailOrUrl || '')
    .trim()
    .toLowerCase();
  if (!raw) return null;
  if (raw.includes('@')) {
    const host = raw.split('@')[1] || '';
    return host.replace(/^www\./, '') || null;
  }
  try {
    const withProto = raw.startsWith('http') ? raw : `https://${raw}`;
    const host = new URL(withProto).hostname.replace(/^www\./, '');
    return host || null;
  } catch {
    return null;
  }
}

export function queueItemId(parts: {
  email?: string | null;
  domain?: string | null;
  place_id?: string | null;
  business_name?: string | null;
}): string {
  const email = String(parts.email || '')
    .trim()
    .toLowerCase();
  const place = String(parts.place_id || '')
    .trim()
    .toLowerCase();
  const domain = String(parts.domain || extractDomain(email) || '')
    .trim()
    .toLowerCase();
  if (place) return `place:${place}`;
  if (email) return `email:${email}`;
  if (domain) return `domain:${domain}`;
  const name = String(parts.business_name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
  return `name:${name || randomUUID()}`;
}

function emptyPersisted(): LeadQueuePersisted {
  return { by_id: {} };
}

export async function readLeadQueueState(env: LeadQueueEnv = process.env): Promise<LeadQueuePersisted> {
  const raw = await dbReadKv<LeadQueuePersisted>(LEAD_QUEUE_KV, emptyPersisted(), env);
  return raw && typeof raw === 'object' && raw.by_id ? raw : emptyPersisted();
}

export async function writeLeadQueueState(
  state: LeadQueuePersisted,
  env: LeadQueueEnv = process.env,
): Promise<void> {
  await dbWriteKv(LEAD_QUEUE_KV, state, env);
}

export async function readLeadQueueAudit(
  env: LeadQueueEnv = process.env,
): Promise<LeadQueueAuditEntry[]> {
  const raw = await dbReadKv<LeadQueueAuditEntry[]>(LEAD_QUEUE_AUDIT_KV, [], env);
  return Array.isArray(raw) ? raw : [];
}

async function appendAudit(
  entry: Omit<LeadQueueAuditEntry, 'id' | 'at'> & { at?: string },
  env: LeadQueueEnv,
): Promise<LeadQueueAuditEntry> {
  const full: LeadQueueAuditEntry = {
    id: randomUUID(),
    at: entry.at || nowIso(),
    lead_id: entry.lead_id,
    action: entry.action,
    reason: entry.reason,
    actor: entry.actor,
  };
  const prev = await readLeadQueueAudit(env);
  const next = [full, ...prev].slice(0, 500);
  await dbWriteKv(LEAD_QUEUE_AUDIT_KV, next, env);
  return full;
}

function crmToPartial(lead: CrmLead): Omit<LeadQueueItem, 'queue_status' | 'reject_reason' | 'updated_at'> {
  const email = String(lead.email || '')
    .trim()
    .toLowerCase();
  const domain = extractDomain(email);
  const observation = String(lead.website_observation || lead.outreach_observation || '').trim() || null;
  return {
    id: queueItemId({ email, domain, business_name: lead.business_name }),
    sources: ['crm_snapshot'],
    business_name: lead.business_name || 'Unknown business',
    contact_name: lead.contact_name || null,
    email,
    domain,
    place_id: null,
    location: lead.location || null,
    category: lead.category || null,
    website: null,
    website_observation: observation,
    score_total: null,
    scores: null,
    evidence: [],
    crm_lead_id: lead.id,
    discovery_id: null,
    outreach_status: normalizeOutreachStatus(
      lead.email_outreach_status || (lead.replied === 'YES' ? 'replied' : lead.bounced === 'YES' ? 'bounced' : lead.delivered === 'YES' ? 'delivered' : lead.email_accepted === 'YES' ? 'submitted' : 'unknown'),
    ),
    contactable: Boolean(email && lead.contactable !== false && lead.email_status !== 'NOT CONTACTABLE'),
    excluded_reason: null,
    last_contacted_at: lead.last_contacted_at || null,
  };
}

function discoveryToPartial(
  lead: DiscoveredLead,
): Omit<LeadQueueItem, 'queue_status' | 'reject_reason' | 'updated_at'> {
  const email = String(lead.public_email || '')
    .trim()
    .toLowerCase();
  const domain = extractDomain(email) || extractDomain(lead.website);
  const observation =
    lead.weak_website_signals?.[0] ||
    lead.problems?.[0] ||
    lead.fit_summary ||
    null;
  return {
    id: queueItemId({ email, domain, place_id: lead.place_id, business_name: lead.business_name }),
    sources: ['discovery'],
    business_name: lead.business_name,
    contact_name: null,
    email,
    domain,
    place_id: lead.place_id,
    location: lead.city,
    category: lead.category,
    website: lead.website,
    website_observation: observation ? String(observation).replace(/\.+$/, '') : null,
    score_total: lead.score_total,
    scores: lead.scores,
    evidence: lead.evidence || [],
    crm_lead_id: null,
    discovery_id: lead.id,
    outreach_status: 'unknown',
    contactable: Boolean(email),
    excluded_reason: null,
    last_contacted_at: null,
  };
}

function mergeItems(
  a: Omit<LeadQueueItem, 'queue_status' | 'reject_reason' | 'updated_at'>,
  b: Omit<LeadQueueItem, 'queue_status' | 'reject_reason' | 'updated_at'>,
): Omit<LeadQueueItem, 'queue_status' | 'reject_reason' | 'updated_at'> {
  const sources = [...new Set([...a.sources, ...b.sources, 'merged' as LeadQueueSource])] as LeadQueueSource[];
  return {
    ...a,
    ...b,
    sources: sources.includes('crm_snapshot') && sources.includes('discovery')
      ? (['crm_snapshot', 'discovery', 'merged'] as LeadQueueSource[])
      : [...new Set([...a.sources, ...b.sources])],
    business_name: a.business_name || b.business_name,
    contact_name: a.contact_name || b.contact_name,
    email: a.email || b.email,
    domain: a.domain || b.domain,
    place_id: a.place_id || b.place_id,
    location: a.location || b.location,
    category: a.category || b.category,
    website: a.website || b.website,
    website_observation: a.website_observation || b.website_observation,
    score_total: a.score_total ?? b.score_total,
    scores: a.scores || b.scores,
    evidence: a.evidence?.length ? a.evidence : b.evidence,
    crm_lead_id: a.crm_lead_id ?? b.crm_lead_id,
    discovery_id: a.discovery_id || b.discovery_id,
    outreach_status: a.outreach_status !== 'unknown' ? a.outreach_status : b.outreach_status,
    contactable: a.contactable || b.contactable,
    last_contacted_at: a.last_contacted_at || b.last_contacted_at,
    id: a.place_id || b.place_id
      ? queueItemId({ place_id: a.place_id || b.place_id })
      : a.email || b.email
        ? queueItemId({ email: a.email || b.email })
        : a.id,
  };
}

export type BuildLeadQueueOpts = {
  crmLeads?: CrmLead[];
  discovered?: DiscoveredLead[];
  history?: CrmEmailHistoryItem[];
  suppressedEmails?: Set<string>;
  persisted?: LeadQueuePersisted;
  now?: number;
  /** When true, skip live Neon reads and use only provided fixtures. */
  fixturesOnly?: boolean;
};

/**
 * Build unified queue. Prefer caller-provided fixtures for tests/CI.
 * Live path reads snapshot + discovered + suppressions + history.
 */
export async function buildLeadQueue(
  opts: BuildLeadQueueOpts = {},
  env: LeadQueueEnv = process.env,
): Promise<{ items: LeadQueueItem[]; excluded: LeadQueueItem[]; message: string }> {
  let crmLeads = opts.crmLeads;
  let discovered = opts.discovered;
  let history = opts.history;
  let suppressed = opts.suppressedEmails;
  const persisted = opts.persisted || (opts.fixturesOnly ? emptyPersisted() : await readLeadQueueState(env));
  const now = opts.now ?? Date.now();

  if (!opts.fixturesOnly) {
    if (!crmLeads || !history) {
      const snap = await readSnapshot(env);
      crmLeads = crmLeads || snap?.leads || [];
      history = history || snap?.email_history || [];
    }
    if (!discovered) {
      discovered = await listDiscoveredLeads({ limit: 500 }, env);
    }
    if (!suppressed) {
      const rows = await listDurableSuppressions(env);
      suppressed = new Set(rows.map((r) => r.email.toLowerCase()));
    }
  }

  crmLeads = crmLeads || [];
  discovered = discovered || [];
  history = history || [];
  suppressed = suppressed || new Set();

  const map = new Map<string, Omit<LeadQueueItem, 'queue_status' | 'reject_reason' | 'updated_at'>>();

  for (const lead of crmLeads) {
    const partial = crmToPartial(lead);
    const existing = map.get(partial.id);
    map.set(partial.id, existing ? mergeItems(existing, partial) : partial);
  }

  for (const lead of discovered) {
    // Also try match by email/domain against existing keys
    const partial = discoveryToPartial(lead);
    let key = partial.id;
    if (!map.has(key) && partial.email) {
      const byEmail = queueItemId({ email: partial.email });
      if (map.has(byEmail)) key = byEmail;
    }
    if (!map.has(key) && partial.domain) {
      for (const [k, v] of map) {
        if (v.domain && v.domain === partial.domain) {
          key = k;
          break;
        }
      }
    }
    const existing = map.get(key);
    const merged = existing ? mergeItems(existing, { ...partial, id: key }) : { ...partial, id: key };
    map.set(key, merged);
  }

  const items: LeadQueueItem[] = [];
  const excluded: LeadQueueItem[] = [];

  for (const partial of map.values()) {
    const saved = persisted.by_id[partial.id];
    let excludedReason: string | null = null;
    const email = partial.email;

    if (email && suppressed.has(email)) excludedReason = 'suppressed';
    else if (email && wasContactedWithinWindow(email, history, now, DEDUPE_WINDOW_MS)) {
      excludedReason = 'contacted_last_30d';
    }

    // Check CRM lead flags
    const crm = crmLeads.find((l) => String(l.id) === String(partial.crm_lead_id));
    if (!excludedReason && crm?.unsubscribed) excludedReason = 'unsubscribed';
    if (!excludedReason && crm?.suppressed) excludedReason = 'suppressed';

    const queueStatus: LeadQueueRecordStatus = excludedReason
      ? 'excluded'
      : saved?.queue_status || 'new';

    const item: LeadQueueItem = {
      ...partial,
      queue_status: queueStatus,
      reject_reason: saved?.reject_reason || null,
      outreach_status: saved?.outreach_status || partial.outreach_status,
      excluded_reason: excludedReason,
      updated_at: saved?.updated_at || nowIso(now),
    };

    if (excludedReason) excluded.push(item);
    else items.push(item);
  }

  items.sort((a, b) => (b.score_total || 0) - (a.score_total || 0) || a.business_name.localeCompare(b.business_name));
  excluded.sort((a, b) => a.business_name.localeCompare(b.business_name));

  return {
    items,
    excluded,
    message: items.length
      ? `${items.length} leads in queue (${excluded.length} excluded).`
      : excluded.length
        ? `No eligible leads — ${excluded.length} excluded (suppressed / unsubscribed / recent contact).`
        : 'Lead queue empty — sync CRM or run Discover Leads.',
  };
}

export async function applyLeadQueueAction(
  opts: {
    lead_id: string;
    action: LeadQueueAction;
    reason?: string;
    outreach_status?: OutreachStatus;
  },
  env: LeadQueueEnv = process.env,
): Promise<{ ok: true; state: LeadQueuePersisted; audit: LeadQueueAuditEntry } | { ok: false; message: string }> {
  const id = String(opts.lead_id || '').trim();
  if (!id) return { ok: false, message: 'lead_id required.' };
  const action = opts.action;
  if (!['approve', 'reject', 'save_for_later', 'draft_email'].includes(action)) {
    return { ok: false, message: 'Unknown action.' };
  }
  if (action === 'reject' && !String(opts.reason || '').trim()) {
    return { ok: false, message: 'Reject requires a reason.' };
  }

  const state = await readLeadQueueState(env);
  const queue_status: LeadQueueRecordStatus =
    action === 'approve'
      ? 'approved'
      : action === 'reject'
        ? 'rejected'
        : action === 'save_for_later'
          ? 'saved'
          : 'drafted';

  state.by_id[id] = {
    queue_status,
    reject_reason: action === 'reject' ? String(opts.reason).trim() : null,
    outreach_status: opts.outreach_status || state.by_id[id]?.outreach_status || 'unknown',
    updated_at: nowIso(),
  };
  await writeLeadQueueState(state, env);
  const audit = await appendAudit(
    {
      lead_id: id,
      action,
      reason: opts.reason ? String(opts.reason).trim() : null,
      actor: 'owner',
    },
    env,
  );
  return { ok: true, state, audit };
}

export type LeadQueueFilter = {
  q?: string;
  queue_status?: LeadQueueRecordStatus | 'all';
  source?: LeadQueueSource | 'all';
  has_email?: boolean;
  has_observation?: boolean;
};

export function filterLeadQueue(items: LeadQueueItem[], filter: LeadQueueFilter = {}): LeadQueueItem[] {
  const q = String(filter.q || '')
    .trim()
    .toLowerCase();
  return items.filter((item) => {
    if (filter.queue_status && filter.queue_status !== 'all' && item.queue_status !== filter.queue_status) {
      return false;
    }
    if (filter.source && filter.source !== 'all' && !item.sources.includes(filter.source)) {
      return false;
    }
    if (filter.has_email === true && !item.email) return false;
    if (filter.has_email === false && item.email) return false;
    if (filter.has_observation === true && !item.website_observation) return false;
    if (filter.has_observation === false && item.website_observation) return false;
    if (!q) return true;
    const hay = [item.business_name, item.email, item.location, item.category, item.domain]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  });
}

/** Fixture factory for tests — Mac CRM snapshot shape. */
export function fixtureCrmLead(overrides: Partial<CrmLead> = {}): CrmLead {
  return {
    id: overrides.id ?? 101,
    business_name: overrides.business_name ?? 'Fixture Spa',
    contact_name: overrides.contact_name ?? 'Owner',
    email: overrides.email ?? 'hello@fixturespa.com',
    location: overrides.location ?? 'Irvine, CA',
    category: overrides.category ?? 'medspa',
    website_observation: overrides.website_observation ?? 'booking link buried below the fold',
    contactable: overrides.contactable ?? true,
    email_accepted: overrides.email_accepted ?? 'UNKNOWN',
    delivered: overrides.delivered ?? 'UNKNOWN',
    bounced: overrides.bounced ?? 'UNKNOWN',
    replied: overrides.replied ?? 'UNKNOWN',
    booked: overrides.booked ?? 'NO',
    ...overrides,
  };
}

/** Fixture factory for Neon discovered leads. */
export function fixtureDiscoveredLead(overrides: Partial<DiscoveredLead> = {}): DiscoveredLead {
  const now = nowIso();
  return {
    id: overrides.id ?? 'disc_1',
    place_id: overrides.place_id ?? 'places/ChIJfixture1',
    business_name: overrides.business_name ?? 'Discovery Salon',
    website: overrides.website ?? 'https://discoverysalon.example',
    city: overrides.city ?? 'Newport Beach',
    category: overrides.category ?? 'salon',
    public_email: overrides.public_email ?? 'info@discoverysalon.example',
    phone: overrides.phone ?? null,
    social: overrides.social ?? {},
    source_url: overrides.source_url ?? null,
    last_verified_at: overrides.last_verified_at ?? now,
    status: overrides.status ?? 'qualified',
    score_total: overrides.score_total ?? 72,
    scores: overrides.scores ?? {
      website: 18,
      mobile: 14,
      brand: 12,
      booking: 10,
      fit: 12,
      contactability: 6,
    },
    evidence: overrides.evidence ?? [
      {
        field: 'website',
        signal: 'weak_cta',
        detail: 'Primary CTA is a phone number, not online booking.',
        source: 'fetched:https://discoverysalon.example',
      },
    ],
    fit_summary: overrides.fit_summary ?? 'OC beauty brand with weak booking UX.',
    problems: overrides.problems ?? ['No clear online booking'],
    service_opportunity: overrides.service_opportunity ?? 'Website refresh + booking',
    payment_capacity_signals: overrides.payment_capacity_signals ?? ['premium services'],
    weak_website_signals: overrides.weak_website_signals ?? ['no clear online booking'],
    enrichment: overrides.enrichment ?? {
      email_source: 'website_mailto',
      email_verified_public: true,
      last_enrichment_at: now,
    },
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
    ...overrides,
  };
}
