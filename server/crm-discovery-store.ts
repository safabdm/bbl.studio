/**
 * Neon persistence for discovered leads + discovery run logs.
 * Never invents rows — empty state is empty.
 */
import {
  crmDatabaseUrl,
  dbReadKv,
  dbWriteKv,
  ensureCrmSchema,
  isMemoryDb,
  type CrmDbEnv,
} from './crm-db.js';
import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import type {
  DiscoveredLead,
  DiscoveryAutomationState,
  DiscoveryEnrichmentStats,
  DiscoveryRunLog,
} from './crm-discovery-types.js';
import {
  DISCOVERY_KV_AUTOMATION,
  DISCOVERY_KV_ENRICHMENT,
} from './crm-discovery-types.js';

type Sql = NeonQueryFunction<false, false>;

type MemoryDiscovery = {
  leads: Map<string, DiscoveredLead>;
  runs: Map<string, DiscoveryRunLog>;
  placeIndex: Map<string, string>;
};

const memoryBanks = new Map<string, MemoryDiscovery>();

function memoryBank(env: CrmDbEnv): MemoryDiscovery {
  const key = crmDatabaseUrl(env) || 'memory://crm';
  let bank = memoryBanks.get(key);
  if (!bank) {
    bank = { leads: new Map(), runs: new Map(), placeIndex: new Map() };
    memoryBanks.set(key, bank);
  }
  return bank;
}

/** Test helper */
export function resetMemoryDiscovery(env: CrmDbEnv = process.env): void {
  const key = crmDatabaseUrl(env) || 'memory://crm';
  memoryBanks.delete(key);
}

let discoverySchemaReady = false;
let sqlClient: Sql | null = null;

function getSql(env: CrmDbEnv): Sql {
  const url = crmDatabaseUrl(env);
  if (!url || url === 'memory://crm') {
    throw new Error('CRM_DATABASE_URL is not a Postgres connection string.');
  }
  if (!sqlClient) sqlClient = neon(url);
  return sqlClient;
}

export async function ensureDiscoverySchema(env: CrmDbEnv = process.env): Promise<void> {
  await ensureCrmSchema(env);
  if (isMemoryDb(env)) return;
  if (discoverySchemaReady) return;
  const sql = getSql(env);
  await sql`
    CREATE TABLE IF NOT EXISTS crm_discovered_leads (
      id TEXT PRIMARY KEY,
      place_id TEXT NOT NULL UNIQUE,
      business_name TEXT NOT NULL,
      city TEXT NULL,
      category TEXT NULL,
      status TEXT NOT NULL,
      score_total INTEGER NOT NULL DEFAULT 0,
      website TEXT NULL,
      public_email TEXT NULL,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS crm_discovered_leads_status_idx
    ON crm_discovered_leads (status)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS crm_discovered_leads_score_idx
    ON crm_discovered_leads (score_total DESC)
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS crm_discovery_runs (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ NULL
    )
  `;
  discoverySchemaReady = true;
}

export function emptyAutomationState(partial: Partial<DiscoveryAutomationState> = {}): DiscoveryAutomationState {
  return {
    paused: false,
    paused_at: null,
    paused_reason: null,
    last_run_id: null,
    last_run_at: null,
    last_success_at: null,
    total_discovered: 0,
    total_qualified: 0,
    total_needs_email: 0,
    places_configured: false,
    cron_enabled: false,
    updated_at: new Date().toISOString(),
    ...partial,
  };
}

export function emptyEnrichmentStats(): DiscoveryEnrichmentStats {
  return {
    attempted: 0,
    found_public: 0,
    not_found: 0,
    skipped_guess_blocked: 0,
    last_run_at: null,
  };
}

export async function readAutomationState(env: CrmDbEnv = process.env): Promise<DiscoveryAutomationState> {
  await ensureDiscoverySchema(env);
  return dbReadKv(DISCOVERY_KV_AUTOMATION, emptyAutomationState(), env);
}

export async function writeAutomationState(
  state: DiscoveryAutomationState,
  env: CrmDbEnv = process.env,
): Promise<void> {
  await ensureDiscoverySchema(env);
  await dbWriteKv(DISCOVERY_KV_AUTOMATION, { ...state, updated_at: new Date().toISOString() }, env);
}

export async function readEnrichmentStats(env: CrmDbEnv = process.env): Promise<DiscoveryEnrichmentStats> {
  await ensureDiscoverySchema(env);
  return dbReadKv(DISCOVERY_KV_ENRICHMENT, emptyEnrichmentStats(), env);
}

export async function writeEnrichmentStats(
  stats: DiscoveryEnrichmentStats,
  env: CrmDbEnv = process.env,
): Promise<void> {
  await ensureDiscoverySchema(env);
  await dbWriteKv(DISCOVERY_KV_ENRICHMENT, stats, env);
}

export async function findLeadByPlaceId(
  placeId: string,
  env: CrmDbEnv = process.env,
): Promise<DiscoveredLead | null> {
  if (!placeId) return null;
  await ensureDiscoverySchema(env);
  if (isMemoryDb(env)) {
    const bank = memoryBank(env);
    const id = bank.placeIndex.get(placeId);
    if (!id) return null;
    const lead = bank.leads.get(id);
    return lead ? structuredClone(lead) : null;
  }
  const sql = getSql(env);
  const rows = await sql`
    SELECT payload FROM crm_discovered_leads WHERE place_id = ${placeId} LIMIT 1
  `;
  const row = rows[0] as { payload?: DiscoveredLead } | undefined;
  return row?.payload ? structuredClone(row.payload) : null;
}

export async function upsertDiscoveredLead(
  lead: DiscoveredLead,
  env: CrmDbEnv = process.env,
): Promise<{ inserted: boolean; lead: DiscoveredLead }> {
  await ensureDiscoverySchema(env);
  const existing = await findLeadByPlaceId(lead.place_id, env);
  const now = new Date().toISOString();
  const merged: DiscoveredLead = existing
    ? {
        ...existing,
        ...lead,
        id: existing.id,
        created_at: existing.created_at,
        updated_at: now,
        last_verified_at: lead.last_verified_at || now,
      }
    : { ...lead, updated_at: now };

  if (isMemoryDb(env)) {
    const bank = memoryBank(env);
    bank.leads.set(merged.id, structuredClone(merged));
    bank.placeIndex.set(merged.place_id, merged.id);
    return { inserted: !existing, lead: structuredClone(merged) };
  }

  const sql = getSql(env);
  const payload = JSON.stringify(merged);
  await sql`
    INSERT INTO crm_discovered_leads (
      id, place_id, business_name, city, category, status, score_total,
      website, public_email, payload, created_at, updated_at
    ) VALUES (
      ${merged.id},
      ${merged.place_id},
      ${merged.business_name},
      ${merged.city},
      ${merged.category},
      ${merged.status},
      ${merged.score_total},
      ${merged.website},
      ${merged.public_email},
      ${payload}::jsonb,
      ${merged.created_at}::timestamptz,
      ${merged.updated_at}::timestamptz
    )
    ON CONFLICT (place_id) DO UPDATE SET
      business_name = EXCLUDED.business_name,
      city = EXCLUDED.city,
      category = EXCLUDED.category,
      status = EXCLUDED.status,
      score_total = EXCLUDED.score_total,
      website = EXCLUDED.website,
      public_email = EXCLUDED.public_email,
      payload = EXCLUDED.payload,
      updated_at = EXCLUDED.updated_at
  `;
  return { inserted: !existing, lead: merged };
}

export async function listDiscoveredLeads(
  opts: { status?: string; limit?: number; minScore?: number } = {},
  env: CrmDbEnv = process.env,
): Promise<DiscoveredLead[]> {
  await ensureDiscoverySchema(env);
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);

  if (isMemoryDb(env)) {
    let rows = [...memoryBank(env).leads.values()];
    if (opts.status) rows = rows.filter((l) => l.status === opts.status);
    if (opts.minScore != null) rows = rows.filter((l) => l.score_total >= opts.minScore!);
    rows.sort((a, b) => b.score_total - a.score_total || b.updated_at.localeCompare(a.updated_at));
    return structuredClone(rows.slice(0, limit));
  }

  const sql = getSql(env);
  if (opts.status && opts.minScore != null) {
    const rows = await sql`
      SELECT payload FROM crm_discovered_leads
      WHERE status = ${opts.status} AND score_total >= ${opts.minScore}
      ORDER BY score_total DESC, updated_at DESC
      LIMIT ${limit}
    `;
    return rows.map((r) => structuredClone((r as { payload: DiscoveredLead }).payload));
  }
  if (opts.status) {
    const rows = await sql`
      SELECT payload FROM crm_discovered_leads
      WHERE status = ${opts.status}
      ORDER BY score_total DESC, updated_at DESC
      LIMIT ${limit}
    `;
    return rows.map((r) => structuredClone((r as { payload: DiscoveredLead }).payload));
  }
  if (opts.minScore != null) {
    const rows = await sql`
      SELECT payload FROM crm_discovered_leads
      WHERE score_total >= ${opts.minScore}
      ORDER BY score_total DESC, updated_at DESC
      LIMIT ${limit}
    `;
    return rows.map((r) => structuredClone((r as { payload: DiscoveredLead }).payload));
  }
  const rows = await sql`
    SELECT payload FROM crm_discovered_leads
    ORDER BY score_total DESC, updated_at DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => structuredClone((r as { payload: DiscoveredLead }).payload));
}

export async function countDiscoveredLeads(env: CrmDbEnv = process.env): Promise<{
  total: number;
  qualified: number;
  needs_email: number;
  discovered: number;
}> {
  await ensureDiscoverySchema(env);
  if (isMemoryDb(env)) {
    const rows = [...memoryBank(env).leads.values()];
    return {
      total: rows.length,
      qualified: rows.filter((l) => l.status === 'qualified').length,
      needs_email: rows.filter((l) => l.status === 'needs_email').length,
      discovered: rows.filter((l) => l.status === 'discovered').length,
    };
  }
  const sql = getSql(env);
  const rows = await sql`
    SELECT status, COUNT(*)::int AS n FROM crm_discovered_leads GROUP BY status
  `;
  const byStatus = new Map<string, number>();
  let total = 0;
  for (const row of rows as Array<{ status: string; n: number }>) {
    byStatus.set(row.status, row.n);
    total += row.n;
  }
  return {
    total,
    qualified: byStatus.get('qualified') || 0,
    needs_email: byStatus.get('needs_email') || 0,
    discovered: byStatus.get('discovered') || 0,
  };
}

export async function findRunByIdempotencyKey(
  key: string,
  env: CrmDbEnv = process.env,
): Promise<DiscoveryRunLog | null> {
  if (!key) return null;
  await ensureDiscoverySchema(env);
  if (isMemoryDb(env)) {
    for (const run of memoryBank(env).runs.values()) {
      if (run.idempotency_key === key) return structuredClone(run);
    }
    return null;
  }
  const sql = getSql(env);
  const rows = await sql`
    SELECT payload FROM crm_discovery_runs WHERE idempotency_key = ${key} LIMIT 1
  `;
  const row = rows[0] as { payload?: DiscoveryRunLog } | undefined;
  return row?.payload ? structuredClone(row.payload) : null;
}

export async function saveDiscoveryRun(
  run: DiscoveryRunLog,
  env: CrmDbEnv = process.env,
): Promise<void> {
  await ensureDiscoverySchema(env);
  if (isMemoryDb(env)) {
    memoryBank(env).runs.set(run.id, structuredClone(run));
    return;
  }
  const sql = getSql(env);
  const payload = JSON.stringify(run);
  await sql`
    INSERT INTO crm_discovery_runs (id, idempotency_key, status, payload, created_at, finished_at)
    VALUES (
      ${run.id},
      ${run.idempotency_key},
      ${run.status},
      ${payload}::jsonb,
      ${run.started_at}::timestamptz,
      ${run.finished_at}
    )
    ON CONFLICT (idempotency_key) DO UPDATE SET
      status = EXCLUDED.status,
      payload = EXCLUDED.payload,
      finished_at = EXCLUDED.finished_at
  `;
}

export async function listDiscoveryRuns(
  limit = 20,
  env: CrmDbEnv = process.env,
): Promise<DiscoveryRunLog[]> {
  await ensureDiscoverySchema(env);
  const capped = Math.min(Math.max(limit, 1), 100);
  if (isMemoryDb(env)) {
    return structuredClone(
      [...memoryBank(env).runs.values()]
        .sort((a, b) => b.started_at.localeCompare(a.started_at))
        .slice(0, capped),
    );
  }
  const sql = getSql(env);
  const rows = await sql`
    SELECT payload FROM crm_discovery_runs
    ORDER BY created_at DESC
    LIMIT ${capped}
  `;
  return rows.map((r) => structuredClone((r as { payload: DiscoveryRunLog }).payload));
}

export function resetDiscoveryDbClient(): void {
  discoverySchemaReady = false;
  sqlClient = null;
}
