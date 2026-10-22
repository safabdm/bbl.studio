/**
 * Mac-independent Daily Outreach scheduler — Vercel cron + Neon.
 * Never auto-sends prospects. Owner must approve in Daily Review.
 * Mail.app cannot run when Mac is asleep — Graph/Resend only for post-approval send.
 */
import { dbReadKv, dbWriteKv, type CrmDbEnv } from './crm-db.js';
import { authorizeCron } from './crm-discovery-api.js';
import { runDiscoveryCycle, type DiscoveryRunnerEnv } from './crm-discovery-runner.js';
import { enrichNeedsEmailLeads } from './crm-discovery-enrich.js';
import {
  buildDaily20Cohort,
  getDaily20Dashboard,
  type Daily20Env,
} from './daily-20-pipeline.js';
import { laDayKey, readDailyCapState, remainingSends, effectiveCap } from './daily-cap.js';
import {
  generateFollowUpDrafts,
  listFollowUpDrafts,
  listInterestedNotify,
} from './follow-up-drafts.js';
import { notifyOwnerDailyReviewReady, type OwnerNotifyEnv } from './owner-notify.js';
import {
  describeNextWeekdayRun,
  isPacificTimeInRange,
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

export type SchedulerState = {
  last_job: SchedulerJobName | null;
  last_status: string | null;
  last_message: string | null;
  last_at: string | null;
  last_day_key: string | null;
  last_error: string | null;
  /** Idempotency: job:day_key → ISO completed */
  completed: Record<string, string>;
  updated_at: string;
};

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
    updated_at: nowIso(),
  };
}

export async function readSchedulerState(env: SchedulerEnv = process.env): Promise<SchedulerState> {
  const raw = await dbReadKv<SchedulerState | null>(SCHEDULER_STATE_KV, null, env);
  return raw && typeof raw === 'object' ? { ...emptyState(), ...raw, completed: raw.completed || {} } : emptyState();
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

/**
 * Which jobs are due for the current Pacific wall clock (Mon–Fri only).
 * Windows are intentionally small so a every-30m UTC dispatcher hits them once.
 */
export function jobsDueAt(ms = Date.now()): SchedulerJobName[] {
  if (!isPacificWeekday(ms)) return [];
  const due: SchedulerJobName[] = [];
  // 7:00–7:29 discover
  if (isPacificTimeInRange(ms, 7, 0, 7, 30)) due.push('discover');
  // 8:00–8:29 verify
  if (isPacificTimeInRange(ms, 8, 0, 8, 30)) due.push('verify');
  // 8:30–8:59 select
  if (isPacificTimeInRange(ms, 8, 30, 9, 0)) due.push('select');
  // 9:00–9:29 notify
  if (isPacificTimeInRange(ms, 9, 0, 9, 30)) due.push('notify');
  // 9:00–11:00 send window (idempotent per tick via process; not day-locked to one run)
  if (isPacificTimeInRange(ms, 9, 0, 11, 0)) due.push('send_window');
  // Midday + afternoon reply sweeps
  if (isPacificTimeInRange(ms, 12, 0, 12, 30) || isPacificTimeInRange(ms, 15, 0, 15, 30)) {
    due.push('replies');
  }
  // Follow-up draft gen once mid-morning after notify window
  if (isPacificTimeInRange(ms, 10, 0, 10, 30)) due.push('followups');
  return due;
}

export async function runSchedulerJob(
  job: SchedulerJobName,
  env: SchedulerEnv = process.env,
  opts: {
    nowMs?: number;
    force?: boolean;
    fetchImpl?: typeof fetch;
    /** Test-only: skip Places network */
    fixturesOnly?: boolean;
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

  try {
    let result: SchedulerJobResult;

    if (job === 'discover') {
      if (opts.fixturesOnly) {
        result = {
          job,
          day_key,
          status: 'completed',
          message: 'Discover skipped in fixtures mode (no Places call).',
          at,
          details: { fixturesOnly: true },
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
          message: 'Verify fixtures: enrichment skipped.',
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
      const cohort = await buildDaily20Cohort(
        { fixturesOnly: opts.fixturesOnly, now: nowMs },
        env,
      );
      // Quality bar: do not pad — cohort already caps by verified observation+email
      result = {
        job,
        day_key,
        status: 'completed',
        message: cohort.message,
        at,
        details: {
          qualified: cohort.qualified.length,
          discovered_count: cohort.discovered_count,
          rejected: cohort.rejected_pool.length,
          padded: false,
        },
      };
    } else if (job === 'notify') {
      const dash = await getDaily20Dashboard(env, { refresh: false, now: nowMs });
      const notify = await notifyOwnerDailyReviewReady(
        {
          day_key,
          qualified_count: dash.cohort.qualified.length,
          discovered_count: dash.cohort.discovered_count,
          message: dash.cohort.message,
        },
        env,
        opts.fetchImpl || fetch,
      );
      result = {
        job,
        day_key,
        status: notify.ok ? 'completed' : 'failed',
        message: notify.ok
          ? `Owner notified via ${notify.channel} → ${notify.to} (no prospect send).`
          : `Owner notify failed: ${notify.error}`,
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

    // Persist idempotency for day-locked successes
    if (result.status === 'completed' && dayLocked.includes(job)) {
      state = await readSchedulerState(env);
      state.completed[idempotencyKey(job, day_key)] = at;
    }
    state.last_job = job;
    state.last_status = result.status;
    state.last_message = result.message;
    state.last_at = at;
    state.last_day_key = day_key;
    state.last_error = result.status === 'failed' ? result.message : null;
    await writeSchedulerState(state, env);
    await appendRun(result, env);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Scheduler job failed';
    const failed: SchedulerJobResult = { job, day_key, status: 'failed', message, at };
    state = await readSchedulerState(env);
    state.last_job = job;
    state.last_status = 'failed';
    state.last_message = message;
    state.last_at = at;
    state.last_day_key = day_key;
    state.last_error = message;
    await writeSchedulerState(state, env);
    await appendRun(failed, env);
    return failed;
  }
}

/**
 * Dispatcher for Vercel cron — runs all due jobs for current PT clock.
 * Idempotent per job/day. Never prospect-sends without approval + flags.
 */
export async function dispatchOutreachCron(
  headers: { authorization?: string | null },
  env: SchedulerEnv = process.env,
  opts: {
    nowMs?: number;
    forceJobs?: SchedulerJobName[];
    fetchImpl?: typeof fetch;
    fixturesOnly?: boolean;
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
      body: { ok: true, skipped: true, message: 'OUTREACH_SCHEDULER_ENABLED is off.', live_email_send: false },
    };
  }

  const nowMs = opts.nowMs ?? Date.now();
  const due = opts.forceJobs?.length ? opts.forceJobs : jobsDueAt(nowMs);
  const results: SchedulerJobResult[] = [];
  for (const job of due) {
    results.push(
      await runSchedulerJob(job, env, {
        nowMs,
        fetchImpl: opts.fetchImpl,
        fixturesOnly: opts.fixturesOnly,
      }),
    );
  }

  const state = await readSchedulerState(env);
  return {
    status: results.some((r) => r.status === 'failed') ? 502 : 200,
    body: {
      ok: !results.some((r) => r.status === 'failed'),
      day_key: laDayKey(nowMs),
      pacific: pacificParts(nowMs),
      due,
      results,
      state: {
        last_job: state.last_job,
        last_status: state.last_status,
        last_message: state.last_message,
        last_at: state.last_at,
        last_error: state.last_error,
      },
      live_email_send: false,
      auto_send: false,
      message: due.length
        ? `Processed ${results.length} job(s).`
        : 'No outreach jobs due at this Pacific time.',
    },
  };
}

export async function getSchedulerDashboard(env: SchedulerEnv = process.env, nowMs = Date.now()) {
  const [state, runs, cap, controls, queue, interested, followUps] = await Promise.all([
    readSchedulerState(env),
    dbReadKv<SchedulerJobResult[]>(SCHEDULER_RUNS_KV, [], env),
    readDailyCapState(env, nowMs),
    readSendControls(env),
    readSendQueue(env),
    listInterestedNotify(env),
    listFollowUpDrafts(env),
  ]);
  const nextDiscover = describeNextWeekdayRun(7, 0, nowMs);
  const nextSelect = describeNextWeekdayRun(8, 30, nowMs);
  const nextNotify = describeNextWeekdayRun(9, 0, nowMs);
  return {
    ok: true as const,
    mac_independent: true,
    mail_app_note:
      'Mail.app is Mac-only interim and cannot run when Mac is asleep. Scheduler prep uses Vercel cron + Neon; post-approval send uses Graph/Resend when enabled.',
    auto_send: false,
    scheduler_enabled: env.OUTREACH_SCHEDULER_ENABLED === undefined || truthy(env.OUTREACH_SCHEDULER_ENABLED),
    pacific_now: pacificParts(nowMs),
    next_runs: {
      discover: nextDiscover,
      select: nextSelect,
      notify: nextNotify,
    },
    last_successful_run: (Array.isArray(runs) ? runs : []).find((r) => r.status === 'completed') || null,
    last_error: state.last_error,
    state,
    recent_runs: (Array.isArray(runs) ? runs : []).slice(0, 20),
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
      label: `${controls.window_start_hour_pt ?? 9}–${controls.window_end_hour_pt ?? 11} PT`,
    },
  };
}
