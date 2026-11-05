/**
 * Owner notification for Daily Review ready — NEVER prospect send.
 * Prefer Resend to ADMIN_EMAIL / hello@ when RESEND_API_KEY set; else log-only.
 */
import { dbWriteKv, dbReadKv, type CrmDbEnv } from './crm-db.js';

export const OWNER_NOTIFY_KV = 'outreach:owner_notify_log';

export type OwnerNotifyEnv = CrmDbEnv & {
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  ADMIN_EMAIL?: string;
  BBL_EMAIL?: string;
  APP_ORIGIN?: string;
  VERCEL?: string;
};

export type OwnerNotifyResult = {
  ok: boolean;
  channel: 'resend' | 'log' | 'skipped';
  to: string;
  subject: string;
  message_id?: string;
  error?: string;
};

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function ownerInbox(env: OwnerNotifyEnv): string {
  return String(env.ADMIN_EMAIL || env.BBL_EMAIL || 'hello@bbl.studio')
    .trim()
    .toLowerCase();
}

function adminOrigin(env: OwnerNotifyEnv): string {
  return String(env.APP_ORIGIN || (env.VERCEL ? 'https://www.bbl.studio' : 'http://127.0.0.1:4173')).replace(
    /\/$/,
    '',
  );
}

/**
 * Notify owner that Daily Review is ready.
 * Inject fetchImpl in tests — never hits network in CI.
 */
export async function notifyOwnerDailyReviewReady(
  opts: {
    day_key: string;
    qualified_count: number;
    discovered_count: number;
    message?: string;
  },
  env: OwnerNotifyEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<OwnerNotifyResult> {
  const to = ownerInbox(env);
  const reviewUrl = `${adminOrigin(env)}/admin/daily-review`;
  const subject = `BBL Daily Review ready — ${opts.qualified_count} leads (${opts.day_key} PT)`;
  const body = [
    'Daily Outreach prep finished (server-side cron).',
    '',
    `Day (PT): ${opts.day_key}`,
    `Qualified for review: ${opts.qualified_count}`,
    `Discovered pool: ${opts.discovered_count}`,
    opts.message || '',
    '',
    `Open Daily Review: ${reviewUrl}`,
    '',
    'No prospect emails were sent. Approve in the dashboard before any send.',
    '— BBL Studio Outreach Scheduler',
  ]
    .filter(Boolean)
    .join('\n');

  const apiKey = String(env.RESEND_API_KEY || '').trim();
  if (!apiKey) {
    console.log(`[owner-notify:log] to=${to}\n${subject}\n${body}`);
    await appendNotifyLog(
      { at: nowIso(), channel: 'log', to, subject, day_key: opts.day_key },
      env,
    );
    return { ok: true, channel: 'log', to, subject };
  }

  try {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: String(env.RESEND_FROM || 'BBL Studio <hello@bbl.studio>').trim(),
        to: [to],
        subject,
        text: body,
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!res.ok) {
      const error = json.message || `Resend ${res.status}`;
      await appendNotifyLog(
        { at: nowIso(), channel: 'resend', to, subject, day_key: opts.day_key, error },
        env,
      );
      return { ok: false, channel: 'resend', to, subject, error };
    }
    await appendNotifyLog(
      {
        at: nowIso(),
        channel: 'resend',
        to,
        subject,
        day_key: opts.day_key,
        message_id: json.id,
      },
      env,
    );
    return { ok: true, channel: 'resend', to, subject, message_id: json.id };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'notify failed';
    return { ok: false, channel: 'resend', to, subject, error };
  }
}

async function appendNotifyLog(
  row: Record<string, unknown>,
  env: OwnerNotifyEnv,
): Promise<void> {
  const prev = await dbReadKv<Record<string, unknown>[]>(OWNER_NOTIFY_KV, [], env);
  const next = [row, ...(Array.isArray(prev) ? prev : [])].slice(0, 50);
  await dbWriteKv(OWNER_NOTIFY_KV, next, env);
}
