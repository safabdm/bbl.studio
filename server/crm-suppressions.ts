/**
 * Durable email suppressions (Neon crm_kv + local file fallback).
 * Prefer Neon on serverless so opt-outs survive cold starts.
 */
import {
  dbReadKv,
  dbWriteKv,
  isDurableDbConfigured,
  requiresDurableDb,
  type CrmDbEnv,
} from './crm-db.js';
import {
  isEmailSuppressed as fileIsSuppressed,
  readSuppressions as readFileSuppressions,
  recordSuppression as recordFileSuppression,
  type UnsubscribeRecord,
  unsubscribeStorePath,
} from './unsubscribe.js';
import { readSnapshot, writeSnapshot, type CrmSyncStoreEnv } from './crm-sync-store.js';

export const SUPPRESSIONS_KV_KEY = 'email_suppressions';

export type SuppressionEnv = CrmDbEnv & CrmSyncStoreEnv & {
  UNSUBSCRIBE_STORE_PATH?: string;
  VERCEL?: string;
};

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function normalizeRecord(raw: Partial<UnsubscribeRecord> & { email?: string }): UnsubscribeRecord | null {
  const email = String(raw.email || '')
    .trim()
    .toLowerCase();
  if (!email.includes('@')) return null;
  return {
    email,
    lead_id: Number(raw.lead_id) || 0,
    reason: String(raw.reason || 'unsubscribe'),
    created_at: String(raw.created_at || nowIso()),
  };
}

export async function listDurableSuppressions(env: SuppressionEnv = process.env): Promise<UnsubscribeRecord[]> {
  if (isDurableDbConfigured(env)) {
    const fromKv = await dbReadKv<UnsubscribeRecord[]>(SUPPRESSIONS_KV_KEY, [], env);
    if (Array.isArray(fromKv) && fromKv.length) {
      return fromKv.map(normalizeRecord).filter((r): r is UnsubscribeRecord => Boolean(r));
    }
    // Fall through to snapshot suppressions when KV empty.
    try {
      const snap = await readSnapshot(env);
      if (snap) {
        const fromSnap = (snap.suppressions || [])
          .map((row) =>
            normalizeRecord({
              email: row.email,
              lead_id: Number(row.lead_id) || 0,
              reason: String(row.reason || 'unsubscribe'),
              created_at: String(row.created_at || nowIso()),
            }),
          )
          .filter((r): r is UnsubscribeRecord => Boolean(r));
        if (fromSnap.length) return fromSnap;
      }
    } catch {
      /* ignore */
    }
    return Array.isArray(fromKv) ? fromKv.map(normalizeRecord).filter((r): r is UnsubscribeRecord => Boolean(r)) : [];
  }
  if (requiresDurableDb(env)) return [];
  return readFileSuppressions(unsubscribeStorePath());
}

export async function isEmailDurablySuppressed(
  email: string,
  env: SuppressionEnv = process.env,
): Promise<boolean> {
  const needle = email.trim().toLowerCase();
  if (!needle) return false;
  const rows = await listDurableSuppressions(env);
  if (rows.some((row) => row.email === needle)) return true;
  if (!isDurableDbConfigured(env) && !requiresDurableDb(env)) {
    return fileIsSuppressed(needle);
  }
  return false;
}

export async function recordDurableSuppression(
  email: string,
  leadId: number,
  reason = 'unsubscribe',
  env: SuppressionEnv = process.env,
): Promise<{ created: boolean; record: UnsubscribeRecord }> {
  const normalized = email.trim().toLowerCase();
  const existing = await listDurableSuppressions(env);
  const prior = existing.find((row) => row.email === normalized);
  if (prior) return { created: false, record: prior };

  const record: UnsubscribeRecord = {
    email: normalized,
    lead_id: leadId,
    reason,
    created_at: nowIso(),
  };
  const next = [...existing, record];

  if (isDurableDbConfigured(env)) {
    await dbWriteKv(SUPPRESSIONS_KV_KEY, next, env);
    try {
      const snap = await readSnapshot(env);
      if (snap) {
        const merged = [...(snap.suppressions || [])];
        if (!merged.some((row) => String(row.email || '').toLowerCase() === normalized)) {
          merged.push({
            email: normalized,
            lead_id: leadId,
            reason,
            created_at: record.created_at,
          });
          await writeSnapshot({ ...snap, schema_version: 1, suppressions: merged }, env);
        }
      }
    } catch {
      /* snapshot optional */
    }
    return { created: true, record };
  }

  if (requiresDurableDb(env)) {
    // Fail closed — never pretend an opt-out persisted when Neon is missing.
    throw new Error(
      'CRM_DATABASE_URL is required for durable suppressions on serverless. Opt-out was not recorded.',
    );
  }

  return recordFileSuppression(normalized, leadId, reason);
}
