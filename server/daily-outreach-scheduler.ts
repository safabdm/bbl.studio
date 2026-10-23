/**
 * Mac-independent Daily Outreach scheduler — GitHub Actions (primary) + Vercel Hobby backup + Neon.
 * Never auto-sends prospects. Owner must approve in Daily Review.
 * Mail.app cannot run when Mac is asleep — Graph/Resend only for post-approval send.
 */
import { dbReadKv, dbWriteKv, type CrmDbEnv } from './crm-db.js';
import { authorizeCron } from './crm-discovery-api.js';
import { runDiscoveryCycle, type DiscoveryRunnerEnv } from './crm-discovery-runner.js';
import { enrichNeedsEmailLeads } from './crm-discovery-enrich.js';
import {
  BATCH_1_BLOCKLIST_EMAILS,
  DAILY_20_BATCH_1_SENT_EMAILS,
  HOLD_BLOCKLIST_EMAILS,
  buildDaily20Cohort,
  getDaily20Dashboard,
  type Daily20Env,
} from './daily-20-pipeline.js';
import { crmDatabaseUrl, isDurableDbConfigured } from './crm-db.js';
import { upsertDiscoveredLead } from './crm-discovery-store.js';
import { isPlacesConfigured } from './crm-discovery-places.js';
import { upsertStudioDraftFromLead } from './email-studio.js';
import { fixtureDiscoveredLead } from './lead-queue.js';
import { laDayKey, readDailyCapState, remainingSends, effectiveCap } from './daily-cap.js';
import { isDryRun, isManualLiveSendEnabled, safetySnapshot } from './crm-safety.js';
import { graphConfigured } from './graph-sender.js';
import {
  generateFollowUpDrafts,
  listFollowUpDrafts,
  listInterestedNotify,
} from './follow-up-drafts.js';
import { notifyOwnerDailyReviewReady, type OwnerNotifyEnv } from './owner-notify.js';
import {
  PACIFIC_TZ,
  describeNextWeekdayRun,
  isMorningPipelineDispatchWindow,
  isMorningPipelineStartHour,
  isPacificWeekday,
  pacificParts,
} from './pacific-time.js';
import { safetySnapshot } from './crm-safety.js';
import {
  processNextSend,
  readSendControls,
  readSendQueue,
  countResendRisk,
  type SendControlsEnv,
} from './send-controls.js';
import { getActiveSender, sendViaGraph, type GraphSenderEnv } from './graph-sender.js';
import { fetchEmailHistory, fetchLeads } from './crm-lead-client.js';
import { importGraphReplies } from './graph-sender.js';
import { recordInterestedFromInbox } from './follow-up-drafts.js';
import { buildLeadQueue } from './lead-queue.js';

export const SCHEDULER_STATE_KV = 'outreach:scheduler_state';
export const SCHEDULER_RUNS_KV = 'outreach:scheduler_runs';

export type SchedulerJobName =
  | 'discover'
  | 'verify'
  | 'select'
  | 'notify'
  | 'send_window'
  | 'replies'
  | 'followups';

export type SchedulerJobResult = {
  job: SchedulerJobName;
  day_key: string;
  status: 'completed' | 'skipped' | 'failed' | 'idempotent_skip';
  message: string;
  at: string;
  details?: Record<string, unknown>;
};

export type StageStamp = {
  /** Intended Pacific wall-clock label (logical schedule for UI). */
  intended_pt: string;
  started_at: string | null;
  finished_at: string | null;
  status: SchedulerJobResult['status'] | 'pending' | null;
  message: string | null;
};

export type SchedulerState = {
  last_job: SchedulerJobName | null;
  last_status: string | null;
  last_message: string | null;
  last_at: string | null;
  last_day_key: string | null;
  last_error: string | null;
  /** Idempotency: job:day_key → ISO completed */
  completed: Record<string, string>;
  /** Logical stage stamps for the current/last LA day (UI schedule even when Hobby runs stages back-to-back). */
  stages: Partial<Record<SchedulerJobName, StageStamp>>;
  stages_day_key: string | null;
  /** Hobby: Vercel backup crons are once/day each; GHA is primary. */
  hobby_single_cron: boolean;
  /** Last dispatcher source: github-actions | vercel | admin | unknown */
  last_source: string | null;
  updated_at: string;
};

/** Morning prep stages — run sequentially in one invocation (never auto-send). */
export const MORNING_PIPELINE_JOBS: SchedulerJobName[] = ['discover', 'verify', 'select', 'notify'];

export const STAGE_INTENDED_PT: Record<SchedulerJobName, string> = {
  discover: '07:00',
  verify: '08:00',
  select: '08:30',
  notify: '09:00',
  send_window: '09:00–11:00 (owner-approved only)',
  replies: '12:00 / 15:00 (Pro / manual)',
  followups: '10:00 (optional after notify)',
};

/**
 * Source of truth: GitHub Actions hourly Mon–Fri (UTC window), PT-gated server-side.
 * Vercel Hobby crons are backup only (once/day each; handler no-ops outside 07:00–08:59 PT).
 */
export const SCHEDULER_SOURCE_OF_TRUTH = 'github-actions' as const;

/** GHA schedule (UTC): hourly :05 during 13–17 UTC Mon–Fri — covers 6–10 AM PT year-round. */
export const GITHUB_ACTIONS_CRON_SCHEDULE = '5 13-17 * * 1-5';

/** Vercel Hobby backups — each fires once/day (Hobby-safe). Handler gates on America/Los_Angeles. */
export const OUTREACH_CRON_SCHEDULE = '0 14 * * 1-5';
export const OUTREACH_CRON_SCHEDULE_PST_BACKUP = '0 15 * * 1-5';
export const OUTREACH_CRON_SCHEDULE_NOTE =
  'Primary: GitHub Actions (PT-gated 07:00–08:59 America/Los_Angeles). Vercel Hobby backups: 0 14 * * 1-5 (≈7am PDT) + 0 15 * * 1-5 (≈7am PST). Idempotent per job:LA-day.';

export type SchedulerEnv = Daily20Env &
  DiscoveryRunnerEnv &
  OwnerNotifyEnv &
  SendControlsEnv &
  GraphSenderEnv &
  CrmDbEnv & {
    CRON_SECRET?: string;
    OUTREACH_SCHEDULER_ENABLED?: string;
    /** When true, send_window may call live Graph/Resend for already-approved queue (still needs safety flags). */
    OUTREACH_CRON_SEND_ENABLED?: string;
  };

function nowIso(ms = Date.now()): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function truthy(v: string | undefined) {
  return ['1', 'true', 'yes', 'on'].includes(String(v || '').trim().toLowerCase());
}

function emptyState(): SchedulerState {
  return {
    last_job: null,
    last_status: null,
    last_message: null,
    last_at: null,
    last_day_key: null,
    last_error: null,
    completed: {},
    stages: {},
    stages_day_key: null,
    hobby_single_cron: true,
    last_source: null,
    updated_at: nowIso(),
  };
}

export async function readSchedulerState(env: SchedulerEnv = process.env): Promise<SchedulerState> {
  const raw = await dbReadKv<SchedulerState | null>(SCHEDULER_STATE_KV, null, env);
  return raw && typeof raw === 'object'
    ? {
        ...emptyState(),
        ...raw,
        completed: raw.completed || {},
        stages: raw.stages || {},
        hobby_single_cron: true,
      }
    : emptyState();
}

async function writeSchedulerState(state: SchedulerState, env: SchedulerEnv): Promise<SchedulerState> {
  const next = { ...state, updated_at: nowIso() };
  await dbWriteKv(SCHEDULER_STATE_KV, next, env);
  return next;
}

async function appendRun(run: SchedulerJobResult, env: SchedulerEnv): Promise<void> {
  const prev = await dbReadKv<SchedulerJobResult[]>(SCHEDULER_RUNS_KV, [], env);
  const next = [run, ...(Array.isArray(prev) ? prev : [])].slice(0, 100);
  await dbWriteKv(SCHEDULER_RUNS_KV, next, env);
}

export function idempotencyKey(job: SchedulerJobName, dayKey: string): string {
  return `${job}:${dayKey}`;
}

export function isJobComplete(state: SchedulerState, job: SchedulerJobName, dayKey: string): boolean {
  return Boolean(state.completed[idempotencyKey(job, dayKey)]);
}

function ensureStagesDay(state: SchedulerState, dayKey: string): SchedulerState {
  if (state.stages_day_key === dayKey) return state;
  const stages: Partial<Record<SchedulerJobName, StageStamp>> = {};
  for (const job of MORNING_PIPELINE_JOBS) {
    stages[job] = {
      intended_pt: STAGE_INTENDED_PT[job],
      started_at: null,
      finished_at: null,
      status: 'pending',
      message: null,
    };
  }
  return { ...state, stages, stages_day_key: dayKey };
}

async function stampStageStart(
  job: SchedulerJobName,
  dayKey: string,
  at: string,
  env: SchedulerEnv,
): Promise<void> {
  let state = ensureStagesDay(await readSchedulerState(env), dayKey);
  state.stages[job] = {
    intended_pt: STAGE_INTENDED_PT[job],
    started_at: at,
    finished_at: null,
    status: 'pending',
    message: null,
  };
  await writeSchedulerState(state, env);
}

async function stampStageFinish(
  job: SchedulerJobName,
  dayKey: string,
  result: SchedulerJobResult,
  env: SchedulerEnv,
): Promise<SchedulerState> {
  let state = ensureStagesDay(await readSchedulerState(env), dayKey);
  const prev = state.stages[job];
  state.stages[job] = {
    intended_pt: STAGE_INTENDED_PT[job],
    started_at: prev?.started_at || result.at,
    finished_at: result.at,
    status: result.status,
    message: result.message,
  };
  return state;
}

/**
 * Morning pipeline stages (discover→verify→select→notify).
 * Never includes send_window (owner-approval gated; not part of auto cron).
 */
export function morningPipelineJobs(): SchedulerJobName[] {
  return [...MORNING_PIPELINE_JOBS];
}

/**
 * Whether an automated dispatcher (GHA / Vercel) should run the morning pipeline now.
 * Gated to Mon–Fri 07:00–08:59 America/Los_Angeles so work finishes before 9:00 AM PT year-round.
 */
export function shouldDispatchMorningPipeline(ms = Date.now()): boolean {
  return isMorningPipelineDispatchWindow(ms);
}

/**
 * Jobs due for an automated cron tick.
 * Only inside the PT dispatch window; never send_window.
 */
export function jobsDueAt(ms = Date.now()): SchedulerJobName[] {
  if (!shouldDispatchMorningPipeline(ms)) return [];
  return morningPipelineJobs();
}

export function isMorningPipelineComplete(state: SchedulerState, jobDayKey: string): boolean {
  return MORNING_PIPELINE_JOBS.every((job) => isJobComplete(state, job, jobDayKey));
}

/**
 * Public readiness booleans (no secret values). Safe for Production probes.
 */
export function getOutreachReadinessSnapshot(env: SchedulerEnv = process.env) {
  const cronSend = truthy(env.OUTREACH_CRON_SEND_ENABLED);
  const safety = safetySnapshot(env);
  const admin = String(env.ADMIN_EMAIL || env.BBL_EMAIL || '').trim();
  return {
    ok: true as const,
    auto_send: false,
    prospect_send_allowed: false,
    source_of_truth: SCHEDULER_SOURCE_OF_TRUTH,
    timezone: PACIFIC_TZ,
    dispatch_window_pt: '07:00–08:59',
    github_actions_cron: GITHUB_ACTIONS_CRON_SCHEDULE,
    vercel_backup_crons: [OUTREACH_CRON_SCHEDULE, OUTREACH_CRON_SCHEDULE_PST_BACKUP],
    config: {
      database_url_configured: Boolean(crmDatabaseUrl(env)),
      durable_db_configured: isDurableDbConfigured(env),
      cron_secret_configured: Boolean(String(env.CRON_SECRET || '').trim()),
      places_configured: isPlacesConfigured(env),
      resend_configured: Boolean(String(env.RESEND_API_KEY || '').trim()),
      business_postal_configured: Boolean(String(env.BUSINESS_POSTAL_ADDRESS || '').trim()),
      admin_email_configured: Boolean(admin),
      admin_email_fallback: admin ? null : 'hello@bbl.studio',
      app_origin_configured: Boolean(String(env.APP_ORIGIN || '').trim()),
      scheduler_enabled:
        env.OUTREACH_SCHEDULER_ENABLED === undefined ||
        env.OUTREACH_SCHEDULER_ENABLED === '' ||
        truthy(env.OUTREACH_SCHEDULER_ENABLED),
      outreach_cron_send_enabled: cronSend,
      email_dry_run: isDryRun(env),
      manual_send_live_enabled: isManualLiveSendEnabled(env),
      graph_configured: graphConfigured(env),
    },
    safety: {
      ...safety,
      OUTREACH_CRON_SEND_ENABLED: cronSend,
      /** True only if cron-send flag AND manual live AND not dry-run — still never auto-approves. */
      live_cron_send_allowed: cronSend && safety.live_manual_send_allowed,
    },
    deploy_blockers: [
      !crmDatabaseUrl(env) && 'CRM_DATABASE_URL_or_DATABASE_URL',
      !String(env.CRON_SECRET || '').trim() && 'CRON_SECRET',
      !isPlacesConfigured(env) && 'GOOGLE_PLACES_API_KEY',
      !String(env.BUSINESS_POSTAL_ADDRESS || '').trim() && 'BUSINESS_POSTAL_ADDRESS',
      // Resend optional (log fallback) — listed as warn not blocker
    ].filter(Boolean) as string[],
    notify_channel: String(env.RESEND_API_KEY || '').trim() ? 'resend' : 'log',
  };
}

/**
 * Seed a deterministic discovered pool for dry-run / CI proof when Places is unavailable.
 * Includes hard-excluded emails so select can prove they never qualify. Never sends.
 */
export async function seedProofDiscoveredPool(
  env: SchedulerEnv = process.env,
  opts: { goodCount?: number } = {},
): Promise<{
  seeded_good: number;
  seeded_excluded: number;
  excluded_emails: string[];
}> {
  const goodCount = opts.goodCount ?? 28;
  const cities = ['Irvine', 'Newport Beach', 'Costa Mesa', 'Laguna Beach', 'Huntington Beach'];
  let seeded_good = 0;
  for (let i = 0; i < goodCount; i++) {
    // Unique email domain per lead — lead-queue merges same-domain discoveries into one row.
    await upsertDiscoveredLead(
      fixtureDiscoveredLead({
        id: `proof_good_${i}`,
        place_id: `places/proof_good_${i}`,
        public_email: `hello@oc-proof-medspa-${i}.example`,
        business_name: `OC Proof Med Spa ${i}`,
        city: cities[i % cities.length],
        category: i % 2 === 0 ? 'med spa' : 'wellness spa',
        website: `https://oc-proof-medspa-${i}.example`,
        score_total: 70 + (i % 20),
        status: 'qualified',
        weak_website_signals: [`hero CTA is phone-only on mobile (${i})`],
      }),
      env,
    );
    seeded_good += 1;
  }
  const excluded = [
    ...BATCH_1_BLOCKLIST_EMAILS.slice(0, 2),
    ...DAILY_20_BATCH_1_SENT_EMAILS.slice(0, 3),
    ...HOLD_BLOCKLIST_EMAILS,
  ];
  let seeded_excluded = 0;
  for (let i = 0; i < excluded.length; i++) {
    const email = excluded[i]!;
    await upsertDiscoveredLead(
      fixtureDiscoveredLead({
        id: `proof_excl_${i}`,
        place_id: `places/proof_excl_${i}`,
        public_email: email,
        business_name: `Excluded Proof ${i}`,
        city: 'Newport Beach',
        category: 'med spa',
        website: `https://excluded-proof-${i}.example`,
        score_total: 90,
        status: 'qualified',
        weak_website_signals: ['should never qualify — hard exclude'],
      }),
      env,
    );
    seeded_excluded += 1;
  }
  return { seeded_good, seeded_excluded, excluded_emails: excluded.map((e) => e.toLowerCase()) };
}

async function notifyWithRetry(
  args: {
    day_key: string;
    qualified_count: number;
    discovered_count: number;
    message: string;
  },
  env: SchedulerEnv,
  fetchImpl: typeof fetch,
  attempts = 2,
): Promise<Awaited<ReturnType<typeof notifyOwnerDailyReviewReady>> & { attempts: number }> {
  let last = await notifyOwnerDailyReviewReady(args, env, fetchImpl);
  let used = 1;
  while (!last.ok && used < attempts) {
    used += 1;
    last = await notifyOwnerDailyReviewReady(args, env, fetchImpl);
  }
  return { ...last, attempts: used };
}

export async function runSchedulerJob(
  job: SchedulerJobName,
  env: SchedulerEnv = process.env,
  opts: {
    nowMs?: number;
    force?: boolean;
    fetchImpl?: typeof fetch;
    /** Skip Places / live enrich network (tests + dry-run proof). */
    fixturesOnly?: boolean;
    /** When fixturesOnly discover runs, seed a proof discovered pool into Neon/memory. */
    seedProofFixtures?: boolean;
  } = {},
): Promise<SchedulerJobResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const day_key = laDayKey(nowMs);
  const at = nowIso(nowMs);
  let state = await readSchedulerState(env);

  // Day-locked jobs (not send_window — may process multiple times in window)
  const dayLocked: SchedulerJobName[] = ['discover', 'verify', 'select', 'notify', 'followups', 'replies'];
  if (!opts.force && dayLocked.includes(job) && isJobComplete(state, job, day_key)) {
    const skip: SchedulerJobResult = {
      job,
      day_key,
      status: 'idempotent_skip',
      message: `Already completed ${job} for ${day_key} PT.`,
      at,
    };
    state = await stampStageFinish(job, day_key, skip, env);
    state.last_job = job;
    state.last_status = skip.status;
    state.last_message = skip.message;
    state.last_at = at;
    state.last_day_key = day_key;
    await writeSchedulerState(state, env);
    await appendRun(skip, env);
    return skip;
  }

  if (!isPacificWeekday(nowMs) && !opts.force) {
    const skip: SchedulerJobResult = {
      job,
      day_key,
      status: 'skipped',
      message: 'Weekend PT — outreach scheduler idle.',
      at,
    };
    await appendRun(skip, env);
    return skip;
  }

  await stampStageStart(job, day_key, at, env);

  try {
    let result: SchedulerJobResult;

    if (job === 'discover') {
      if (opts.fixturesOnly) {
        const seeded = opts.seedProofFixtures ? await seedProofDiscoveredPool(env) : null;
        result = {
          job,
          day_key,
          status: 'completed',
          message: seeded
            ? `Discover fixtures: seeded proof pool (good=${seeded.seeded_good}, excluded_samples=${seeded.seeded_excluded}). No Places call.`
            : 'Discover skipped in fixtures mode (no Places call).',
          at,
          details: { fixturesOnly: true, seedProofFixtures: Boolean(opts.seedProofFixtures), seeded },
        };
      } else {
        const run = await runDiscoveryCycle({
          trigger: 'cron',
          idempotency_key: `outreach-discover:${day_key}`,
          max_results: 40,
          enrich: false,
          env,
          fetchImpl: opts.fetchImpl,
        });
        result = {
          job,
          day_key,
          status: run.status === 'failed' ? 'failed' : 'completed',
          message: run.message,
          at,
          details: {
            discovered: run.discovered,
            qualified: run.qualified,
            fail_closed: run.fail_closed,
          },
        };
      }
    } else if (job === 'verify') {
      if (opts.fixturesOnly) {
        result = {
          job,
          day_key,
          status: 'completed',
          message: 'Verify fixtures: enrichment skipped (pool already has public emails).',
          at,
        };
      } else {
        const enrich = await enrichNeedsEmailLeads({ limit: 40, env, fetchImpl: opts.fetchImpl });
        // Soft re-read CRM snapshot path is inside buildLeadQueue on select
        result = {
          job,
          day_key,
          status: 'completed',
          message: `Verified/enriched public emails (attempted=${(enrich as { attempted?: number }).attempted ?? 'n/a'}).`,
          at,
          details: enrich as Record<string, unknown>,
        };
      }
    } else if (job === 'select') {
      // Always read persisted discovery/CRM pool — fixturesOnly only skips Places/enrich network.
      const cohort = await buildDaily20Cohort({ fixturesOnly: false, now: nowMs }, env);
      // Persist unapproved Email Studio drafts for Daily Review (never auto-approve / auto-send).
      let drafts_ready = 0;
      let drafts_blocked = 0;
      const draft_ids: string[] = [];
      for (const q of cohort.qualified) {
        const draft = await upsertStudioDraftFromLead(q, { regenerate: true }, env);
        if (draft.blocked_reasons.length || !draft.observation_verified) drafts_blocked += 1;
        else {
          drafts_ready += 1;
          draft_ids.push(draft.id);
        }
      }
      const hardRejected = cohort.rejected_pool.filter((r) =>
        ['batch_1_sent', 'daily_20_batch_1_sent', 'hold_aka'].includes(r.reason),
      ).length;
      // Quality bar: do not pad — cohort already caps by verified observation+email
      result = {
        job,
        day_key,
        status: 'completed',
        message: `${cohort.message} Drafts ready for review: ${drafts_ready}/${cohort.qualified.length}.`,
        at,
        details: {
          qualified: cohort.qualified.length,
          discovered_count: cohort.discovered_count,
          rejected: cohort.rejected_pool.length,
          hard_excluded_rejected: hardRejected,
          drafts_ready,
          drafts_blocked,
          draft_ids: draft_ids.slice(0, 20),
          sample_emails: cohort.qualified.slice(0, 5).map((q) => q.email),
          padded: false,
          auto_approved: false,
          prospect_send: false,
        },
      };
    } else if (job === 'notify') {
      const dash = await getDaily20Dashboard(env, { refresh: false, now: nowMs });
      const notify = await notifyWithRetry(
        {
          day_key,
          qualified_count: dash.cohort.qualified.length,
          discovered_count: dash.cohort.discovered_count,
          message: dash.cohort.message,
        },
        env,
        opts.fetchImpl || fetch,
        2,
      );
      result = {
        job,
        day_key,
        status: notify.ok ? 'completed' : 'failed',
        message: notify.ok
          ? `Owner notified via ${notify.channel} → ${notify.to} (no prospect send; attempts=${notify.attempts}).`
          : `Owner notify failed after ${notify.attempts} attempt(s): ${notify.error}`,
        at,
        details: { ...notify, prospect_send: false },
      };
    } else if (job === 'send_window') {
      // NEVER auto-approve. Only process already-approved queue when explicit cron send + safety allow.
      const safety = safetySnapshot(env);
      const cronSend = truthy(env.OUTREACH_CRON_SEND_ENABLED);
      const allowLive = cronSend && safety.live_manual_send_allowed;
      if (!allowLive) {
        result = {
          job,
          day_key,
          status: 'skipped',
          message:
            'Send window: live cron send OFF (OUTREACH_CRON_SEND_ENABLED / MANUAL_SEND_LIVE_ENABLED / EMAIL_DRY_RUN). Queue unchanged — no auto-send.',
          at,
          details: {
            cronSend,
            safety,
            pending: countResendRisk(await readSendQueue(env)).pending,
          },
        };
      } else {
        const active = await getActiveSender(env);
        const processed = await processNextSend(
          async (item) => {
            if (active === 'graph') {
              const sent = await sendViaGraph(item, env, opts.fetchImpl || fetch);
              return sent.ok
                ? { ok: true, provider_message_id: sent.provider_message_id }
                : { ok: false, error: sent.message };
            }
            return { ok: false, error: 'Active sender not Graph for cron send.' };
          },
          env,
          { allowLive: true, nowMs },
        );
        result = {
          job,
          day_key,
          status: 'completed',
          message: processed.message,
          at,
          details: {
            processed: processed.processed,
            item_status: processed.item?.status,
            auto_send_without_approval: false,
          },
        };
      }
    } else if (job === 'replies') {
      if (opts.fixturesOnly) {
        result = {
          job,
          day_key,
          status: 'completed',
          message: 'Replies fixtures: skipped Graph import.',
          at,
        };
      } else {
        const built = await buildLeadQueue({}, env);
        const emails = new Set(
          [...built.items, ...built.excluded].map((i) => i.email).filter(Boolean),
        );
        const imported = await importGraphReplies(
          { known_emails: emails },
          env,
          opts.fetchImpl || fetch,
        );
        if (!imported.ok) {
          result = {
            job,
            day_key,
            status: 'failed',
            message: imported.message,
            at,
          };
        } else {
          const interested = await recordInterestedFromInbox(imported.items, env);
          result = {
            job,
            day_key,
            status: 'completed',
            message: `Imported ${imported.items.length} replies; ${interested.length} interested flags.`,
            at,
            details: {
              imported: imported.items.length,
              interested: interested.length,
              marked_replied: imported.marked_replied,
            },
          };
        }
      }
    } else if (job === 'followups') {
      const [leads, history] = await Promise.all([fetchLeads('', env), fetchEmailHistory(env)]);
      const created = await generateFollowUpDrafts(
        { leads: leads.data || [], history: history.data || [], nowMs },
        env,
      );
      const drafts = await listFollowUpDrafts(env);
      result = {
        job,
        day_key,
        status: 'completed',
        message: `Follow-up drafts: created ${created.length} (total draft ${drafts.filter((d) => d.status === 'draft').length}). Approval only — no auto-send.`,
        at,
        details: { created: created.length },
      };
    } else {
      result = {
        job,
        day_key,
        status: 'failed',
        message: `Unknown job ${job}`,
        at,
      };
    }

    // Persist idempotency for day-locked successes + logical stage stamp
    state = await stampStageFinish(job, day_key, result, env);
    if (result.status === 'completed' && dayLocked.includes(job)) {
      state.completed[idempotencyKey(job, day_key)] = at;
    }
    state.last_job = job;
    state.last_status = result.status;
    state.last_message = result.message;
    state.last_at = at;
    state.last_day_key = day_key;
    state.last_error = result.status === 'failed' ? result.message : null;
    state.hobby_single_cron = true;
    await writeSchedulerState(state, env);
    await appendRun(result, env);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Scheduler job failed';
    const failed: SchedulerJobResult = { job, day_key, status: 'failed', message, at };
    state = await stampStageFinish(job, day_key, failed, env);
    state.last_job = job;
    state.last_status = 'failed';
    state.last_message = message;
    state.last_at = at;
    state.last_day_key = day_key;
    state.last_error = message;
    state.hobby_single_cron = true;
    await writeSchedulerState(state, env);
    await appendRun(failed, env);
    return failed;
  }
}

/**
 * Dispatcher for GitHub Actions (primary) + Vercel Hobby backup.
 * PT-gated Mon–Fri 07:00–08:59 America/Los_Angeles; sequential morning pipeline.
 * Idempotent per job/LA-day. Never includes send_window. Never prospect-sends without approval + flags.
 */
export async function dispatchOutreachCron(
  headers: { authorization?: string | null },
  env: SchedulerEnv = process.env,
  opts: {
    nowMs?: number;
    forceJobs?: SchedulerJobName[];
    fetchImpl?: typeof fetch;
    fixturesOnly?: boolean;
    /** Seed proof discovered pool during fixturesOnly discover (dry-run / CI). */
    seedProofFixtures?: boolean;
    /** github-actions | vercel | admin | unknown */
    source?: string;
    /** Bypass PT window (admin / tests only). */
    bypassPtWindow?: boolean;
  } = {},
): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const auth = authorizeCron(headers, env);
  if (!auth.ok) return { status: auth.status, body: { ok: false, message: auth.message } };

  if (env.OUTREACH_SCHEDULER_ENABLED !== undefined && env.OUTREACH_SCHEDULER_ENABLED !== '' && !truthy(env.OUTREACH_SCHEDULER_ENABLED)) {
    return {
      status: 200,
      body: { ok: true, skipped: true, message: 'OUTREACH_SCHEDULER_ENABLED is off.', live_email_send: false, auto_send: false },
    };
  }

  const nowMs = opts.nowMs ?? Date.now();
  const source = String(opts.source || 'unknown').slice(0, 64);
  const pacific = pacificParts(nowMs);
  const day_key = laDayKey(nowMs);

  // Automated path: forceJobs unset → PT window gate (finishes before 9 AM PT year-round).
  if (!opts.forceJobs?.length && !opts.bypassPtWindow && !shouldDispatchMorningPipeline(nowMs)) {
    const state = await readSchedulerState(env);
    return {
      status: 200,
      body: {
        ok: true,
        skipped: true,
        reason: isPacificWeekday(nowMs) ? 'outside_pt_dispatch_window' : 'weekend_pt',
        day_key,
        pacific,
        timezone: PACIFIC_TZ,
        dispatch_window_pt: '07:00–08:59',
        source_of_truth: SCHEDULER_SOURCE_OF_TRUTH,
        source,
        morning_pipeline_complete: isMorningPipelineComplete(state, day_key),
        live_email_send: false,
        auto_send: false,
        send_window_in_cron: false,
        message: isPacificWeekday(nowMs)
          ? `Skipped — outside America/Los_Angeles 07:00–08:59 (now ${String(pacific.hour).padStart(2, '0')}:${String(pacific.minute).padStart(2, '0')} PT). Idempotent; GHA retries hourly.`
          : 'Weekend PT — no outreach morning pipeline.',
      },
    };
  }

  const weekdayDue = opts.forceJobs?.length ? opts.forceJobs : morningPipelineJobs();
  const results: SchedulerJobResult[] = [];
  for (const job of weekdayDue) {
    results.push(
      await runSchedulerJob(job, env, {
        nowMs,
        fetchImpl: opts.fetchImpl,
        fixturesOnly: opts.fixturesOnly,
        seedProofFixtures: opts.seedProofFixtures,
      }),
    );
  }

  let state = await readSchedulerState(env);
  state.last_source = source;
  state.hobby_single_cron = true;
  await writeSchedulerState(state, env);
  state = await readSchedulerState(env);

  const failed = results.some((r) => r.status === 'failed');
  return {
    status: failed ? 502 : 200,
    body: {
      ok: !failed,
      day_key,
      pacific,
      timezone: PACIFIC_TZ,
      dispatch_window_pt: '07:00–08:59',
      in_start_hour: isMorningPipelineStartHour(nowMs),
      source_of_truth: SCHEDULER_SOURCE_OF_TRUTH,
      source,
      github_actions_cron: GITHUB_ACTIONS_CRON_SCHEDULE,
      vercel_backup_crons: [OUTREACH_CRON_SCHEDULE, OUTREACH_CRON_SCHEDULE_PST_BACKUP],
      cron_schedule: OUTREACH_CRON_SCHEDULE,
      cron_schedule_note: OUTREACH_CRON_SCHEDULE_NOTE,
      hobby_single_cron: true,
      morning_pipeline: MORNING_PIPELINE_JOBS,
      morning_pipeline_complete: isMorningPipelineComplete(state, day_key),
      due: weekdayDue,
      results,
      stages: state.stages,
      stages_day_key: state.stages_day_key,
      state: {
        last_job: state.last_job,
        last_status: state.last_status,
        last_message: state.last_message,
        last_at: state.last_at,
        last_error: state.last_error,
        last_source: state.last_source,
        hobby_single_cron: true,
      },
      live_email_send: false,
      auto_send: false,
      send_window_in_cron: false,
      message: weekdayDue.length
        ? `Morning pipeline (${source}): processed ${results.length} stage(s) sequentially before 9:00 AM PT target (no auto-send).`
        : 'No outreach jobs due.',
    },
  };
}

export async function getSchedulerDashboard(env: SchedulerEnv = process.env, nowMs = Date.now()) {
  const [state, runs, cap, controls, queue, interested, followUps, cohortDash] = await Promise.all([
    readSchedulerState(env),
    dbReadKv<SchedulerJobResult[]>(SCHEDULER_RUNS_KV, [], env),
    readDailyCapState(env, nowMs),
    readSendControls(env),
    readSendQueue(env),
    listInterestedNotify(env),
    listFollowUpDrafts(env),
    getDaily20Dashboard(env, { refresh: false, now: nowMs }).catch(() => null),
  ]);
  // Next run always computed in America/Los_Angeles (DST-safe).
  const nextCron = describeNextWeekdayRun(7, 0, nowMs);
  const nextDiscover = describeNextWeekdayRun(7, 0, nowMs);
  const nextVerify = describeNextWeekdayRun(8, 0, nowMs);
  const nextSelect = describeNextWeekdayRun(8, 30, nowMs);
  const nextNotify = describeNextWeekdayRun(9, 0, nowMs);
  const day_key = laDayKey(nowMs);
  const recent = Array.isArray(runs) ? runs : [];
  return {
    ok: true as const,
    mac_independent: true,
    timezone: PACIFIC_TZ,
    source_of_truth: SCHEDULER_SOURCE_OF_TRUTH,
    hobby_single_cron: true,
    github_actions_cron: GITHUB_ACTIONS_CRON_SCHEDULE,
    vercel_backup_crons: [OUTREACH_CRON_SCHEDULE, OUTREACH_CRON_SCHEDULE_PST_BACKUP],
    cron_schedule: OUTREACH_CRON_SCHEDULE,
    cron_schedule_note: OUTREACH_CRON_SCHEDULE_NOTE,
    mail_app_note:
      'Mail.app is Mac-only interim and cannot run when Mac is asleep. Morning prep: GitHub Actions (primary, PT-gated) + Vercel Hobby backup + Neon. Post-approval send uses Graph/Resend when enabled.',
    auto_send: false,
    send_window_in_cron: false,
    scheduler_enabled: env.OUTREACH_SCHEDULER_ENABLED === undefined || truthy(env.OUTREACH_SCHEDULER_ENABLED),
    pacific_now: pacificParts(nowMs),
    dispatch_window_pt: '07:00–08:59',
    morning_pipeline_complete: isMorningPipelineComplete(state, day_key),
    ready_for_review: {
      day_key,
      qualified: cohortDash?.cohort.qualified.length ?? 0,
      target: cohortDash?.cohort.target_qualify ?? 20,
      message: cohortDash?.cohort.message ?? null,
    },
    next_runs: {
      /** Next America/Los_Angeles 07:00 weekday (GHA primary tick). */
      cron: nextCron,
      discover: nextDiscover,
      verify: nextVerify,
      select: nextSelect,
      notify: nextNotify,
    },
    stages: state.stages,
    stages_day_key: state.stages_day_key,
    stage_intended_pt: STAGE_INTENDED_PT,
    last_successful_run: recent.find((r) => r.status === 'completed') || null,
    last_error: state.last_error,
    last_source: state.last_source,
    state,
    recent_runs: recent.slice(0, 20),
    execution_log: recent.slice(0, 20).map((r) => ({
      job: r.job,
      day_key: r.day_key,
      status: r.status,
      at: r.at,
      message: r.message,
    })),
    daily_counter: {
      sent_today: cap.sent_today,
      effective_cap: effectiveCap(cap, nowMs),
      remaining: remainingSends(cap, nowMs),
      day_key: cap.day_key,
    },
    tracking: {
      pending_send: queue.filter((i) => i.status === 'pending').length,
      submitted: queue.filter((i) => i.status === 'submitted').length,
      failed: queue.filter((i) => i.status === 'failed').length,
      bounced: controls.bounce_count,
      interested: interested.filter((i) => !i.acknowledged).length,
      follow_up_drafts: followUps.filter((d) => d.status === 'draft').length,
    },
    send_window: {
      enforce: controls.enforce_send_window,
      label: `${controls.window_start_hour_pt ?? 9}–${controls.window_end_hour_pt ?? 11} ${PACIFIC_TZ} (owner-approved only; not in auto cron)`,
    },
  };
}
