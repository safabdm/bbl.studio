/**
 * Shared CRM HTTP handlers used by Hono (local) and Vercel [...route].
 */
import {
  buildPreviews,
  createPreviewToken,
  executeManualSend,
  listDrafts,
  listTemplates,
  saveDraft,
  sendTestDryRun,
} from './crm-campaigns.js';
import {
  crmConfigStatus,
  fetchBookings,
  fetchCampaigns,
  fetchEmailHistory,
  fetchInbox,
  fetchLeads,
  fetchOverview,
} from './crm-lead-client.js';
import { authorizeCrmSync, ingestCrmSync } from './crm-sync-ingest.js';
import { connectionStatus } from './crm-sync-store.js';
import type { CrmLead, ManualSendRequest } from './crm-types.js';
import { safetySnapshot, selectedCount } from './crm-safety.js';

export type CrmJsonResult = { status: number; body: Record<string, unknown> };

function adminOk(isAdmin: boolean): CrmJsonResult | null {
  if (isAdmin) return null;
  return { status: 401, body: { ok: false, message: 'Sign in required.' } };
}

/** Never leak raw serverless FS failures (ENOENT mkdir '/var/task/data') into the CRM UI. */
function storageFailureMessage(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : String(err || '');
  if (/ENOENT|EACCES|EROFS|\/var\/task/i.test(raw)) {
    return 'Campaign storage unavailable on this host. CRM_DATABASE_URL (Neon) is required for drafts.';
  }
  return raw || fallback;
}

export async function handleCrmOverview(isAdmin: boolean, env = process.env): Promise<CrmJsonResult> {
  const denied = adminOk(isAdmin);
  if (denied) return denied;
  const result = await fetchOverview(env);
  const conn = await connectionStatus(env);
  return {
    status: 200,
    body: {
      ok: true,
      source: result.source,
      connection: result.connection,
      last_synced_at: result.last_synced_at,
      message: result.message,
      metrics: result.metrics_trusted ? result.data : null,
      metrics_trusted: Boolean(result.metrics_trusted),
      safety: {
        ...safetySnapshot(env),
        FOLLOWUPS_LIVE: false,
      },
      sync: {
        status: conn.status,
        stale: conn.stale,
        last_synced_at: conn.last_synced_at,
      },
    },
  };
}

export async function handleCrmLeads(
  isAdmin: boolean,
  query: string,
  env = process.env,
): Promise<CrmJsonResult> {
  const denied = adminOk(isAdmin);
  if (denied) return denied;
  const result = await fetchLeads(query, env);
  return {
    status: 200,
    body: {
      ok: true,
      source: result.source,
      connection: result.connection,
      last_synced_at: result.last_synced_at,
      message: result.message,
      leads: result.data,
      empty: !result.data?.length,
      metrics_trusted: Boolean(result.metrics_trusted),
    },
  };
}

export async function handleCrmInbox(isAdmin: boolean, env = process.env): Promise<CrmJsonResult> {
  const denied = adminOk(isAdmin);
  if (denied) return denied;
  const result = await fetchInbox(env);
  return {
    status: 200,
    body: {
      ok: true,
      source: result.source,
      connection: result.connection,
      last_synced_at: result.last_synced_at,
      message: result.message,
      items: result.data,
    },
  };
}

export async function handleCrmBookings(isAdmin: boolean, env = process.env): Promise<CrmJsonResult> {
  const denied = adminOk(isAdmin);
  if (denied) return denied;
  const result = await fetchBookings(env);
  return {
    status: 200,
    body: {
      ok: true,
      source: result.source,
      connection: result.connection,
      last_synced_at: result.last_synced_at,
      message: result.message,
      bookings: result.data,
    },
  };
}

export async function handleCrmCampaigns(isAdmin: boolean, env = process.env): Promise<CrmJsonResult> {
  const denied = adminOk(isAdmin);
  if (denied) return denied;
  const remote = await fetchCampaigns(env);
  const history = await fetchEmailHistory(env);
  let drafts: Awaited<ReturnType<typeof listDrafts>> = [];
  try {
    drafts = await listDrafts(env);
  } catch (err) {
    return {
      status: 503,
      body: {
        ok: false,
        message: storageFailureMessage(err, 'Could not load campaign drafts.'),
        templates: listTemplates(),
      },
    };
  }
  return {
    status: 200,
    body: {
      ok: true,
      source: remote.source,
      connection: remote.connection,
      last_synced_at: remote.last_synced_at,
      message: remote.message,
      campaigns: remote.data,
      email_history: history.data,
      drafts,
      templates: listTemplates(),
    },
  };
}

export async function handleCrmPreview(
  isAdmin: boolean,
  body: {
    recipient_ids?: Array<number | string>;
    subject?: string;
    body?: string;
    leads?: CrmLead[];
  },
  env = process.env,
): Promise<CrmJsonResult> {
  const denied = adminOk(isAdmin);
  if (denied) return denied;
  const ids = body.recipient_ids || [];
  if (!ids.length) {
    return { status: 400, body: { ok: false, message: 'Select at least one recipient to preview.' } };
  }
  const subject = String(body.subject || '');
  const text = String(body.body || '');
  let leads = body.leads || [];
  if (!leads.length) {
    const remote = await fetchLeads('', env);
    leads = remote.data || [];
  }
  const previews = buildPreviews(leads, ids, subject, text);
  const preview_token = createPreviewToken(ids, subject, text);
  return {
    status: 200,
    body: {
      ok: true,
      preview_token,
      selected_count: selectedCount(ids),
      previews,
      safety: safetySnapshot(env),
    },
  };
}

export async function handleCrmSaveDraft(
  isAdmin: boolean,
  body: {
    id?: string;
    name?: string;
    subject?: string;
    body?: string;
    template_id?: string | null;
    recipient_ids?: Array<number | string>;
  },
  env = process.env,
): Promise<CrmJsonResult> {
  const denied = adminOk(isAdmin);
  if (denied) return denied;
  try {
    const draft = await saveDraft(
      {
        id: body.id,
        name: String(body.name || 'Untitled campaign'),
        subject: String(body.subject || ''),
        body: String(body.body || ''),
        template_id: body.template_id ?? null,
        recipient_ids: body.recipient_ids || [],
      },
      env,
    );
    return { status: 200, body: { ok: true, source: 'durable_draft', draft } };
  } catch (err) {
    return {
      status: 503,
      body: {
        ok: false,
        message: storageFailureMessage(err, 'Could not save campaign draft.'),
      },
    };
  }
}

export async function handleCrmSendTest(
  isAdmin: boolean,
  body: { to?: string; subject?: string; body?: string },
  env = process.env,
): Promise<CrmJsonResult> {
  const denied = adminOk(isAdmin);
  if (denied) return denied;
  const to = String(body.to || env.ADMIN_EMAIL || env.BBL_EMAIL || env.BBLS_EMAIL || 'hello@bbl.studio');
  const result = sendTestDryRun(to, String(body.subject || ''), String(body.body || ''));
  return { status: 200, body: { ...result, safety: safetySnapshot(env) } };
}

export async function handleCrmSendCampaign(
  isAdmin: boolean,
  body: ManualSendRequest & { leads?: CrmLead[] },
  env = process.env,
): Promise<CrmJsonResult> {
  const denied = adminOk(isAdmin);
  if (denied) return denied;
  let leads = body.leads || [];
  if (!leads.length) {
    const remote = await fetchLeads('', env);
    leads = remote.data || [];
  }
  const result = await executeManualSend(body, leads, env);
  return {
    status: result.ok ? 200 : 400,
    body: { ...result, safety: safetySnapshot(env) },
  };
}

export async function handleCrmSettings(isAdmin: boolean, env = process.env): Promise<CrmJsonResult> {
  const denied = adminOk(isAdmin);
  if (denied) return denied;
  return { status: 200, body: { ok: true, ...(await crmConfigStatus(env)) } };
}

export function handleCrmSelectionMeta(
  isAdmin: boolean,
  body: { selected_ids?: Array<number | string> },
): CrmJsonResult {
  const denied = adminOk(isAdmin);
  if (denied) return denied;
  const selected_ids = body.selected_ids || [];
  return {
    status: 200,
    body: {
      ok: true,
      selected_ids: selected_ids.map(String),
      selected_count: selectedCount(selected_ids),
    },
  };
}

/** Machine sync ingest — Bearer secret, not admin cookie. */
export async function handleCrmSyncIngest(
  headers: { authorization?: string | null; 'x-bbl-crm-sync-key'?: string | null; 'x-bbl-crm-key'?: string | null },
  body: unknown,
  opts: { rawBytes?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CrmJsonResult> {
  const env = opts.env || process.env;
  const auth = authorizeCrmSync(headers, env);
  if (!auth.ok) return { status: auth.status, body: { ok: false, message: auth.message } };
  const result = await ingestCrmSync(body, { rawBytes: opts.rawBytes, env });
  if (!result.ok) return { status: result.status, body: { ok: false, message: result.message } };
  return {
    status: 200,
    body: {
      ok: true,
      message: result.message,
      last_synced_at: result.last_synced_at,
      counts: result.counts,
      connection: 'synced',
    },
  };
}

/** Lightweight sync health for Mac (Bearer). */
export async function handleCrmSyncStatus(
  headers: { authorization?: string | null; 'x-bbl-crm-sync-key'?: string | null; 'x-bbl-crm-key'?: string | null },
  env = process.env,
): Promise<CrmJsonResult> {
  const auth = authorizeCrmSync(headers, env);
  if (!auth.ok) return { status: auth.status, body: { ok: false, message: auth.message } };
  const conn = await connectionStatus(env);
  return {
    status: 200,
    body: {
      ok: true,
      connection: conn.status,
      last_synced_at: conn.last_synced_at,
      stale: conn.stale,
      message: conn.message,
    },
  };
}
