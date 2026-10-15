/**
 * CRM data access for the admin dashboard.
 * Reads the Mac→website push-sync snapshot. Never invents lead rows.
 * Pull-from-Mac is retired (Mac stays offline / outbound-only).
 */
import type {
  CrmBookingItem,
  CrmCampaignSummary,
  CrmEmailHistoryItem,
  CrmEnvelope,
  CrmInboxItem,
  CrmLead,
  CrmOverviewMetrics,
} from './crm-types';
import { CRM_PUSH_SYNC_CONTRACT, LEAD_AGENT_CRM_CONTRACT } from './crm-types';
import { safetySnapshot } from './crm-safety';
import {
  connectionStatus,
  emptyOverview,
  filterLeads,
  hasSuccessfulSync,
  persistenceInfo,
  readSnapshot,
  syncSecretConfigured,
  type CrmSyncStoreEnv,
} from './crm-sync-store';
import { isDurableDbConfigured } from './crm-db';

export { CRM_PUSH_SYNC_CONTRACT, LEAD_AGENT_CRM_CONTRACT };

async function envelopeForConnection<T>(
  data: T,
  env: CrmSyncStoreEnv,
): Promise<CrmEnvelope<T>> {
  const conn = await connectionStatus(env);
  const trusted = conn.status === 'synced' || (conn.status === 'sync_pending' && Boolean(conn.last_synced_at));
  const source =
    conn.status === 'synced'
      ? 'sync_snapshot'
      : conn.status === 'sync_pending'
        ? 'sync_pending'
        : 'not_connected';
  return {
    ok: true,
    source,
    connection: conn.status,
    last_synced_at: conn.last_synced_at,
    message: conn.message,
    data,
    metrics_trusted: trusted && (await hasSuccessfulSync(env)),
  };
}

export async function fetchOverview(env: CrmSyncStoreEnv = process.env): Promise<CrmEnvelope<CrmOverviewMetrics | null>> {
  const snapshot = await readSnapshot(env);
  const conn = await connectionStatus(env);
  if (!snapshot?.last_synced_at) {
    return {
      ok: true,
      source: conn.status === 'sync_pending' ? 'sync_pending' : 'not_connected',
      connection: conn.status,
      last_synced_at: null,
      message: conn.message,
      data: null,
      metrics_trusted: false,
    };
  }
  return {
    ok: true,
    source: 'sync_snapshot',
    connection: conn.status,
    last_synced_at: conn.last_synced_at,
    message: conn.message,
    data: snapshot.overview || emptyOverview(),
    metrics_trusted: true,
  };
}

export async function fetchLeads(query = '', env: CrmSyncStoreEnv = process.env): Promise<CrmEnvelope<CrmLead[]>> {
  const snapshot = await readSnapshot(env);
  if (!snapshot?.last_synced_at) {
    return envelopeForConnection<CrmLead[]>([], env);
  }
  return envelopeForConnection(filterLeads(snapshot.leads, query), env);
}

export async function fetchInbox(env: CrmSyncStoreEnv = process.env): Promise<CrmEnvelope<CrmInboxItem[]>> {
  const snapshot = await readSnapshot(env);
  const conn = await connectionStatus(env);
  if (!snapshot?.last_synced_at) {
    return {
      ...(await envelopeForConnection<CrmInboxItem[]>([], env)),
      message:
        conn.message +
        ' Reply inbox is populated from Mac sync and/or Resend inbound webhooks — never auto-replies.',
    };
  }
  return {
    ...(await envelopeForConnection(snapshot.inbox || [], env)),
    message:
      snapshot.inbox?.length
        ? conn.message
        : 'No replies in the sync cache. Reply detection needs Resend inbound or Gmail readonly on Mac (no auto-replies).',
  };
}

export async function fetchBookings(env: CrmSyncStoreEnv = process.env): Promise<CrmEnvelope<CrmBookingItem[]>> {
  const snapshot = await readSnapshot(env);
  const conn = await connectionStatus(env);
  if (!snapshot?.last_synced_at) {
    return {
      ...(await envelopeForConnection<CrmBookingItem[]>([], env)),
      message:
        conn.message +
        ' Booking rows appear after Mac sync. Site→Mac reverse booking notify remains deferred (local_only).',
    };
  }
  return {
    ...(await envelopeForConnection(snapshot.bookings || [], env)),
    message:
      snapshot.bookings?.length
        ? conn.message
        : 'No confirmed CRM bookings in the sync cache. Site booking works; reverse sync to Mac remains deferred until a durable host is approved.',
  };
}

export async function fetchCampaigns(env: CrmSyncStoreEnv = process.env): Promise<CrmEnvelope<CrmCampaignSummary[]>> {
  const snapshot = await readSnapshot(env);
  if (!snapshot?.last_synced_at) {
    return envelopeForConnection<CrmCampaignSummary[]>([], env);
  }
  return envelopeForConnection(snapshot.campaigns || [], env);
}

export async function fetchEmailHistory(env: CrmSyncStoreEnv = process.env): Promise<CrmEnvelope<CrmEmailHistoryItem[]>> {
  const snapshot = await readSnapshot(env);
  if (!snapshot?.last_synced_at) {
    return envelopeForConnection<CrmEmailHistoryItem[]>([], env);
  }
  return envelopeForConnection(snapshot.email_history || [], env);
}

export async function crmConfigStatus(env: NodeJS.ProcessEnv = process.env) {
  const conn = await connectionStatus(env);
  const persistence = persistenceInfo(env);
  return {
    connection: conn.status,
    last_synced_at: conn.last_synced_at,
    stale: conn.stale,
    sync_secret_configured: syncSecretConfigured(env),
    durable_db_configured: isDurableDbConfigured(env),
    /** @deprecated pull model retired */
    lead_agent_configured: syncSecretConfigured(env),
    lead_agent_base_url: null,
    resend_webhook_secret: Boolean(env.RESEND_WEBHOOK_SECRET),
    lead_agent_resend_webhook_url: env.LEAD_AGENT_RESEND_WEBHOOK_URL || null,
    contract: CRM_PUSH_SYNC_CONTRACT,
    safety: {
      ...safetySnapshot(env),
      FOLLOWUPS_LIVE: false,
    },
    persistence,
    mac_side_required: [
      'Set CRM_DATABASE_URL (Neon/Vercel Postgres) on Vercel — required for durable CRM',
      'Run scripts/crm-mac-sync/push_crm_sync.py against local leads.db (readonly)',
      'Set CRM_SYNC_SECRET on Vercel and Mac (.env) — same value',
      'POST snapshots to POST /api/crm/sync (Mac → website only)',
      'Do not expose SQLite or Mac ports to the public internet',
      'Point Resend webhooks at https://www.bbl.studio/api/resend-webhook',
      'Reply path (Resend inbound or Gmail OAuth) still optional / scaffold',
      'Booking site→Mac reverse notify still deferred (preferences)',
      'Keep EMAIL_OUTREACH_ENABLED=false, EMAIL_DRY_RUN=true, MANUAL_SEND_LIVE_ENABLED=false, FOLLOWUPS_LIVE=false',
    ],
  };
}
