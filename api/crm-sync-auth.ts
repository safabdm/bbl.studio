/**
 * Fail-closed CRM sync auth for Vercel serverless.
 * Lives under `api/` with no `server/` imports so catch-all boot cannot
 * crash before 401/503 responses are possible.
 */
import { timingSafeEqual } from 'node:crypto';

export type CrmSyncAuthEnv = {
  CRM_SYNC_SECRET?: string;
  LEAD_AGENT_CRM_SECRET?: string;
};

export type CrmSyncAuthHeaders = {
  authorization?: string | null;
  'x-bbl-crm-sync-key'?: string | null;
  'x-bbl-crm-key'?: string | null;
};

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function crmSyncSecret(env: CrmSyncAuthEnv = process.env): string {
  return (env.CRM_SYNC_SECRET || env.LEAD_AGENT_CRM_SECRET || '').trim();
}

export function authorizeCrmSync(
  headers: CrmSyncAuthHeaders,
  env: CrmSyncAuthEnv = process.env,
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
