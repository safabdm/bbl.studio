/**
 * HTTP handlers for discovery automation (admin + cron).
 * Live email send is never enabled from these endpoints.
 */
import type { CrmJsonResult } from './crm-api.js';
import { listDiscoveredLeads, listDiscoveryRuns } from './crm-discovery-store.js';
import {
  getDiscoveryDashboard,
  pauseDiscovery,
  resumeDiscovery,
  runDiscoveryCycle,
  type DiscoveryRunnerEnv,
} from './crm-discovery-runner.js';
import { enrichNeedsEmailLeads } from './crm-discovery-enrich.js';
import { safetySnapshot } from './crm-safety.js';

function adminOk(isAdmin: boolean): CrmJsonResult | null {
  if (isAdmin) return null;
  return { status: 401, body: { ok: false, message: 'Sign in required.' } };
}

export function authorizeCron(
  headers: { authorization?: string | null },
  env: DiscoveryRunnerEnv = process.env,
): { ok: true } | { ok: false; status: number; message: string } {
  const secret = String(env.CRON_SECRET || '').trim();
  if (!secret) {
    return { ok: false, status: 401, message: 'CRON_SECRET is not configured.' };
  }
  const auth = String(headers.authorization || '');
  if (auth !== `Bearer ${secret}`) {
    return { ok: false, status: 401, message: 'Unauthorized cron.' };
  }
  return { ok: true };
}

export async function handleDiscoveryStatus(
  isAdmin: boolean,
  env: DiscoveryRunnerEnv = process.env,
): Promise<CrmJsonResult> {
  const denied = adminOk(isAdmin);
  if (denied) return denied;
  const dash = await getDiscoveryDashboard(env);
  return { status: 200, body: dash };
}

export async function handleDiscoveryRun(
  isAdmin: boolean,
  body: { max_results?: number; enrich?: boolean; ignore_pause?: boolean } = {},
  env: DiscoveryRunnerEnv = process.env,
): Promise<CrmJsonResult> {
  const denied = adminOk(isAdmin);
  if (denied) return denied;
  const run = await runDiscoveryCycle({
    trigger: 'manual',
    max_results: body.max_results,
    enrich: body.enrich,
    ignore_pause: Boolean(body.ignore_pause),
    env,
  });
  const dash = await getDiscoveryDashboard(env);
  return {
    status: run.status === 'failed' ? 502 : 200,
    body: {
      ok: run.status !== 'failed',
      run,
      automation: dash.automation,
      counts: dash.counts,
      safety: { ...safetySnapshot(env), FOLLOWUPS_LIVE: false, live_email_send: false },
      message: run.message,
    },
  };
}

export async function handleDiscoveryPause(
  isAdmin: boolean,
  body: { reason?: string } = {},
  env: DiscoveryRunnerEnv = process.env,
): Promise<CrmJsonResult> {
  const denied = adminOk(isAdmin);
  if (denied) return denied;
  const automation = await pauseDiscovery(String(body.reason || 'Paused by admin'), env);
  return { status: 200, body: { ok: true, automation, message: 'Discovery paused.' } };
}

export async function handleDiscoveryResume(
  isAdmin: boolean,
  env: DiscoveryRunnerEnv = process.env,
): Promise<CrmJsonResult> {
  const denied = adminOk(isAdmin);
  if (denied) return denied;
  const automation = await resumeDiscovery(env);
  return { status: 200, body: { ok: true, automation, message: 'Discovery resumed.' } };
}

export async function handleDiscoveryLogs(
  isAdmin: boolean,
  limit = 20,
  env: DiscoveryRunnerEnv = process.env,
): Promise<CrmJsonResult> {
  const denied = adminOk(isAdmin);
  if (denied) return denied;
  const runs = await listDiscoveryRuns(limit, env);
  return { status: 200, body: { ok: true, runs, live_email_send: false } };
}

export async function handleDiscoveryQualified(
  isAdmin: boolean,
  limit = 50,
  env: DiscoveryRunnerEnv = process.env,
): Promise<CrmJsonResult> {
  const denied = adminOk(isAdmin);
  if (denied) return denied;
  const leads = await listDiscoveredLeads({ status: 'qualified', limit }, env);
  return {
    status: 200,
    body: {
      ok: true,
      leads,
      count: leads.length,
      message: leads.length
        ? `${leads.length} qualified opportunities (owner approval required before any send).`
        : 'No qualified discoveries yet.',
      live_email_send: false,
    },
  };
}

export async function handleDiscoveryEnrich(
  isAdmin: boolean,
  body: { limit?: number } = {},
  env: DiscoveryRunnerEnv = process.env,
): Promise<CrmJsonResult> {
  const denied = adminOk(isAdmin);
  if (denied) return denied;
  const result = await enrichNeedsEmailLeads({ limit: body.limit, env });
  return { status: 200, body: { ...result, live_email_send: false } };
}

/** Vercel Cron — Bearer CRON_SECRET. Idempotent daily key. */
export async function handleDiscoveryCron(
  headers: { authorization?: string | null },
  env: DiscoveryRunnerEnv = process.env,
): Promise<CrmJsonResult> {
  const auth = authorizeCron(headers, env);
  if (!auth.ok) return { status: auth.status, body: { ok: false, message: auth.message } };
  const run = await runDiscoveryCycle({ trigger: 'cron', env });
  return {
    status: run.status === 'failed' ? 502 : 200,
    body: {
      ok: run.status !== 'failed',
      run,
      live_email_send: false,
      message: run.message,
    },
  };
}
