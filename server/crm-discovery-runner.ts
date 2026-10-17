/**
 * Idempotent, rate-limited discovery cycle.
 * Fail closed without Places key — never fabricates leads.
 * Live email sending is never triggered from this module.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { CrmDbEnv } from './crm-db.js';
import { enrichNeedsEmailLeads } from './crm-discovery-enrich.js';
import {
  buildSearchQueries,
  isDiscoveryEnabled,
  isPlacesConfigured,
  maxPerRun,
  searchPlacesText,
  type PlacesEnv,
} from './crm-discovery-places.js';
import { buildDiscoveredLead, fetchWebsiteEvidence } from './crm-discovery-qualify.js';
import {
  countDiscoveredLeads,
  emptyAutomationState,
  findLeadByPlaceId,
  findRunByIdempotencyKey,
  listDiscoveredLeads,
  listDiscoveryRuns,
  readAutomationState,
  readEnrichmentStats,
  saveDiscoveryRun,
  upsertDiscoveredLead,
  writeAutomationState,
} from './crm-discovery-store.js';
import type { DiscoveryRunLog } from './crm-discovery-types.js';
import { safetySnapshot } from './crm-safety.js';

export type DiscoveryRunnerEnv = CrmDbEnv & PlacesEnv & {
  CRON_SECRET?: string;
  DISCOVERY_CITY_LIMIT?: string;
  DISCOVERY_CATEGORY_LIMIT?: string;
  DISCOVERY_ENRICH_ON_RUN?: string;
};

export type RunDiscoveryOpts = {
  trigger: DiscoveryRunLog['trigger'];
  idempotency_key?: string;
  city_limit?: number;
  category_limit?: number;
  max_results?: number;
  enrich?: boolean;
  env?: DiscoveryRunnerEnv;
  fetchImpl?: typeof fetch;
  /** Force run even when paused (admin override). */
  ignore_pause?: boolean;
};

function dayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function defaultIdempotencyKey(trigger: string, d = new Date()): string {
  return `discovery:${trigger}:${dayKey(d)}`;
}

function parseLimit(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(String(raw || ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function pauseDiscovery(
  reason: string,
  env: DiscoveryRunnerEnv = process.env,
): Promise<ReturnType<typeof emptyAutomationState>> {
  const state = await readAutomationState(env);
  const next = {
    ...state,
    paused: true,
    paused_at: new Date().toISOString(),
    paused_reason: reason || 'Paused by admin',
    places_configured: isPlacesConfigured(env),
    cron_enabled: Boolean(String(env.CRON_SECRET || '').trim()),
  };
  await writeAutomationState(next, env);
  return next;
}

export async function resumeDiscovery(env: DiscoveryRunnerEnv = process.env) {
  const state = await readAutomationState(env);
  const next = {
    ...state,
    paused: false,
    paused_at: null,
    paused_reason: null,
    places_configured: isPlacesConfigured(env),
    cron_enabled: Boolean(String(env.CRON_SECRET || '').trim()),
  };
  await writeAutomationState(next, env);
  return next;
}

export async function getDiscoveryDashboard(env: DiscoveryRunnerEnv = process.env) {
  const [state, counts, runs, enrichment, qualified] = await Promise.all([
    readAutomationState(env),
    countDiscoveredLeads(env),
    listDiscoveryRuns(15, env),
    readEnrichmentStats(env),
    listDiscoveredLeads({ status: 'qualified', limit: 25 }, env),
  ]);
  const places = isPlacesConfigured(env);
  const enabled = isDiscoveryEnabled(env);
  return {
    ok: true as const,
    live_email_send: false,
    safety: { ...safetySnapshot(env), FOLLOWUPS_LIVE: false },
    config: {
      places_configured: places,
      discovery_enabled: enabled,
      max_per_run: maxPerRun(env),
      cron_secret_configured: Boolean(String(env.CRON_SECRET || '').trim()),
      fail_closed_without_places: true,
    },
    automation: {
      ...state,
      places_configured: places,
      cron_enabled: Boolean(String(env.CRON_SECRET || '').trim()),
      total_discovered: counts.total,
      total_qualified: counts.qualified,
      total_needs_email: counts.needs_email,
    },
    counts,
    enrichment,
    recent_runs: runs,
    qualified_preview: qualified,
    message: !places
      ? 'GOOGLE_PLACES_API_KEY missing — discovery fails closed (no fabricated leads).'
      : state.paused
        ? `Discovery paused: ${state.paused_reason || 'admin'}`
        : counts.total
          ? `${counts.total} discovered leads in Neon (${counts.qualified} qualified).`
          : 'Discovery ready — no runs yet.',
  };
}

export async function runDiscoveryCycle(opts: RunDiscoveryOpts): Promise<DiscoveryRunLog> {
  const env = opts.env || process.env;
  const idempotency_key =
    opts.idempotency_key ||
    defaultIdempotencyKey(opts.trigger) +
      (opts.trigger === 'manual' ? `:${createHash('sha1').update(randomUUID()).digest('hex').slice(0, 8)}` : '');

  const existing = await findRunByIdempotencyKey(idempotency_key, env);
  if (existing && (existing.status === 'completed' || existing.status === 'running' || existing.status === 'skipped')) {
    return existing;
  }

  const started_at = new Date().toISOString();
  const runId = `run_${createHash('sha256').update(idempotency_key).digest('hex').slice(0, 16)}`;

  const base: DiscoveryRunLog = {
    id: runId,
    status: 'running',
    trigger: opts.trigger,
    started_at,
    finished_at: null,
    cities_attempted: [],
    queries_attempted: [],
    discovered: 0,
    upserted: 0,
    skipped_dupes: 0,
    qualified: 0,
    errors: [],
    message: 'Running…',
    fail_closed: false,
    idempotency_key,
  };

  const state = await readAutomationState(env);
  if (state.paused && !opts.ignore_pause) {
    const skipped: DiscoveryRunLog = {
      ...base,
      status: 'paused',
      finished_at: new Date().toISOString(),
      message: `Skipped — discovery paused (${state.paused_reason || 'admin'}).`,
    };
    await saveDiscoveryRun(skipped, env);
    return skipped;
  }

  if (!isPlacesConfigured(env) || !isDiscoveryEnabled(env)) {
    const skipped: DiscoveryRunLog = {
      ...base,
      status: 'skipped',
      finished_at: new Date().toISOString(),
      fail_closed: true,
      message: !isPlacesConfigured(env)
        ? 'GOOGLE_PLACES_API_KEY not configured. Fail closed — zero fabricated leads.'
        : 'DISCOVERY_ENABLED is off. Fail closed.',
    };
    await saveDiscoveryRun(skipped, env);
    await writeAutomationState(
      {
        ...state,
        last_run_id: skipped.id,
        last_run_at: skipped.finished_at,
        places_configured: isPlacesConfigured(env),
        cron_enabled: Boolean(String(env.CRON_SECRET || '').trim()),
      },
      env,
    );
    return skipped;
  }

  await saveDiscoveryRun(base, env);

  const cityLimit = opts.city_limit ?? parseLimit(env.DISCOVERY_CITY_LIMIT, 2);
  const categoryLimit = opts.category_limit ?? parseLimit(env.DISCOVERY_CATEGORY_LIMIT, 2);
  const cap = opts.max_results ?? maxPerRun(env);
  const queries = buildSearchQueries({ cityLimit, categoryLimit });
  const seenPlace = new Set<string>();
  let discovered = 0;
  let upserted = 0;
  let skippedDupes = 0;
  let qualified = 0;
  const errors: string[] = [];
  const cities = new Set<string>();
  const queryLabels: string[] = [];

  try {
    for (const q of queries) {
      if (discovered >= cap) break;
      cities.add(q.city);
      queryLabels.push(q.textQuery);
      const remaining = cap - discovered;
      const result = await searchPlacesText(q.textQuery, {
        maxResultCount: Math.min(5, remaining),
        env,
        fetchImpl: opts.fetchImpl,
      });
      if (!result.ok) {
        errors.push(result.message);
        if (result.fail_closed) break;
        continue;
      }
      for (const candidate of result.candidates) {
        if (discovered >= cap) break;
        if (seenPlace.has(candidate.place_id)) {
          skippedDupes += 1;
          continue;
        }
        seenPlace.add(candidate.place_id);

        const prior = await findLeadByPlaceId(candidate.place_id, env);
        if (prior) {
          skippedDupes += 1;
          // Still refresh verification lightly without counting as new discovery
          const web = await fetchWebsiteEvidence(candidate.website, { fetchImpl: opts.fetchImpl });
          const refreshed = buildDiscoveredLead(candidate, web);
          await upsertDiscoveredLead({ ...refreshed, id: prior.id, created_at: prior.created_at }, env);
          upserted += 1;
          if (refreshed.status === 'qualified') qualified += 1;
          continue;
        }

        const web = await fetchWebsiteEvidence(candidate.website, { fetchImpl: opts.fetchImpl });
        const lead = buildDiscoveredLead(candidate, web);
        await upsertDiscoveredLead(lead, env);
        discovered += 1;
        upserted += 1;
        if (lead.status === 'qualified') qualified += 1;
      }
    }

    if (opts.enrich !== false && (env.DISCOVERY_ENRICH_ON_RUN === undefined || env.DISCOVERY_ENRICH_ON_RUN === '' || !['0', 'false', 'off'].includes(String(env.DISCOVERY_ENRICH_ON_RUN).toLowerCase()))) {
      try {
        await enrichNeedsEmailLeads({ limit: 5, env, fetchImpl: opts.fetchImpl });
      } catch (err) {
        errors.push(`enrichment: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const finished: DiscoveryRunLog = {
      ...base,
      status: errors.length && discovered === 0 ? 'failed' : 'completed',
      finished_at: new Date().toISOString(),
      cities_attempted: [...cities],
      queries_attempted: queryLabels,
      discovered,
      upserted,
      skipped_dupes: skippedDupes,
      qualified,
      errors,
      message:
        discovered === 0 && errors.length
          ? `Discovery failed: ${errors[0]}`
          : `Discovery ${discovered === 0 ? 'completed with no new leads' : `added ${discovered} new lead(s)`} (${qualified} qualified this pass).`,
      fail_closed: false,
    };
    await saveDiscoveryRun(finished, env);

    const counts = await countDiscoveredLeads(env);
    await writeAutomationState(
      {
        ...state,
        paused: state.paused,
        last_run_id: finished.id,
        last_run_at: finished.finished_at,
        last_success_at: finished.status === 'completed' ? finished.finished_at : state.last_success_at,
        total_discovered: counts.total,
        total_qualified: counts.qualified,
        total_needs_email: counts.needs_email,
        places_configured: true,
        cron_enabled: Boolean(String(env.CRON_SECRET || '').trim()),
      },
      env,
    );
    return finished;
  } catch (err) {
    const failed: DiscoveryRunLog = {
      ...base,
      status: 'failed',
      finished_at: new Date().toISOString(),
      cities_attempted: [...cities],
      queries_attempted: queryLabels,
      discovered,
      upserted,
      skipped_dupes: skippedDupes,
      qualified,
      errors: [...errors, err instanceof Error ? err.message : String(err)],
      message: err instanceof Error ? err.message : 'Discovery failed.',
      fail_closed: false,
    };
    await saveDiscoveryRun(failed, env);
    return failed;
  }
}
