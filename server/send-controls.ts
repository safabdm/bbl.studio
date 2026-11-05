/**
 * Persisted send queue + Pause / Resume / Cancel.
 * Rate limit 1 send / 60–120s randomized.
 * Auto-pause bounce > 5% or any complaint.
 * Explicit approve lists recipients; refresh must not resend.
 */
import { randomUUID } from 'node:crypto';
import { dbReadKv, dbWriteKv, type CrmDbEnv } from './crm-db.js';
import {
  effectiveCap,
  maybeResetForNewLaDay,
  readDailyCapState,
  recordSuccessfulSend,
  remainingSends,
  type DailyCapEnv,
} from './daily-cap.js';
import { normalizeOutreachStatus, type OutreachStatus } from './outreach-status.js';

export const SEND_QUEUE_KV = 'outreach:send_queue';
export const SEND_CONTROLS_KV = 'outreach:send_controls';

export const RATE_LIMIT_MIN_MS = 60_000;
export const RATE_LIMIT_MAX_MS = 120_000;
export const AUTO_PAUSE_BOUNCE_RATE = 0.05;

export type SendQueueItemStatus = 'pending' | 'sending' | 'submitted' | 'failed' | 'cancelled' | 'skipped';

export type SendQueueItem = {
  id: string;
  lead_id: string;
  email: string;
  business_name: string;
  subject: string;
  body: string;
  draft_id: string;
  status: SendQueueItemStatus;
  outreach_status: OutreachStatus;
  provider_message_id: string | null;
  error: string | null;
  approved_at: string;
  sent_at: string | null;
  /** Idempotency — once submitted/cancelled, never resent on refresh. */
  attempt_token: string;
};

export type SendControlsState = {
  paused: boolean;
  paused_at: string | null;
  paused_reason: string | null;
  cancelled: boolean;
  last_send_at: string | null;
  next_eligible_at: string | null;
  bounce_count: number;
  complaint_count: number;
  submitted_count: number;
  auto_paused: boolean;
  /**
   * When true (default), live process_one only allowed 9:00–11:00 America/Los_Angeles.
   * Owner can disable for testing; never auto-sends.
   */
  enforce_send_window: boolean;
  /** Inclusive start hour PT (default 9). */
  window_start_hour_pt: number;
  /** Exclusive end hour PT (default 11). */
  window_end_hour_pt: number;
  updated_at: string;
};

export type SendControlsEnv = CrmDbEnv & DailyCapEnv;

function nowIso(ms = Date.now()): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function randomRateLimitMs(rng: () => number = Math.random): number {
  const span = RATE_LIMIT_MAX_MS - RATE_LIMIT_MIN_MS;
  return RATE_LIMIT_MIN_MS + Math.floor(rng() * (span + 1));
}

function emptyControls(ms = Date.now()): SendControlsState {
  return {
    paused: false,
    paused_at: null,
    paused_reason: null,
    cancelled: false,
    last_send_at: null,
    next_eligible_at: null,
    bounce_count: 0,
    complaint_count: 0,
    submitted_count: 0,
    auto_paused: false,
    enforce_send_window: true,
    window_start_hour_pt: 9,
    window_end_hour_pt: 11,
    updated_at: nowIso(ms),
  };
}

/** Current hour (0–23) in America/Los_Angeles. */
export function laHour(ms = Date.now()): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  return Number.isFinite(hour) ? hour : 0;
}

/** True when now is within [start, end) PT. */
export function isWithinSendWindow(
  controls: Pick<SendControlsState, 'enforce_send_window' | 'window_start_hour_pt' | 'window_end_hour_pt'>,
  nowMs = Date.now(),
): boolean {
  if (!controls.enforce_send_window) return true;
  const hour = laHour(nowMs);
  const start = controls.window_start_hour_pt ?? 9;
  const end = controls.window_end_hour_pt ?? 11;
  return hour >= start && hour < end;
}

export async function readSendControls(env: SendControlsEnv = process.env): Promise<SendControlsState> {
  const raw = await dbReadKv<SendControlsState | null>(SEND_CONTROLS_KV, null, env);
  return raw && typeof raw === 'object' ? { ...emptyControls(), ...raw } : emptyControls();
}

export async function writeSendControls(
  state: SendControlsState,
  env: SendControlsEnv = process.env,
): Promise<SendControlsState> {
  const next = { ...state, updated_at: nowIso() };
  await dbWriteKv(SEND_CONTROLS_KV, next, env);
  return next;
}

export async function readSendQueue(env: SendControlsEnv = process.env): Promise<SendQueueItem[]> {
  const raw = await dbReadKv<SendQueueItem[]>(SEND_QUEUE_KV, [], env);
  return Array.isArray(raw) ? raw : [];
}

export async function writeSendQueue(
  items: SendQueueItem[],
  env: SendControlsEnv = process.env,
): Promise<void> {
  await dbWriteKv(SEND_QUEUE_KV, items, env);
}

/**
 * Owner explicit approve — lists recipients into persisted queue.
 * Re-approving the same draft_id+email that already submitted is a no-op (no resend).
 */
export async function enqueueApprovedRecipients(
  recipients: Array<{
    lead_id: string;
    email: string;
    business_name: string;
    subject: string;
    body: string;
    draft_id: string;
  }>,
  env: SendControlsEnv = process.env,
): Promise<{ queue: SendQueueItem[]; added: number; skipped: number }> {
  const existing = await readSendQueue(env);
  const byKey = new Map(existing.map((item) => [`${item.draft_id}:${item.email.toLowerCase()}`, item]));
  let added = 0;
  let skipped = 0;
  const now = nowIso();

  for (const r of recipients) {
    const email = String(r.email || '')
      .trim()
      .toLowerCase();
    if (!email) {
      skipped += 1;
      continue;
    }
    const key = `${r.draft_id}:${email}`;
    const prev = byKey.get(key);
    if (prev && (prev.status === 'submitted' || prev.status === 'sending')) {
      skipped += 1;
      continue;
    }
    if (prev && prev.status === 'pending') {
      skipped += 1;
      continue;
    }
    const item: SendQueueItem = {
      id: randomUUID(),
      lead_id: String(r.lead_id),
      email,
      business_name: r.business_name,
      subject: r.subject,
      body: r.body,
      draft_id: r.draft_id,
      status: 'pending',
      outreach_status: 'queued',
      provider_message_id: null,
      error: null,
      approved_at: now,
      sent_at: null,
      attempt_token: randomUUID(),
    };
    byKey.set(key, item);
    added += 1;
  }

  // Clear cancelled flag when new batch approved
  const controls = await readSendControls(env);
  if (controls.cancelled) {
    await writeSendControls({ ...controls, cancelled: false }, env);
  }

  const queue = [...byKey.values()];
  await writeSendQueue(queue, env);
  return { queue, added, skipped };
}

export async function pauseSending(
  reason: string,
  env: SendControlsEnv = process.env,
  auto = false,
): Promise<SendControlsState> {
  const state = await readSendControls(env);
  return writeSendControls(
    {
      ...state,
      paused: true,
      paused_at: nowIso(),
      paused_reason: reason || 'Paused by owner',
      auto_paused: auto,
    },
    env,
  );
}

export async function resumeSending(env: SendControlsEnv = process.env): Promise<SendControlsState> {
  const state = await readSendControls(env);
  return writeSendControls(
    {
      ...state,
      paused: false,
      paused_at: null,
      paused_reason: null,
      auto_paused: false,
      cancelled: false,
    },
    env,
  );
}

export async function cancelSending(env: SendControlsEnv = process.env): Promise<{
  controls: SendControlsState;
  queue: SendQueueItem[];
}> {
  const controls = await writeSendControls(
    {
      ...(await readSendControls(env)),
      cancelled: true,
      paused: true,
      paused_at: nowIso(),
      paused_reason: 'Cancelled by owner',
      auto_paused: false,
    },
    env,
  );
  const queue = (await readSendQueue(env)).map((item) =>
    item.status === 'pending' || item.status === 'sending'
      ? { ...item, status: 'cancelled' as const, outreach_status: normalizeOutreachStatus('unknown') }
      : item,
  );
  await writeSendQueue(queue, env);
  return { controls, queue };
}

export function shouldAutoPause(controls: SendControlsState): { pause: boolean; reason: string | null } {
  if (controls.complaint_count > 0) {
    return { pause: true, reason: 'Auto-paused: complaint received (complaint_count > 0).' };
  }
  if (controls.submitted_count > 0) {
    const rate = controls.bounce_count / controls.submitted_count;
    if (rate > AUTO_PAUSE_BOUNCE_RATE) {
      return {
        pause: true,
        reason: `Auto-paused: bounce rate ${(rate * 100).toFixed(1)}% exceeds 5%.`,
      };
    }
  }
  return { pause: false, reason: null };
}

export async function recordBounceOrComplaint(
  kind: 'bounce' | 'complaint',
  env: SendControlsEnv = process.env,
): Promise<SendControlsState> {
  let controls = await readSendControls(env);
  if (kind === 'bounce') controls = { ...controls, bounce_count: controls.bounce_count + 1 };
  else controls = { ...controls, complaint_count: controls.complaint_count + 1 };
  controls = await writeSendControls(controls, env);
  const check = shouldAutoPause(controls);
  if (check.pause && !controls.paused) {
    return pauseSending(check.reason || 'Auto-paused', env, true);
  }
  return controls;
}

export type SendOneFn = (item: SendQueueItem) => Promise<{
  ok: boolean;
  provider_message_id?: string;
  error?: string;
}>;

/**
 * Process at most one pending item if rate limit + cap + not paused.
 * Dev/tests inject sendFn with mocked fetch — never real network by default.
 */
export async function processNextSend(
  sendFn: SendOneFn,
  env: SendControlsEnv = process.env,
  opts: { nowMs?: number; rng?: () => number; allowLive?: boolean } = {},
): Promise<{
  processed: boolean;
  item: SendQueueItem | null;
  controls: SendControlsState;
  message: string;
}> {
  const nowMs = opts.nowMs ?? Date.now();
  let controls = await readSendControls(env);
  const auto = shouldAutoPause(controls);
  if (auto.pause && !controls.paused) {
    controls = await pauseSending(auto.reason || 'Auto-paused', env, true);
  }

  if (controls.cancelled) {
    return { processed: false, item: null, controls, message: 'Send cancelled.' };
  }
  if (controls.paused) {
    return { processed: false, item: null, controls, message: controls.paused_reason || 'Sending paused.' };
  }
  if (!isWithinSendWindow(controls, nowMs)) {
    return {
      processed: false,
      item: null,
      controls,
      message: `Outside send window (${controls.window_start_hour_pt ?? 9}–${controls.window_end_hour_pt ?? 11} America/Los_Angeles). Queue stays pending — not marked sent.`,
    };
  }

  if (controls.next_eligible_at) {
    const next = Date.parse(controls.next_eligible_at);
    if (Number.isFinite(next) && nowMs < next) {
      return {
        processed: false,
        item: null,
        controls,
        message: `Rate limited until ${controls.next_eligible_at}.`,
      };
    }
  }

  let capState = maybeResetForNewLaDay(await readDailyCapState(env, nowMs), nowMs);
  if (remainingSends(capState, nowMs) <= 0) {
    return {
      processed: false,
      item: null,
      controls,
      message: `Daily cap reached (${effectiveCap(capState, nowMs)}/day LA).`,
    };
  }

  // Live send requires explicit allowLive — default safe.
  if (!opts.allowLive) {
    return {
      processed: false,
      item: null,
      controls,
      message: 'Live send disabled in this context (dev/CI mock only unless allowLive).',
    };
  }

  const queue = await readSendQueue(env);
  const idx = queue.findIndex((item) => item.status === 'pending');
  if (idx < 0) {
    return { processed: false, item: null, controls, message: 'No pending recipients.' };
  }

  const item = { ...queue[idx]!, status: 'sending' as const };
  queue[idx] = item;
  await writeSendQueue(queue, env);

  const result = await sendFn(item);
  if (result.ok) {
    queue[idx] = {
      ...item,
      status: 'submitted',
      outreach_status: 'submitted',
      provider_message_id: result.provider_message_id || null,
      sent_at: nowIso(nowMs),
      error: null,
    };
    controls = await writeSendControls(
      {
        ...controls,
        submitted_count: controls.submitted_count + 1,
        last_send_at: nowIso(nowMs),
        next_eligible_at: nowIso(nowMs + randomRateLimitMs(opts.rng)),
      },
      env,
    );
    await recordSuccessfulSend(1, env, nowMs);
  } else {
    queue[idx] = {
      ...item,
      status: 'failed',
      error: result.error || 'Send failed',
      outreach_status: 'unknown',
    };
    controls = await writeSendControls(
      {
        ...controls,
        last_send_at: nowIso(nowMs),
        next_eligible_at: nowIso(nowMs + randomRateLimitMs(opts.rng)),
      },
      env,
    );
  }
  await writeSendQueue(queue, env);
  return {
    processed: true,
    item: queue[idx]!,
    controls,
    message: result.ok ? 'Submitted.' : result.error || 'Failed.',
  };
}

/** Refresh-safe: already submitted items stay submitted. */
export function countResendRisk(queue: SendQueueItem[]): { pending: number; submitted: number } {
  return {
    pending: queue.filter((i) => i.status === 'pending').length,
    submitted: queue.filter((i) => i.status === 'submitted').length,
  };
}
