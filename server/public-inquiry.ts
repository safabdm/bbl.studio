/**
 * Public website inquiry → CRM inbox snapshot.
 * Thin wire only: honeypot + rate limit + append inbox item. No outreach send.
 */
import { randomUUID } from 'node:crypto';
import type { CrmInboxItem } from './crm-types.js';
import { emptySnapshot, readSnapshot, writeSnapshot, type CrmSyncStoreEnv } from './crm-sync-store.js';

const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_WINDOW = 5;

type RateBucket = { count: number; resetAt: number };
const buckets = new Map<string, RateBucket>();

export type InquiryInput = {
  name?: string;
  email?: string;
  service?: string;
  message?: string;
  website?: string; // honeypot
};

export type InquiryResult =
  | { ok: true; status: 200; message: string }
  | { ok: false; status: 400 | 429 | 503; message: string };

function clientKey(ip: string) {
  return ip || 'unknown';
}

export function checkInquiryRateLimit(ip: string, now = Date.now()): boolean {
  const key = clientKey(ip);
  const current = buckets.get(key);
  if (!current || now >= current.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (current.count >= MAX_PER_WINDOW) return false;
  current.count += 1;
  return true;
}

/** Test helper */
export function resetInquiryRateLimit() {
  buckets.clear();
}

export async function submitPublicInquiry(
  input: InquiryInput,
  ip: string,
  env: CrmSyncStoreEnv = process.env,
): Promise<InquiryResult> {
  // Honeypot — pretend success
  if (String(input.website || '').trim()) {
    return { ok: true, status: 200, message: 'Thanks — we received your note.' };
  }

  if (!checkInquiryRateLimit(ip)) {
    return { ok: false, status: 429, message: 'Too many messages. Please try again later or email hello@bbl.studio.' };
  }

  const name = String(input.name || '').trim().slice(0, 100);
  const email = String(input.email || '').trim().toLowerCase().slice(0, 200);
  const service = String(input.service || '').trim().slice(0, 120);
  const message = String(input.message || '').trim().slice(0, 2000);

  if (!name || !email || !message) {
    return { ok: false, status: 400, message: 'Name, email, and message are required.' };
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return { ok: false, status: 400, message: 'Please enter a valid email address.' };
  }

  const now = new Date().toISOString();
  const entry: CrmInboxItem = {
    id: `web_${randomUUID()}`,
    from_email: email,
    lead_id: null,
    subject: `Website inquiry${service ? `: ${service}` : ''} — ${name}`,
    snippet: message.slice(0, 280),
    received_at: now,
    source: 'website_form',
  };

  try {
    const existing = (await readSnapshot(env)) || emptySnapshot();
    const inbox = [entry, ...(existing.inbox || [])].filter(
      (item, index, arr) => arr.findIndex((row) => row.id === item.id) === index,
    ).slice(0, 1000);
    await writeSnapshot({ ...existing, inbox }, env);
  } catch {
    return {
      ok: false,
      status: 503,
      message: 'Inbox is temporarily unavailable. Email hello@bbl.studio or book a consultation.',
    };
  }

  return { ok: true, status: 200, message: 'Thanks — we received your note. Prefer a call? Book a consultation.' };
}
