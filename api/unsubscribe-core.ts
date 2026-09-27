import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Signed unsubscribe helpers for Vercel serverless (api/).
 * Must match server/unsubscribe.ts + bbl_studio_agent email_outreach:
 *   HMAC-SHA256(secret, `${lead_id}:${email.lower}`) hex digest, first 32 chars.
 */

export type UnsubscribeRecord = {
  email: string;
  lead_id: number;
  reason: string;
  created_at: string;
};

export type UnsubscribeResult =
  | { ok: true; already: boolean; email: string; lead_id: number }
  | {
      ok: false;
      error: 'missing_params' | 'invalid_lead_id' | 'invalid_token' | 'misconfigured';
      message: string;
    };

function unsubscribeSecret(): string {
  return (process.env.UNSUBSCRIBE_SECRET || '').trim();
}

function unsubscribeStorePath(): string {
  if (process.env.UNSUBSCRIBE_STORE_PATH) {
    return resolve(process.env.UNSUBSCRIBE_STORE_PATH);
  }
  if (process.env.VERCEL) {
    return '/tmp/bbls-email-suppressions.json';
  }
  return resolve(process.cwd(), 'data/email-suppressions.json');
}

function makeUnsubscribeToken(email: string, leadId: number, secret = unsubscribeSecret()): string {
  const msg = `${leadId}:${email.trim().toLowerCase()}`;
  return createHmac('sha256', secret).update(msg).digest('hex').slice(0, 32);
}

function tokensMatch(left: string, right: string): boolean {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function verifyUnsubscribeToken(
  email: string,
  leadId: number,
  token: string,
  secret = unsubscribeSecret(),
): boolean {
  if (!secret) return false;
  if (!email || !Number.isFinite(leadId) || leadId <= 0) return false;
  if (!token || token.length !== 32) return false;
  const expected = makeUnsubscribeToken(email, leadId, secret);
  return tokensMatch(token, expected);
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function readSuppressions(storePath = unsubscribeStorePath()): UnsubscribeRecord[] {
  if (!existsSync(storePath)) return [];
  try {
    const raw = JSON.parse(readFileSync(storePath, 'utf8')) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is UnsubscribeRecord => {
      return Boolean(item && typeof item === 'object' && typeof (item as UnsubscribeRecord).email === 'string');
    });
  } catch {
    return [];
  }
}

function writeSuppressions(records: UnsubscribeRecord[], storePath = unsubscribeStorePath()): void {
  mkdirSync(dirname(storePath), { recursive: true });
  writeFileSync(storePath, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
}

function recordSuppression(
  email: string,
  leadId: number,
  reason = 'unsubscribe',
  storePath = unsubscribeStorePath(),
): { created: boolean; record: UnsubscribeRecord } {
  const normalized = email.trim().toLowerCase();
  const existing = readSuppressions(storePath);
  const prior = existing.find((row) => row.email === normalized);
  if (prior) {
    return { created: false, record: prior };
  }
  const record: UnsubscribeRecord = {
    email: normalized,
    lead_id: leadId,
    reason,
    created_at: nowIso(),
  };
  writeSuppressions([...existing, record], storePath);
  return { created: true, record };
}

function parseUnsubscribeInput(input: {
  email?: string | null;
  lead_id?: string | number | null;
  token?: string | null;
}):
  | { ok: true; params: { email: string; leadId: number; token: string } }
  | { ok: false; error: 'missing_params' | 'invalid_lead_id'; message: string } {
  const email = String(input.email || '').trim().toLowerCase();
  const token = String(input.token || '').trim();
  const leadRaw = input.lead_id;
  if (!email || !token || leadRaw === undefined || leadRaw === null || String(leadRaw).trim() === '') {
    return { ok: false, error: 'missing_params', message: 'Missing email, lead_id, or token.' };
  }
  const leadId = typeof leadRaw === 'number' ? leadRaw : Number.parseInt(String(leadRaw), 10);
  if (!Number.isFinite(leadId) || leadId <= 0) {
    return { ok: false, error: 'invalid_lead_id', message: 'Invalid lead_id.' };
  }
  return { ok: true, params: { email, leadId, token } };
}

export function processUnsubscribe(
  input: {
    email?: string | null;
    lead_id?: string | number | null;
    token?: string | null;
  },
  storePath = unsubscribeStorePath(),
): UnsubscribeResult {
  if (!unsubscribeSecret()) {
    return { ok: false, error: 'misconfigured', message: 'Unsubscribe is not configured.' };
  }
  const parsed = parseUnsubscribeInput(input);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, message: parsed.message };
  }
  const { email, leadId, token } = parsed.params;
  if (!verifyUnsubscribeToken(email, leadId, token)) {
    return { ok: false, error: 'invalid_token', message: 'This unsubscribe link is invalid or expired.' };
  }
  const { created, record } = recordSuppression(email, leadId, 'unsubscribe', storePath);
  return { ok: true, already: !created, email: record.email, lead_id: record.lead_id };
}

export function authorizeSuppressionList(headerValue: string | null | undefined): boolean {
  const secret = unsubscribeSecret();
  if (!secret) return false;
  const raw = String(headerValue || '').trim();
  if (!raw) return false;
  const token = raw.toLowerCase().startsWith('bearer ') ? raw.slice(7).trim() : raw;
  return tokensMatch(token, secret);
}
