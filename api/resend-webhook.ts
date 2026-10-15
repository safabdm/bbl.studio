/**
 * Public Resend webhook ingress for Vercel.
 * Verifies Svix signatures, enforces idempotency, forwards raw body to the
 * lead agent when LEAD_AGENT_RESEND_WEBHOOK_URL is set.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export type ResendWebhookEnv = {
  RESEND_WEBHOOK_SECRET?: string;
  LEAD_AGENT_RESEND_WEBHOOK_URL?: string;
  RESEND_WEBHOOK_IDEMPOTENCY_PATH?: string;
};

export type WebhookProcessResult = {
  ok: boolean;
  status: number;
  duplicate?: boolean;
  forwarded?: boolean;
  stored?: boolean;
  event_id?: string | null;
  type?: string | null;
  message?: string;
};

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Extract whsec_ payload (base64) from Resend/Svix signing secret. */
export function webhookSecretBytes(secret: string): Buffer {
  const trimmed = secret.trim();
  if (trimmed.startsWith('whsec_')) {
    return Buffer.from(trimmed.slice('whsec_'.length), 'base64');
  }
  return Buffer.from(trimmed, 'utf8');
}

/**
 * Verify Resend/Svix signature headers against the raw body.
 * Accepts signatures like "v1,<base64>" (comma-separated list).
 */
export function verifyResendSignature(opts: {
  body: string;
  svixId: string;
  svixTimestamp: string;
  svixSignature: string;
  secret: string;
  /** Max age of timestamp in seconds (default 5 minutes). */
  maxSkewSeconds?: number;
  nowMs?: number;
}): boolean {
  const { body, svixId, svixTimestamp, svixSignature, secret } = opts;
  if (!secret || !svixId || !svixTimestamp || !svixSignature) return false;
  const ts = Number(svixTimestamp);
  if (!Number.isFinite(ts)) return false;
  const now = opts.nowMs ?? Date.now();
  const skew = (opts.maxSkewSeconds ?? 300) * 1000;
  if (Math.abs(now - ts * 1000) > skew) return false;

  const signed = `${svixId}.${svixTimestamp}.${body}`;
  const expected = createHmac('sha256', webhookSecretBytes(secret)).update(signed).digest('base64');
  const parts = svixSignature.split(/\s+/).flatMap((piece) => piece.split(','));
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (part === 'v1' && parts[i + 1]) {
      if (safeEqual(parts[i + 1], expected)) return true;
      i += 1;
      continue;
    }
    if (part.startsWith('v1=')) {
      if (safeEqual(part.slice(3), expected)) return true;
    }
  }
  // Also accept bare base64 signatures for simpler tests.
  if (safeEqual(svixSignature.trim(), expected)) return true;
  return false;
}

function idempotencyPath(env: ResendWebhookEnv) {
  return resolve(root, env.RESEND_WEBHOOK_IDEMPOTENCY_PATH || './data/resend-webhook-events.json');
}

export function readSeenEventIds(env: ResendWebhookEnv = process.env): string[] {
  const path = idempotencyPath(env);
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as { ids?: string[] };
    return Array.isArray(data.ids) ? data.ids : [];
  } catch {
    return [];
  }
}

export function rememberEventId(eventId: string, env: ResendWebhookEnv = process.env) {
  const path = idempotencyPath(env);
  const ids = readSeenEventIds(env);
  if (ids.includes(eventId)) return false;
  ids.unshift(eventId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ids: ids.slice(0, 5000) }, null, 2)}\n`, 'utf8');
  return true;
}

export function parseResendEvent(body: string): { event_id: string | null; type: string | null } {
  try {
    const json = JSON.parse(body) as { type?: string; data?: { email_id?: string }; created_at?: string };
    const type = json.type || null;
    const emailId = json.data?.email_id || '';
    // Prefer Svix id from caller; body may not include a stable id.
    const event_id = emailId && type ? `${type}:${emailId}:${json.created_at || ''}` : null;
    return { event_id, type };
  } catch {
    return { event_id: null, type: null };
  }
}

export async function processResendWebhook(opts: {
  body: string;
  headers: {
    'svix-id'?: string | string[] | undefined;
    'svix-timestamp'?: string | string[] | undefined;
    'svix-signature'?: string | string[] | undefined;
  };
  env?: ResendWebhookEnv;
  fetchImpl?: typeof fetch;
}): Promise<WebhookProcessResult> {
  const env = opts.env || process.env;
  const secret = env.RESEND_WEBHOOK_SECRET || '';
  if (!secret) {
    return { ok: false, status: 503, message: 'RESEND_WEBHOOK_SECRET is not configured.' };
  }

  const header = (value: string | string[] | undefined) =>
    Array.isArray(value) ? value[0] || '' : value || '';

  const svixId = header(opts.headers['svix-id']);
  const svixTimestamp = header(opts.headers['svix-timestamp']);
  const svixSignature = header(opts.headers['svix-signature']);

  const valid = verifyResendSignature({
    body: opts.body,
    svixId,
    svixTimestamp,
    svixSignature,
    secret,
  });
  if (!valid) {
    return { ok: false, status: 401, message: 'Invalid Resend webhook signature.' };
  }

  const parsed = parseResendEvent(opts.body);
  const eventId = svixId || parsed.event_id;
  if (eventId && readSeenEventIds(env).includes(eventId)) {
    return {
      ok: true,
      status: 200,
      duplicate: true,
      event_id: eventId,
      type: parsed.type,
      message: 'Duplicate event ignored.',
    };
  }

  if (eventId) rememberEventId(eventId, env);

  const forwardUrl = (env.LEAD_AGENT_RESEND_WEBHOOK_URL || '').trim();
  let forwarded = false;
  if (forwardUrl) {
    const fetchImpl = opts.fetchImpl || fetch;
    try {
      const response = await fetchImpl(forwardUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'svix-id': svixId,
          'svix-timestamp': svixTimestamp,
          'svix-signature': svixSignature,
        },
        body: opts.body,
      });
      forwarded = response.ok;
      if (!response.ok) {
        return {
          ok: false,
          status: 502,
          stored: Boolean(eventId),
          forwarded: false,
          event_id: eventId,
          type: parsed.type,
          message: `Lead agent webhook forward failed (${response.status}).`,
        };
      }
    } catch (error) {
      return {
        ok: false,
        status: 502,
        stored: Boolean(eventId),
        forwarded: false,
        event_id: eventId,
        type: parsed.type,
        message: error instanceof Error ? error.message : 'Forward failed.',
      };
    }
  }

  return {
    ok: true,
    status: 200,
    duplicate: false,
    forwarded,
    stored: Boolean(eventId),
    event_id: eventId,
    type: parsed.type,
    message: forwarded
      ? 'Webhook verified and forwarded to lead agent.'
      : 'Webhook verified and recorded. Set LEAD_AGENT_RESEND_WEBHOOK_URL to forward.',
  };
}
