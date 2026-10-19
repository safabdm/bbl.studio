/**
 * HMAC-signed campaign preview tokens (SESSION_SECRET), 2h expiry.
 * Stateless — survives serverless cold starts; no shared memory required.
 */
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

export const PREVIEW_TTL_MS = 2 * 60 * 60 * 1000;

export type PreviewTokenPayload = {
  recipient_ids: string[];
  subject: string;
  body_hash: string;
  created_at: number;
  exp: number;
};

export type PreviewTokenEnv = {
  SESSION_SECRET?: string;
};

function sessionSecret(env: PreviewTokenEnv = process.env): string {
  const secret = String(env.SESSION_SECRET || '').trim();
  if (!secret) {
    throw new Error('SESSION_SECRET is required to sign campaign preview tokens.');
  }
  return secret;
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromB64url(input: string): Buffer {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(b64, 'base64');
}

function sign(payloadB64: string, secret: string): string {
  return createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

export function hashBody(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

export function createSignedPreviewToken(
  recipientIds: Array<number | string>,
  subject: string,
  body: string,
  env: PreviewTokenEnv = process.env,
  now = Date.now(),
): string {
  const secret = sessionSecret(env);
  const payload: PreviewTokenPayload = {
    recipient_ids: recipientIds.map(String).sort(),
    subject,
    body_hash: hashBody(body),
    created_at: now,
    exp: now + PREVIEW_TTL_MS,
  };
  const payloadB64 = b64url(JSON.stringify(payload));
  const sig = sign(payloadB64, secret);
  return `${payloadB64}.${sig}`;
}

export function verifySignedPreviewToken(
  token: string | undefined,
  env: PreviewTokenEnv = process.env,
  now = Date.now(),
): PreviewTokenPayload | null {
  if (!token || !token.includes('.')) return null;
  let secret: string;
  try {
    secret = sessionSecret(env);
  } catch {
    return null;
  }
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) return null;
  const expected = sign(payloadB64, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const raw = JSON.parse(fromB64url(payloadB64).toString('utf8')) as PreviewTokenPayload;
    if (!raw || !Array.isArray(raw.recipient_ids) || typeof raw.exp !== 'number') return null;
    if (now > raw.exp) return null;
    if (now - (raw.created_at || 0) > PREVIEW_TTL_MS) return null;
    return {
      recipient_ids: raw.recipient_ids.map(String).sort(),
      subject: String(raw.subject || ''),
      body_hash: String(raw.body_hash || ''),
      created_at: Number(raw.created_at) || 0,
      exp: Number(raw.exp) || 0,
    };
  } catch {
    return null;
  }
}

export function previewMatchesComposition(
  session: PreviewTokenPayload,
  recipientIds: Array<number | string>,
  subject: string,
  body: string,
): boolean {
  const sameRecipients =
    session.recipient_ids.join(',') === [...recipientIds].map(String).sort().join(',');
  const sameBody = session.body_hash === hashBody(body);
  const sameSubject = session.subject === subject;
  return sameRecipients && sameBody && sameSubject;
}
