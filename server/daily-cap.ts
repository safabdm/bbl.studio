/**
 * Daily send cap — Neon-stored, LA midnight reset.
 * Cap is a ceiling, not permission. Ramp-up week1 max 20/day.
 * Cap raise suggestions never auto-apply — owner must click.
 */
import { dbReadKv, dbWriteKv, type CrmDbEnv } from './crm-db.js';

export const DAILY_CAP_KV = 'outreach:daily_cap';
export const DEFAULT_DAILY_SEND_CAP = 20;
export const MIN_DAILY_SEND_CAP = 10;
export const MAX_DAILY_SEND_CAP = 100;
export const RAMP_WEEK1_MAX = 20;
export const SUGGEST_MIN_SENDS = 50;
export const SUGGEST_MAX_BOUNCE_RATE = 0.02;

export type DailyCapState = {
  /** Owner-configured ceiling (clamped 10–100). */
  cap: number;
  /** Sends counted for the current LA calendar day. */
  sent_today: number;
  /** YYYY-MM-DD in America/Los_Angeles */
  day_key: string;
  /** ISO when ramp window started (first live send day). */
  ramp_started_at: string | null;
  /** Pending suggestion — never applied until owner confirms. */
  suggested_cap: number | null;
  suggestion_reason: string | null;
  updated_at: string;
};

export type DailyCapEnv = CrmDbEnv & {
  DAILY_SEND_CAP?: string;
};

function nowIso(ms = Date.now()): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Calendar date in America/Los_Angeles as YYYY-MM-DD. */
export function laDayKey(ms = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

export function clampDailyCap(raw: number): number {
  if (!Number.isFinite(raw)) return DEFAULT_DAILY_SEND_CAP;
  return Math.min(MAX_DAILY_SEND_CAP, Math.max(MIN_DAILY_SEND_CAP, Math.round(raw)));
}

export function parseEnvDailyCap(env: DailyCapEnv = process.env): number {
  const raw = Number.parseInt(String(env.DAILY_SEND_CAP || ''), 10);
  if (!Number.isFinite(raw)) return DEFAULT_DAILY_SEND_CAP;
  return clampDailyCap(raw);
}

function defaultState(env: DailyCapEnv, ms = Date.now()): DailyCapState {
  return {
    cap: parseEnvDailyCap(env),
    sent_today: 0,
    day_key: laDayKey(ms),
    ramp_started_at: null,
    suggested_cap: null,
    suggestion_reason: null,
    updated_at: nowIso(ms),
  };
}

export async function readDailyCapState(
  env: DailyCapEnv = process.env,
  nowMs = Date.now(),
): Promise<DailyCapState> {
  const raw = await dbReadKv<DailyCapState | null>(DAILY_CAP_KV, null, env);
  const base = raw && typeof raw === 'object' ? { ...defaultState(env, nowMs), ...raw } : defaultState(env, nowMs);
  return maybeResetForNewLaDay(base, nowMs);
}

/** Reset counter at midnight America/Los_Angeles (new day_key). */
export function maybeResetForNewLaDay(state: DailyCapState, nowMs = Date.now()): DailyCapState {
  const today = laDayKey(nowMs);
  if (state.day_key === today) return state;
  return {
    ...state,
    sent_today: 0,
    day_key: today,
    updated_at: nowIso(nowMs),
  };
}

export async function writeDailyCapState(
  state: DailyCapState,
  env: DailyCapEnv = process.env,
): Promise<DailyCapState> {
  const next = { ...state, updated_at: nowIso() };
  await dbWriteKv(DAILY_CAP_KV, next, env);
  return next;
}

export function isWithinRampWeek1(state: DailyCapState, nowMs = Date.now()): boolean {
  if (!state.ramp_started_at) return true;
  const start = Date.parse(state.ramp_started_at);
  if (!Number.isFinite(start)) return true;
  return nowMs - start < 7 * 24 * 60 * 60 * 1000;
}

export function effectiveCap(state: DailyCapState, nowMs = Date.now()): number {
  const cap = clampDailyCap(state.cap);
  if (isWithinRampWeek1(state, nowMs)) return Math.min(cap, RAMP_WEEK1_MAX);
  return cap;
}

export function remainingSends(state: DailyCapState, nowMs = Date.now()): number {
  const reset = maybeResetForNewLaDay(state, nowMs);
  return Math.max(0, effectiveCap(reset, nowMs) - reset.sent_today);
}

export async function recordSuccessfulSend(
  count = 1,
  env: DailyCapEnv = process.env,
  nowMs = Date.now(),
): Promise<DailyCapState> {
  let state = await readDailyCapState(env, nowMs);
  state = maybeResetForNewLaDay(state, nowMs);
  if (!state.ramp_started_at) state.ramp_started_at = nowIso(nowMs);
  state.sent_today += Math.max(0, count);
  return writeDailyCapState(state, env);
}

export async function setDailyCap(
  nextCap: number,
  env: DailyCapEnv = process.env,
  nowMs = Date.now(),
): Promise<DailyCapState> {
  const state = await readDailyCapState(env, nowMs);
  const capped = clampDailyCap(nextCap);
  // During week 1, stored cap may be higher but effective stays ≤20.
  return writeDailyCapState(
    {
      ...state,
      cap: capped,
      suggested_cap: null,
      suggestion_reason: null,
    },
    env,
  );
}

/**
 * Suggest a higher cap when bounce < 2%, complaint = 0, ≥50 sends.
 * Never auto-applies — stores suggestion only.
 */
export async function maybeSuggestCapRaise(
  metrics: { total_sends: number; bounces: number; complaints: number },
  env: DailyCapEnv = process.env,
  nowMs = Date.now(),
): Promise<DailyCapState> {
  const state = await readDailyCapState(env, nowMs);
  const sends = metrics.total_sends;
  const bounceRate = sends > 0 ? metrics.bounces / sends : 1;
  const eligible =
    sends >= SUGGEST_MIN_SENDS &&
    bounceRate < SUGGEST_MAX_BOUNCE_RATE &&
    metrics.complaints === 0 &&
    !isWithinRampWeek1(state, nowMs);

  if (!eligible) {
    return writeDailyCapState(
      {
        ...state,
        suggested_cap: null,
        suggestion_reason: null,
      },
      env,
    );
  }

  const suggested = clampDailyCap(Math.min(MAX_DAILY_SEND_CAP, state.cap + 10));
  if (suggested <= state.cap) {
    return writeDailyCapState({ ...state, suggested_cap: null, suggestion_reason: null }, env);
  }

  return writeDailyCapState(
    {
      ...state,
      suggested_cap: suggested,
      suggestion_reason: `bounce_rate=${(bounceRate * 100).toFixed(2)}% complaints=0 sends=${sends} — owner must click Apply`,
    },
    env,
  );
}

/** Owner explicitly applies a pending suggestion — never called automatically. */
export async function applySuggestedCap(
  env: DailyCapEnv = process.env,
  nowMs = Date.now(),
): Promise<{ ok: true; state: DailyCapState } | { ok: false; message: string }> {
  const state = await readDailyCapState(env, nowMs);
  if (state.suggested_cap == null) {
    return { ok: false, message: 'No pending cap suggestion to apply.' };
  }
  const next = await setDailyCap(state.suggested_cap, env, nowMs);
  return { ok: true, state: next };
}
