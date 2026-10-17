/**
 * Durable CRM store backend — Neon / Vercel Postgres.
 *
 * Why Neon (not Turso / Blob / KV):
 * - First-class Vercel Postgres integration, free tier, SQL transactions
 * - Survives deploys / cold starts / concurrent serverless invocations
 * - JSONB snapshot + webhook event table is enough for current CRM volume
 * - Turso would fit edge SQLite, but adds another vendor; portal already uses
 *   node:sqlite only locally (:memory: on Vercel) — Neon is the production gap
 * - Blob/KV are weaker for transactional merge of webhook vs Mac sync
 *
 * Credentials: CRM_DATABASE_URL (preferred) or DATABASE_URL — server-side only.
 */
import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import type { CrmSyncSnapshot } from './crm-types.js';
import { emptySnapshot } from './crm-sync-store-empty.js';

export type CrmDbEnv = {
  CRM_DATABASE_URL?: string;
  DATABASE_URL?: string;
  VERCEL?: string;
  /** Test-only in-memory durable backend. */
  CRM_DATABASE_MEMORY?: string;
};

type Sql = NeonQueryFunction<false, false>;

type MemoryDb = {
  snapshot: CrmSyncSnapshot | null;
  events: Set<string>;
  kv: Map<string, unknown>;
  ready: boolean;
};

const memoryBanks = new Map<string, MemoryDb>();

export function crmDatabaseUrl(env: CrmDbEnv = process.env): string {
  return (env.CRM_DATABASE_URL || env.DATABASE_URL || '').trim();
}

export function isMemoryDb(env: CrmDbEnv = process.env): boolean {
  const url = crmDatabaseUrl(env);
  return url === 'memory://crm' || env.CRM_DATABASE_MEMORY === '1';
}

export function isDurableDbConfigured(env: CrmDbEnv = process.env): boolean {
  return Boolean(crmDatabaseUrl(env)) || isMemoryDb(env);
}

/** On Vercel, durable DB is required — /tmp is not used. */
export function requiresDurableDb(env: CrmDbEnv = process.env): boolean {
  return Boolean(env.VERCEL);
}

function memoryBank(env: CrmDbEnv): MemoryDb {
  const key = crmDatabaseUrl(env) || 'memory://crm';
  let bank = memoryBanks.get(key);
  if (!bank) {
    bank = { snapshot: null, events: new Set(), kv: new Map(), ready: false };
    memoryBanks.set(key, bank);
  }
  return bank;
}

/** Test helper */
export function resetMemoryCrmDb(env: CrmDbEnv = process.env): void {
  const key = crmDatabaseUrl(env) || 'memory://crm';
  memoryBanks.delete(key);
}

let schemaReady = false;
let sqlClient: Sql | null = null;

function getSql(env: CrmDbEnv): Sql {
  const url = crmDatabaseUrl(env);
  if (!url || url === 'memory://crm') {
    throw new Error('CRM_DATABASE_URL is not a Postgres connection string.');
  }
  if (!sqlClient) sqlClient = neon(url);
  return sqlClient;
}

export async function ensureCrmSchema(env: CrmDbEnv = process.env): Promise<void> {
  if (isMemoryDb(env)) {
    memoryBank(env).ready = true;
    return;
  }
  if (schemaReady) return;
  const sql = getSql(env);
  await sql`
    CREATE TABLE IF NOT EXISTS crm_state (
      id TEXT PRIMARY KEY,
      snapshot JSONB NOT NULL,
      last_synced_at TIMESTAMPTZ NULL,
      source_host TEXT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS crm_webhook_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NULL,
      payload JSONB NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS crm_kv (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  schemaReady = true;
}

/** Durable JSON blob helpers — campaign drafts, send logs, etc. Never use local ./data on Vercel. */
export async function dbReadKv<T>(key: string, fallback: T, env: CrmDbEnv = process.env): Promise<T> {
  await ensureCrmSchema(env);
  if (isMemoryDb(env)) {
    const bank = memoryBank(env);
    if (!bank.kv.has(key)) return fallback;
    return structuredClone(bank.kv.get(key)) as T;
  }
  const sql = getSql(env);
  const rows = await sql`
    SELECT value FROM crm_kv WHERE key = ${key} LIMIT 1
  `;
  const row = rows[0] as { value?: T } | undefined;
  if (row?.value === undefined || row?.value === null) return fallback;
  return row.value;
}

export async function dbWriteKv(key: string, value: unknown, env: CrmDbEnv = process.env): Promise<void> {
  await ensureCrmSchema(env);
  if (isMemoryDb(env)) {
    memoryBank(env).kv.set(key, structuredClone(value));
    return;
  }
  const sql = getSql(env);
  const payload = JSON.stringify(value);
  await sql`
    INSERT INTO crm_kv (key, value, updated_at)
    VALUES (${key}, ${payload}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET
      value = EXCLUDED.value,
      updated_at = now()
  `;
}

export async function dbReadSnapshot(env: CrmDbEnv = process.env): Promise<CrmSyncSnapshot | null> {
  await ensureCrmSchema(env);
  if (isMemoryDb(env)) {
    const bank = memoryBank(env);
    return bank.snapshot ? structuredClone(bank.snapshot) : null;
  }
  const sql = getSql(env);
  const rows = await sql`
    SELECT snapshot FROM crm_state WHERE id = 'default' LIMIT 1
  `;
  const row = rows[0] as { snapshot?: CrmSyncSnapshot } | undefined;
  if (!row?.snapshot) return null;
  const snap = row.snapshot;
  return {
    ...emptySnapshot(),
    ...snap,
    schema_version: 1,
    leads: Array.isArray(snap.leads) ? snap.leads : [],
    campaigns: Array.isArray(snap.campaigns) ? snap.campaigns : [],
    email_history: Array.isArray(snap.email_history) ? snap.email_history : [],
    inbox: Array.isArray(snap.inbox) ? snap.inbox : [],
    bookings: Array.isArray(snap.bookings) ? snap.bookings : [],
    suppressions: Array.isArray(snap.suppressions) ? snap.suppressions : [],
  };
}

export async function dbWriteSnapshot(
  snapshot: CrmSyncSnapshot,
  env: CrmDbEnv = process.env,
): Promise<void> {
  await ensureCrmSchema(env);
  if (isMemoryDb(env)) {
    memoryBank(env).snapshot = structuredClone(snapshot);
    return;
  }
  const sql = getSql(env);
  const payload = JSON.stringify(snapshot);
  await sql`
    INSERT INTO crm_state (id, snapshot, last_synced_at, source_host, updated_at)
    VALUES (
      'default',
      ${payload}::jsonb,
      ${snapshot.last_synced_at},
      ${snapshot.source_host || null},
      now()
    )
    ON CONFLICT (id) DO UPDATE SET
      snapshot = EXCLUDED.snapshot,
      last_synced_at = EXCLUDED.last_synced_at,
      source_host = EXCLUDED.source_host,
      updated_at = now()
  `;
}

export async function dbHasWebhookEvent(eventId: string, env: CrmDbEnv = process.env): Promise<boolean> {
  if (!eventId) return false;
  await ensureCrmSchema(env);
  if (isMemoryDb(env)) return memoryBank(env).events.has(eventId);
  const sql = getSql(env);
  const rows = await sql`
    SELECT 1 AS ok FROM crm_webhook_events WHERE event_id = ${eventId} LIMIT 1
  `;
  return Boolean(rows[0]);
}

export async function dbRememberWebhookEvent(
  eventId: string,
  eventType: string | null,
  payload: unknown,
  env: CrmDbEnv = process.env,
): Promise<boolean> {
  if (!eventId) return false;
  await ensureCrmSchema(env);
  if (isMemoryDb(env)) {
    const bank = memoryBank(env);
    if (bank.events.has(eventId)) return false;
    bank.events.add(eventId);
    return true;
  }
  const sql = getSql(env);
  try {
    await sql`
      INSERT INTO crm_webhook_events (event_id, event_type, payload)
      VALUES (${eventId}, ${eventType}, ${JSON.stringify(payload ?? null)}::jsonb)
    `;
    return true;
  } catch {
    // unique violation → duplicate
    return false;
  }
}

/** Reset module caches between tests. */
export function resetCrmDbClient(): void {
  schemaReady = false;
  sqlClient = null;
}
