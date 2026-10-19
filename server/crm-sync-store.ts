/**
 * Server-side CRM sync snapshot cache.
 *
 * Architecture: Mac is outbound-only. It pushes a JSON snapshot to the website;
 * the dashboard reads from this cache. SQLite / the Mac are never exposed.
 *
 * Persistence:
 * - Production (Vercel): Neon/Vercel Postgres via CRM_DATABASE_URL (required)
 * - Local/dev without DB URL: ./data/crm-sync-snapshot.json
 * - /tmp is NOT used on Vercel anymore
 *
 * Soft max ~4MB Mac push payload.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type {
  CrmBookingItem,
  CrmCampaignSummary,
  CrmConnectionStatus,
  CrmEmailHistoryItem,
  CrmInboxItem,
  CrmLead,
  CrmOverviewMetrics,
  CrmSyncSnapshot,
  TrackingTriState,
} from './crm-types.js';
import {
  crmDatabaseUrl,
  dbReadSnapshot,
  dbWriteSnapshot,
  isDurableDbConfigured,
  requiresDurableDb,
  type CrmDbEnv,
} from './crm-db.js';
import { emptyOverview, emptySnapshot } from './crm-sync-store-empty.js';
import { resolveProjectRoot } from './project-root.js';

export { emptyOverview, emptySnapshot };

function projectRoot() {
  return resolveProjectRoot(import.meta.url);
}

/** Soft payload budget (bytes) for ingest validation. */
export const CRM_SYNC_MAX_BYTES = 4 * 1024 * 1024;

export type CrmSyncStoreEnv = CrmDbEnv & {
  CRM_SYNC_STORE_PATH?: string;
  CRM_SYNC_SECRET?: string;
  LEAD_AGENT_CRM_SECRET?: string;
  CRM_SYNC_STALE_HOURS?: string;
};

let memorySnapshot: CrmSyncSnapshot | null = null;

export function crmSyncStorePath(env: CrmSyncStoreEnv = process.env): string {
  if (env.CRM_SYNC_STORE_PATH) return resolve(env.CRM_SYNC_STORE_PATH);
  // Never default to /tmp on Vercel — durable DB is required there.
  return resolve(projectRoot(), 'data/crm-sync-snapshot.json');
}

export function persistenceInfo(env: CrmSyncStoreEnv = process.env) {
  if (isDurableDbConfigured(env)) {
    const url = crmDatabaseUrl(env);
    const kind = url === 'memory://crm' || env.CRM_DATABASE_MEMORY === '1' ? 'memory' : 'neon_postgres';
    return {
      backend: kind,
      store: kind === 'neon_postgres' ? 'CRM_DATABASE_URL (Neon/Vercel Postgres)' : 'memory://crm (tests)',
      durable: true,
      note: 'Webhook events and sync snapshots survive deploys and cold starts. Mac sync merges must not clobber fresher webhook tracking.',
    };
  }
  if (requiresDurableDb(env)) {
    return {
      backend: 'unconfigured',
      store: '(missing CRM_DATABASE_URL)',
      durable: false,
      note: 'Vercel requires CRM_DATABASE_URL. /tmp is disabled for CRM — sync ingest returns 503 until Postgres is configured.',
    };
  }
  return {
    backend: 'json_file',
    store: crmSyncStorePath(env),
    durable: true,
    note: 'Local JSON file store. Set CRM_DATABASE_URL to exercise the production Postgres path.',
  };
}

function readJsonFile(path: string): CrmSyncSnapshot | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as CrmSyncSnapshot;
    if (!raw || typeof raw !== 'object') return null;
    return {
      ...emptySnapshot(),
      ...raw,
      schema_version: 1,
      leads: Array.isArray(raw.leads) ? raw.leads : [],
      campaigns: Array.isArray(raw.campaigns) ? raw.campaigns : [],
      email_history: Array.isArray(raw.email_history) ? raw.email_history : [],
      inbox: Array.isArray(raw.inbox) ? raw.inbox : [],
      bookings: Array.isArray(raw.bookings) ? raw.bookings : [],
      suppressions: Array.isArray(raw.suppressions) ? raw.suppressions : [],
      overview: raw.overview && typeof raw.overview === 'object' ? { ...emptyOverview(), ...raw.overview } : emptyOverview(),
    };
  } catch {
    return null;
  }
}

export async function readSnapshot(env: CrmSyncStoreEnv = process.env): Promise<CrmSyncSnapshot | null> {
  if (isDurableDbConfigured(env)) {
    const fromDb = await dbReadSnapshot(env);
    if (fromDb?.last_synced_at) {
      memorySnapshot = fromDb;
      return fromDb;
    }
    // Allow webhook-only shells (last_synced_at null) to round-trip.
    if (fromDb) {
      memorySnapshot = fromDb;
      return fromDb;
    }
    return null;
  }
  if (requiresDurableDb(env)) {
    return null;
  }
  if (memorySnapshot?.last_synced_at) return memorySnapshot;
  const fromDisk = readJsonFile(crmSyncStorePath(env));
  if (fromDisk) {
    memorySnapshot = fromDisk;
    return fromDisk;
  }
  return null;
}

export async function writeSnapshot(snapshot: CrmSyncSnapshot, env: CrmSyncStoreEnv = process.env): Promise<void> {
  if (isDurableDbConfigured(env)) {
    await dbWriteSnapshot(snapshot, env);
    memorySnapshot = snapshot;
    return;
  }
  if (requiresDurableDb(env)) {
    throw new Error('CRM_DATABASE_URL is required on Vercel. Ephemeral /tmp CRM storage is disabled.');
  }
  memorySnapshot = snapshot;
  const path = crmSyncStorePath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}

/** Test helper — clears in-memory cache so path/env changes take effect. */
export function resetSnapshotCache(): void {
  memorySnapshot = null;
}

export async function hasSuccessfulSync(env: CrmSyncStoreEnv = process.env): Promise<boolean> {
  const snap = await readSnapshot(env);
  return Boolean(snap?.last_synced_at);
}

export function syncSecretConfigured(env: CrmSyncStoreEnv = process.env): boolean {
  return Boolean((env.CRM_SYNC_SECRET || env.LEAD_AGENT_CRM_SECRET || '').trim());
}

export function staleHours(env: CrmSyncStoreEnv = process.env): number {
  const n = Number(env.CRM_SYNC_STALE_HOURS || 48);
  return Number.isFinite(n) && n > 0 ? n : 48;
}

export function isSnapshotStale(snapshot: CrmSyncSnapshot | null, env: CrmSyncStoreEnv = process.env): boolean {
  if (!snapshot?.last_synced_at) return true;
  const ts = Date.parse(snapshot.last_synced_at);
  if (!Number.isFinite(ts)) return true;
  return Date.now() - ts > staleHours(env) * 3600 * 1000;
}

export async function connectionStatus(env: CrmSyncStoreEnv = process.env): Promise<{
  status: CrmConnectionStatus;
  last_synced_at: string | null;
  stale: boolean;
  message: string;
}> {
  if (requiresDurableDb(env) && !isDurableDbConfigured(env)) {
    return {
      status: 'not_connected',
      last_synced_at: null,
      stale: true,
      message:
        'Not connected — CRM_DATABASE_URL is required on Vercel for durable CRM storage. Configure Neon/Vercel Postgres before syncing.',
    };
  }
  const snapshot = await readSnapshot(env);
  const last = snapshot?.last_synced_at || null;
  if (!last) {
    if (syncSecretConfigured(env)) {
      return {
        status: 'sync_pending',
        last_synced_at: null,
        stale: true,
        message:
          'Sync pending — CRM_SYNC_SECRET is set but the Mac worker has not pushed a snapshot yet. Metrics stay blank until the first successful sync.',
      };
    }
    return {
      status: 'not_connected',
      last_synced_at: null,
      stale: true,
      message:
        'Not connected — Mac CRM has not synced to this host. Leads and campaign counts are unavailable (not zero).',
    };
  }
  if (isSnapshotStale(snapshot, env)) {
    return {
      status: 'sync_pending',
      last_synced_at: last,
      stale: true,
      message: `Sync pending — last successful sync was ${last}. Showing cached data; Mac should re-push soon.`,
    };
  }
  return {
    status: 'synced',
    last_synced_at: last,
    stale: false,
    message: `Connected — last sync ${last}.`,
  };
}

export function computeOverviewFromLeads(
  leads: CrmLead[],
  emailHistory: CrmEmailHistoryItem[] = [],
): CrmOverviewMetrics {
  const statuses = leads.map((l) => String(l.status || l.sales_status || '').toLowerCase());
  const new_leads = statuses.filter((s) => !s || s === 'new').length;
  const contacted_leads = leads.filter(
    (l) => l.email_accepted === 'YES' || Boolean(l.last_contacted_at),
  ).length;
  // Count only verified provider acceptance — never bare SENT / dry_run.
  const emails_sent =
    emailHistory.filter((e) => e.accepted === 'YES' && !e.dry_run).length ||
    leads.filter((l) => l.email_accepted === 'YES').length;
  const emails_delivered = leads.filter((l) => l.delivered === 'YES').length;
  const emails_bounced = leads.filter((l) => l.bounced === 'YES').length;
  const replies = leads.filter((l) => l.replied === 'YES').length;
  const booked = leads.filter((l) => l.booked === 'YES').length;
  const contactedOrSent = Math.max(contacted_leads, emails_sent, 1);
  const lastActivity = [...leads]
    .map((l) => l.last_activity_at || l.last_contacted_at || null)
    .filter(Boolean)
    .sort()
    .at(-1) as string | null | undefined;
  return {
    total_leads: leads.length,
    new_leads,
    contacted_leads,
    emails_sent,
    emails_delivered,
    emails_bounced,
    replies,
    booked,
    conversion_rate: leads.length ? Math.round((booked / contactedOrSent) * 1000) / 10 : null,
    last_activity_at: lastActivity || null,
  };
}

export function filterLeads(leads: CrmLead[], query: string): CrmLead[] {
  if (!query) return leads;
  const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  let out = [...leads];
  const status = (params.get('status') || '').toLowerCase();
  const category = (params.get('category') || '').toLowerCase();
  const location = (params.get('location') || '').toLowerCase();
  const emailStatus = (params.get('email_status') || '').toLowerCase();
  const booked = (params.get('booked') || '').toLowerCase();
  if (status) {
    out = out.filter((l) => String(l.status || l.sales_status || '').toLowerCase().includes(status));
  }
  if (category) {
    out = out.filter((l) => String(l.category || '').toLowerCase().includes(category));
  }
  if (location) {
    out = out.filter((l) => String(l.location || '').toLowerCase().includes(location));
  }
  if (emailStatus) {
    out = out.filter((l) => String(l.email_status || '').toLowerCase().includes(emailStatus));
  }
  if (booked === '1' || booked === 'yes' || booked === 'true') {
    out = out.filter((l) => l.booked === 'YES');
  }
  if (booked === '0' || booked === 'no' || booked === 'false') {
    out = out.filter((l) => l.booked !== 'YES');
  }
  return out;
}

function asTri(value: unknown, fallback: TrackingTriState = 'UNKNOWN'): TrackingTriState {
  const v = String(value || '').toUpperCase();
  if (v === 'YES' || v === 'NO' || v === 'UNKNOWN') return v;
  return fallback;
}

export function leadHasValidEmail(email: string | null | undefined): boolean {
  const e = String(email || '').trim().toLowerCase();
  return Boolean(e) && e.includes('@');
}

export function normalizeLead(raw: Partial<CrmLead> & Record<string, unknown>): CrmLead | null {
  const id = raw.id;
  const emailRaw = String(raw.email || '').trim().toLowerCase();
  const business = String(raw.business_name || raw.business || '').trim();
  if (id == null || id === '' || !business) return null;

  const contactable = raw.contactable === false ? false : leadHasValidEmail(emailRaw);
  const email = contactable ? emailRaw : '';
  let emailStatus = (raw.email_status as string | null | undefined) ?? null;
  let outreachStatus = (raw.email_outreach_status as string | null | undefined) ?? null;
  if (!contactable) {
    emailStatus =
      String(emailStatus || '').toUpperCase() === 'NOT CONTACTABLE' ? emailStatus : 'NOT CONTACTABLE';
    if (!outreachStatus) outreachStatus = 'NOT_CONTACTABLE';
  }

  return {
    id,
    business_name: business,
    contact_name: (raw.contact_name as string | null | undefined) ?? null,
    email,
    phone: (raw.phone as string | null | undefined) ?? null,
    location: (raw.location as string | null | undefined) ?? null,
    category: (raw.category as string | null | undefined) ?? null,
    status: (raw.status as string | null | undefined) ?? null,
    sales_status: (raw.sales_status as string | null | undefined) ?? null,
    email_status: emailStatus,
    email_outreach_status: outreachStatus,
    contactable,
    last_contacted_at: (raw.last_contacted_at as string | null | undefined) ?? null,
    last_activity_at: (raw.last_activity_at as string | null | undefined) ?? null,
    notes: (raw.notes as string | null | undefined) ?? null,
    website_observation:
      (raw.website_observation as string | null | undefined) ||
      (raw.outreach_observation as string | null | undefined) ||
      null,
    outreach_observation:
      (raw.outreach_observation as string | null | undefined) ||
      (raw.website_observation as string | null | undefined) ||
      null,
    suppressed: Boolean(raw.suppressed),
    unsubscribed: Boolean(raw.unsubscribed),
    email_accepted: asTri(raw.email_accepted, 'UNKNOWN'),
    delivered: asTri(raw.delivered, 'UNKNOWN'),
    bounced: asTri(raw.bounced, 'UNKNOWN'),
    replied: asTri(raw.replied, 'UNKNOWN'),
    booked: asTri(raw.booked, 'UNKNOWN'),
    booking_status: (raw.booking_status as string | null | undefined) ?? null,
    provider_message_ids: Array.isArray(raw.provider_message_ids)
      ? (raw.provider_message_ids as string[]).map(String)
      : undefined,
  };
}

export function applyTrackingToLead(
  lead: CrmLead,
  patch: {
    email_accepted?: TrackingTriState;
    delivered?: TrackingTriState;
    bounced?: TrackingTriState;
    replied?: TrackingTriState;
    booked?: TrackingTriState;
    email_status?: string;
    last_activity_at?: string;
    provider_message_id?: string;
  },
): CrmLead {
  const ids = new Set(lead.provider_message_ids || []);
  if (patch.provider_message_id) ids.add(patch.provider_message_id);
  return {
    ...lead,
    email_accepted: patch.email_accepted ?? lead.email_accepted,
    delivered: patch.delivered ?? lead.delivered,
    bounced: patch.bounced ?? lead.bounced,
    replied: patch.replied ?? lead.replied,
    booked: patch.booked ?? lead.booked,
    email_status: patch.email_status ?? lead.email_status,
    last_activity_at: patch.last_activity_at ?? lead.last_activity_at,
    provider_message_ids: ids.size ? [...ids] : lead.provider_message_ids,
  };
}

export function upsertEmailHistory(
  history: CrmEmailHistoryItem[],
  item: CrmEmailHistoryItem,
): CrmEmailHistoryItem[] {
  const key =
    (item.id != null && String(item.id).trim() !== '' ? String(item.id) : null) ||
    item.provider_message_id ||
    `${item.lead_id}:${item.email}:${item.sent_at || ''}`;
  const next = history.filter((row) => {
    const rowKey =
      (row.id != null && String(row.id).trim() !== '' ? String(row.id) : null) ||
      row.provider_message_id ||
      `${row.lead_id}:${row.email}:${row.sent_at || ''}`;
    return rowKey !== key;
  });
  next.unshift(item);
  return next.slice(0, 5000);
}

export type SnapshotSlice = {
  leads?: CrmLead[];
  overview?: CrmOverviewMetrics;
  campaigns?: CrmCampaignSummary[];
  email_history?: CrmEmailHistoryItem[];
  inbox?: CrmInboxItem[];
  bookings?: CrmBookingItem[];
  suppressions?: CrmSyncSnapshot['suppressions'];
};
