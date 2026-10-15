/**
 * Server-side CRM sync snapshot cache.
 *
 * Architecture: Mac is outbound-only. It pushes a JSON snapshot to the website;
 * the dashboard reads from this cache. SQLite / the Mac are never exposed.
 *
 * Persistence:
 * - Local/dev: ./data/crm-sync-snapshot.json (durable on disk)
 * - Vercel: /tmp/bbls-crm-sync-snapshot.json (ephemeral per instance —
 *   Mac must re-push after cold starts; see docs/crm-admin-integration.md)
 *
 * Limits: JSON file, soft max ~4MB payload; keep email history + leads lean.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
} from './crm-types';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Soft payload budget (bytes) for ingest validation. */
export const CRM_SYNC_MAX_BYTES = 4 * 1024 * 1024;

export type CrmSyncStoreEnv = {
  VERCEL?: string;
  CRM_SYNC_STORE_PATH?: string;
  CRM_SYNC_SECRET?: string;
  LEAD_AGENT_CRM_SECRET?: string;
  CRM_SYNC_STALE_HOURS?: string;
};

let memorySnapshot: CrmSyncSnapshot | null = null;

export function crmSyncStorePath(env: CrmSyncStoreEnv = process.env): string {
  if (env.CRM_SYNC_STORE_PATH) return resolve(env.CRM_SYNC_STORE_PATH);
  if (env.VERCEL) return '/tmp/bbls-crm-sync-snapshot.json';
  return resolve(root, 'data/crm-sync-snapshot.json');
}

export function emptyOverview(): CrmOverviewMetrics {
  return {
    total_leads: 0,
    new_leads: 0,
    contacted_leads: 0,
    emails_sent: 0,
    emails_delivered: 0,
    emails_bounced: 0,
    replies: 0,
    booked: 0,
    conversion_rate: null,
    last_activity_at: null,
  };
}

export function emptySnapshot(): CrmSyncSnapshot {
  return {
    schema_version: 1,
    last_synced_at: null,
    source_host: null,
    leads: [],
    overview: emptyOverview(),
    campaigns: [],
    email_history: [],
    inbox: [],
    bookings: [],
    suppressions: [],
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

export function readSnapshot(env: CrmSyncStoreEnv = process.env): CrmSyncSnapshot | null {
  if (memorySnapshot?.last_synced_at) return memorySnapshot;
  const fromDisk = readJsonFile(crmSyncStorePath(env));
  if (fromDisk?.last_synced_at) {
    memorySnapshot = fromDisk;
    return fromDisk;
  }
  return null;
}

export function writeSnapshot(snapshot: CrmSyncSnapshot, env: CrmSyncStoreEnv = process.env): void {
  memorySnapshot = snapshot;
  const path = crmSyncStorePath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}

/** Test helper — clears in-memory cache so path/env changes take effect. */
export function resetSnapshotCache(): void {
  memorySnapshot = null;
}

export function hasSuccessfulSync(env: CrmSyncStoreEnv = process.env): boolean {
  return Boolean(readSnapshot(env)?.last_synced_at);
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

/**
 * Connection semantics for the dashboard:
 * - not_connected: never synced (and no waiting secret) — show Not connected
 * - sync_pending: secret ready / waiting for first push, or sync is stale
 * - synced: fresh successful sync — real zeros allowed
 */
export function connectionStatus(env: CrmSyncStoreEnv = process.env): {
  status: CrmConnectionStatus;
  last_synced_at: string | null;
  stale: boolean;
  message: string;
} {
  const snapshot = readSnapshot(env);
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
    (l) => l.email_accepted === 'YES' || Boolean(l.last_contacted_at) || String(l.email_status || '').toUpperCase() === 'SENT',
  ).length;
  const emails_sent =
    emailHistory.filter((e) => e.accepted === 'YES' || e.status === 'SENT' || e.status === 'ACCEPTED').length ||
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

export function normalizeLead(raw: Partial<CrmLead> & Record<string, unknown>): CrmLead | null {
  const id = raw.id;
  const email = String(raw.email || '').trim().toLowerCase();
  const business = String(raw.business_name || raw.business || '').trim();
  if (id == null || id === '' || !email.includes('@') || !business) return null;
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
    email_status: (raw.email_status as string | null | undefined) ?? null,
    last_contacted_at: (raw.last_contacted_at as string | null | undefined) ?? null,
    last_activity_at: (raw.last_activity_at as string | null | undefined) ?? null,
    notes: (raw.notes as string | null | undefined) ?? null,
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
  const key = item.provider_message_id || `${item.lead_id}:${item.email}:${item.sent_at || ''}`;
  const next = history.filter((row) => {
    const rowKey = row.provider_message_id || `${row.lead_id}:${row.email}:${row.sent_at || ''}`;
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
