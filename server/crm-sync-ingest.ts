/**
 * Authenticated CRM sync ingest (Mac → website only).
 * Bearer / shared-secret auth. Never sends email. Read-only on Mac DB side.
 */
import { timingSafeEqual } from 'node:crypto';
import type {
  CrmBookingItem,
  CrmCampaignSummary,
  CrmEmailHistoryItem,
  CrmInboxItem,
  CrmSyncIngestResult,
  CrmSyncPayload,
  CrmSyncSnapshot,
  TrackingTriState,
} from './crm-types.js';
import {
  CRM_SYNC_MAX_BYTES,
  computeOverviewFromLeads,
  emptySnapshot,
  normalizeLead,
  readSnapshot,
  syncSecretConfigured,
  writeSnapshot,
  type CrmSyncStoreEnv,
} from './crm-sync-store.js';
import { isDurableDbConfigured, requiresDurableDb } from './crm-db.js';
import {
  mergeMacEmailHistory,
  mergeMacLeadsIntoExisting,
  type CrmEmailHistoryWithMeta,
  type CrmLeadWithMeta,
} from './crm-freshness.js';

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function crmSyncSecret(env: CrmSyncStoreEnv = process.env): string {
  return (env.CRM_SYNC_SECRET || env.LEAD_AGENT_CRM_SECRET || '').trim();
}

export function authorizeCrmSync(
  headers: { authorization?: string | null; 'x-bbl-crm-sync-key'?: string | null; 'x-bbl-crm-key'?: string | null },
  env: CrmSyncStoreEnv = process.env,
): { ok: true } | { ok: false; status: number; message: string } {
  const secret = crmSyncSecret(env);
  if (!secret) {
    return {
      ok: false,
      status: 503,
      message: 'CRM_SYNC_SECRET is not configured on this host.',
    };
  }
  const auth = String(headers.authorization || '');
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const key = String(headers['x-bbl-crm-sync-key'] || headers['x-bbl-crm-key'] || '').trim();
  const presented = bearer || key;
  if (!presented || !safeEqual(presented, secret)) {
    return { ok: false, status: 401, message: 'Unauthorized CRM sync.' };
  }
  return { ok: true };
}

function asTri(value: unknown, fallback: TrackingTriState = 'UNKNOWN'): TrackingTriState {
  const v = String(value || '').toUpperCase();
  if (v === 'YES' || v === 'NO' || v === 'UNKNOWN') return v;
  return fallback;
}

function providerAcceptedEvidence(row: Record<string, unknown>): boolean {
  const pmid = String(row.provider_message_id || row.resend_id || '').trim();
  if (!pmid) return false;
  const detail = String(row.detail || row.provider_response || row.response || '');
  if (/http\s*=\s*200/i.test(detail) || /\bstatus(?:Code)?\s*[:=]\s*200\b/i.test(detail)) {
    return true;
  }
  // Explicit Mac-computed accepted=YES with provider_message_id is trusted
  // (Mac already required http=200 + pmid). Bare SENT alone is not.
  return String(row.accepted || '').toUpperCase() === 'YES';
}

function normalizeEmailHistory(raw: unknown): CrmEmailHistoryItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const email = String(row.email || '').trim().toLowerCase();
  if (!email.includes('@')) return null;
  const status = (row.status as string | null | undefined) ?? null;
  const statusUpper = String(status || '').toUpperCase();
  const dryRun =
    Boolean(row.dry_run) || statusUpper === 'DRY_RUN_SENT' || String(row.dry_run) === '1';
  const pmid =
    (row.provider_message_id as string | null | undefined) ||
    (row.resend_id as string | null | undefined) ||
    null;
  let accepted: TrackingTriState = 'UNKNOWN';
  if (!dryRun && providerAcceptedEvidence({ ...row, provider_message_id: pmid })) {
    accepted = 'YES';
  } else if (row.accepted != null && String(row.accepted).trim() !== '') {
    // Preserve explicit NO; never upgrade SENT → YES without evidence.
    const tri = asTri(row.accepted, 'UNKNOWN');
    accepted = tri === 'YES' && (!pmid || dryRun) ? 'UNKNOWN' : tri;
  }
  return {
    id: row.id != null ? String(row.id) : undefined,
    lead_id: (row.lead_id as number | string | null | undefined) ?? null,
    email,
    business_name: (row.business_name as string | null | undefined) ?? null,
    subject: (row.subject as string | null | undefined) ?? null,
    campaign_name: (row.campaign_name as string | null | undefined) ?? null,
    provider_message_id: pmid ? String(pmid) : null,
    status,
    dry_run: dryRun,
    accepted,
    delivered: asTri(row.delivered, 'UNKNOWN'),
    bounced: asTri(row.bounced, 'UNKNOWN'),
    replied: asTri(row.replied, 'UNKNOWN'),
    sent_at: (row.sent_at as string | null | undefined) ?? null,
  };
}

function normalizeCampaign(raw: unknown): CrmCampaignSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const id = String(row.id || '').trim();
  if (!id) return null;
  const statusRaw = String(row.status || 'unknown').toLowerCase();
  const status =
    statusRaw === 'draft' || statusRaw === 'dry_run' || statusRaw === 'sent' ? statusRaw : 'unknown';
  return {
    id,
    name: String(row.name || id),
    subject: (row.subject as string | null | undefined) ?? null,
    status,
    recipient_count: Number(row.recipient_count || 0) || 0,
    accepted: row.accepted == null ? undefined : Number(row.accepted) || 0,
    delivered: row.delivered == null ? undefined : Number(row.delivered) || 0,
    bounced: row.bounced == null ? undefined : Number(row.bounced) || 0,
    replied: row.replied == null ? undefined : Number(row.replied) || 0,
    booked: row.booked == null ? undefined : Number(row.booked) || 0,
    created_at: (row.created_at as string | null | undefined) ?? null,
    sent_at: (row.sent_at as string | null | undefined) ?? null,
  };
}

function normalizeInbox(raw: unknown): CrmInboxItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const from = String(row.from_email || row.email || '').trim().toLowerCase();
  if (!from.includes('@')) return null;
  const sourceRaw = String(row.source || 'unknown');
  const source =
    sourceRaw === 'resend_inbound' || sourceRaw === 'gmail' || sourceRaw === 'website_form'
      ? sourceRaw
      : 'unknown';
  return {
    id: String(row.id || `${from}:${row.received_at || ''}`),
    from_email: from,
    lead_id: (row.lead_id as number | string | null | undefined) ?? null,
    subject: (row.subject as string | null | undefined) ?? null,
    snippet: (row.snippet as string | null | undefined) ?? null,
    received_at: (row.received_at as string | null | undefined) ?? null,
    source,
  };
}

function normalizeBooking(raw: unknown): CrmBookingItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const email = String(row.email || '').trim().toLowerCase();
  if (!email.includes('@')) return null;
  return {
    id: String(row.id || `${email}:${row.meeting_start || row.booked_at || ''}`),
    email,
    name: (row.name as string | null | undefined) ?? null,
    lead_id: (row.lead_id as number | string | null | undefined) ?? null,
    meeting_start: (row.meeting_start as string | null | undefined) ?? null,
    booked_at: (row.booked_at as string | null | undefined) ?? null,
    status: String(row.status || '').toLowerCase() === 'confirmed' ? 'confirmed' : 'unknown',
  };
}

function mergeById<T>(
  existing: T[],
  incoming: T[],
  keyFn: (item: T) => string,
): T[] {
  const map = new Map<string, T>();
  for (const item of existing) map.set(keyFn(item), item);
  for (const item of incoming) map.set(keyFn(item), item);
  return [...map.values()];
}

export function parseSyncPayload(body: unknown, rawBytes = 0): { ok: true; payload: CrmSyncPayload } | { ok: false; message: string } {
  if (rawBytes > CRM_SYNC_MAX_BYTES) {
    return { ok: false, message: `Sync payload exceeds ${CRM_SYNC_MAX_BYTES} bytes.` };
  }
  if (!body || typeof body !== 'object') {
    return { ok: false, message: 'Sync body must be a JSON object.' };
  }
  const raw = body as Record<string, unknown>;
  const leadsIn = Array.isArray(raw.leads) ? raw.leads : null;
  if (!leadsIn) {
    return { ok: false, message: 'Sync payload requires a leads array (use [] for an intentional empty sync).' };
  }
  const leads = leadsIn
    .map((item) => normalizeLead((item || {}) as never))
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  const email_history = (Array.isArray(raw.email_history) ? raw.email_history : [])
    .map(normalizeEmailHistory)
    .filter((item): item is CrmEmailHistoryItem => Boolean(item));

  const campaigns = (Array.isArray(raw.campaigns) ? raw.campaigns : [])
    .map(normalizeCampaign)
    .filter((item): item is CrmCampaignSummary => Boolean(item));

  const inbox = (Array.isArray(raw.inbox) ? raw.inbox : [])
    .map(normalizeInbox)
    .filter((item): item is CrmInboxItem => Boolean(item));

  const bookings = (Array.isArray(raw.bookings) ? raw.bookings : [])
    .map(normalizeBooking)
    .filter((item): item is CrmBookingItem => Boolean(item));

  const suppressions = (Array.isArray(raw.suppressions) ? raw.suppressions : [])
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const row = item as Record<string, unknown>;
      const email = String(row.email || '').trim().toLowerCase();
      if (!email.includes('@')) return null;
      return {
        email,
        lead_id: (row.lead_id as number | string | null | undefined) ?? null,
        reason: (row.reason as string | null | undefined) ?? null,
        created_at: (row.created_at as string | null | undefined) ?? null,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  // Enrich leads from email history (accepted + provider ids) without inventing delivery.
  // Never promote bare SENT / dry_run to accepted; never invent delivery/bounce/reply.
  const byEmail = new Map(leads.filter((l) => l.email.includes('@')).map((l) => [l.email, l]));
  for (const hist of email_history) {
    const lead = byEmail.get(hist.email);
    if (!lead) continue;
    if (hist.provider_message_id) {
      const ids = new Set(lead.provider_message_ids || []);
      ids.add(hist.provider_message_id);
      lead.provider_message_ids = [...ids];
    }
    if (hist.accepted === 'YES' && !hist.dry_run) {
      lead.email_accepted = 'YES';
    }
    if (hist.delivered === 'YES') lead.delivered = 'YES';
    if (hist.bounced === 'YES') lead.bounced = 'YES';
    if (hist.replied === 'YES') lead.replied = 'YES';
  }

  for (const row of suppressions) {
    const lead = byEmail.get(row.email);
    if (!lead) continue;
    lead.suppressed = true;
    if (String(row.reason || '').toLowerCase().includes('unsub')) lead.unsubscribed = true;
  }

  const mode = raw.mode === 'merge' ? 'merge' : 'replace';
  const overview =
    raw.overview && typeof raw.overview === 'object'
      ? { ...computeOverviewFromLeads(leads, email_history), ...(raw.overview as object) }
      : computeOverviewFromLeads(leads, email_history);

  return {
    ok: true,
    payload: {
      schema_version: 1,
      synced_at: typeof raw.synced_at === 'string' ? raw.synced_at : undefined,
      source_host: typeof raw.source_host === 'string' ? raw.source_host : undefined,
      mode,
      leads,
      overview,
      campaigns,
      email_history,
      inbox,
      bookings,
      suppressions,
    },
  };
}

export async function ingestCrmSync(
  body: unknown,
  opts: { rawBytes?: number; env?: CrmSyncStoreEnv } = {},
): Promise<CrmSyncIngestResult> {
  const env = opts.env || process.env;
  if (!syncSecretConfigured(env)) {
    return { ok: false, status: 503, message: 'CRM_SYNC_SECRET is not configured on this host.' };
  }
  if (requiresDurableDb(env) && !isDurableDbConfigured(env)) {
    return {
      ok: false,
      status: 503,
      message: 'CRM_DATABASE_URL is required on Vercel for durable CRM storage (/tmp disabled).',
    };
  }
  const parsed = parseSyncPayload(body, opts.rawBytes || 0);
  if (!parsed.ok) {
    return { ok: false, status: 400, message: parsed.message };
  }

  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const existing = (await readSnapshot(env)) || emptySnapshot();
  const payload = parsed.payload;
  const mode = payload.mode || 'replace';
  const syncedAt = payload.synced_at || now;

  // Always freshness-merge tracking so older Mac payloads cannot clobber webhooks.
  const leads = mergeMacLeadsIntoExisting(
    existing.leads as CrmLeadWithMeta[],
    payload.leads as CrmLeadWithMeta[],
    syncedAt,
  );
  const email_history = mergeMacEmailHistory(
    existing.email_history as CrmEmailHistoryWithMeta[],
    (payload.email_history || []) as CrmEmailHistoryWithMeta[],
    syncedAt,
  );

  let campaigns = payload.campaigns || [];
  let inbox = payload.inbox || [];
  let bookings = payload.bookings || [];
  let suppressions = payload.suppressions || [];

  if (mode === 'merge' && existing.last_synced_at) {
    campaigns = mergeById(existing.campaigns, campaigns, (c) => String(c.id));
    inbox = mergeById(existing.inbox, inbox, (i) => String(i.id));
    bookings = mergeById(existing.bookings, bookings, (b) => String(b.id));
    suppressions = mergeById(existing.suppressions, suppressions, (s) => s.email);
  } else {
    // replace membership for campaigns/bookings/suppressions from Mac,
    // but keep website inbox replies that Mac didn't push.
    inbox = mergeById(existing.inbox.filter((i) => i.source === 'resend_inbound'), inbox, (i) => String(i.id));
  }

  const next: CrmSyncSnapshot = {
    schema_version: 1,
    last_synced_at: syncedAt,
    source_host: payload.source_host || existing.source_host || null,
    leads,
    email_history,
    campaigns,
    inbox,
    bookings,
    suppressions,
    overview: payload.overview || computeOverviewFromLeads(leads, email_history),
  };

  try {
    await writeSnapshot(next, env);
  } catch (error) {
    return {
      ok: false,
      status: 503,
      message: error instanceof Error ? error.message : 'Failed to persist CRM snapshot.',
    };
  }
  return {
    ok: true,
    status: 200,
    message: `CRM sync stored (${mode}) with webhook-preserving freshness merge.`,
    last_synced_at: next.last_synced_at,
    counts: {
      leads: next.leads.length,
      email_history: next.email_history.length,
      campaigns: next.campaigns.length,
      inbox: next.inbox.length,
      bookings: next.bookings.length,
      suppressions: next.suppressions.length,
    },
  };
}
