/**
 * Public Resend webhook ingress for Vercel.
 * Verifies Svix signatures, enforces idempotency, applies delivery/bounce/
 * complaint/reply status onto the CRM sync snapshot, and optionally forwards
 * the raw body when LEAD_AGENT_RESEND_WEBHOOK_URL is set (Mac is usually offline).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { resolveProjectRoot } from '../server/project-root.js';

/** Lazy — avoid pulling Neon/CRM into unrelated catch-all cold starts. */
async function crmDb() {
  return import('../server/crm-db.js');
}
async function crmWebhookApply() {
  return import('../server/crm-webhook-apply.js');
}

function projectRoot() {
  return resolveProjectRoot(import.meta.url);
}

export type ResendWebhookEnv = {
  RESEND_WEBHOOK_SECRET?: string;
  LEAD_AGENT_RESEND_WEBHOOK_URL?: string;
  RESEND_WEBHOOK_IDEMPOTENCY_PATH?: string;
  CRM_SYNC_STORE_PATH?: string;
  CRM_DATABASE_URL?: string;
  DATABASE_URL?: string;
  CRM_DATABASE_MEMORY?: string;
  VERCEL?: string;
};

export type WebhookProcessResult = {
  ok: boolean;
  status: number;
  duplicate?: boolean;
  forwarded?: boolean;
  stored?: boolean;
  applied_to_crm?: boolean;
  matched_leads?: number;
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
  return resolve(projectRoot(), env.RESEND_WEBHOOK_IDEMPOTENCY_PATH || './data/resend-webhook-events.json');
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
  const db = await crmDb();
  const useDurableEvents = db.isDurableDbConfigured(env);

  if (eventId) {
    const seen = useDurableEvents
      ? await db.dbHasWebhookEvent(eventId, env)
      : readSeenEventIds(env).includes(eventId);
    if (seen) {
      return {
        ok: true,
        status: 200,
        duplicate: true,
        event_id: eventId,
        type: parsed.type,
        message: 'Duplicate event ignored.',
      };
    }
  }

  if (eventId) {
    if (useDurableEvents) {
      const inserted = await db.dbRememberWebhookEvent(eventId, parsed.type, parsed, env);
      if (!inserted) {
        return {
          ok: true,
          status: 200,
          duplicate: true,
          event_id: eventId,
          type: parsed.type,
          message: 'Duplicate event ignored.',
        };
      }
    } else {
      rememberEventId(eventId, env);
    }
  }

  // Primary path: update website CRM snapshot (Mac is outbound-only / often offline).
  const { applyResendEventToSnapshot } = await crmWebhookApply();
  const applied = await applyResendEventToSnapshot(opts.body, env);

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
      // Forward failure is non-fatal once the website snapshot is updated.
      if (!response.ok) {
        return {
          ok: true,
          status: 200,
          stored: Boolean(eventId),
          forwarded: false,
          applied_to_crm: applied.applied,
          matched_leads: applied.matched_leads,
          event_id: eventId,
          type: parsed.type,
          message: `Webhook applied to CRM snapshot; optional forward failed (${response.status}).`,
        };
      }
    } catch (error) {
      return {
        ok: true,
        status: 200,
        stored: Boolean(eventId),
        forwarded: false,
        applied_to_crm: applied.applied,
        matched_leads: applied.matched_leads,
        event_id: eventId,
        type: parsed.type,
        message: `Webhook applied to CRM snapshot; optional forward error: ${
          error instanceof Error ? error.message : 'Forward failed.'
        }`,
      };
    }
  }

  return {
    ok: true,
    status: 200,
    duplicate: false,
    forwarded,
    stored: Boolean(eventId),
    applied_to_crm: applied.applied,
    matched_leads: applied.matched_leads,
    event_id: eventId,
    type: parsed.type,
    message: forwarded
      ? 'Webhook verified, applied to CRM snapshot, and forwarded.'
      : 'Webhook verified and applied to CRM snapshot. Optional LEAD_AGENT_RESEND_WEBHOOK_URL not set (Mac outbound-only).',
  };
}
