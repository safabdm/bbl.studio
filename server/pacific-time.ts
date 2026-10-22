/**
 * America/Los_Angeles helpers for cron scheduling.
 * Vercel crons are UTC — resolve “what PT job is due” with DST-aware Intl.
 */

export const PACIFIC_TZ = 'America/Los_Angeles';

export type PacificParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: string; // short: Mon, Tue, …
  dayKey: string; // YYYY-MM-DD
};

export function pacificParts(ms = Date.now()): PacificParts {
  const d = new Date(ms);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: PACIFIC_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
    hourCycle: 'h23',
  });
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  const hour = Number(map.hour);
  const minute = Number(map.minute);
  return {
    year,
    month,
    day,
    hour,
    minute,
    weekday: map.weekday || '',
    dayKey: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

export function isPacificWeekday(ms = Date.now()): boolean {
  const wd = pacificParts(ms).weekday;
  return !['Sat', 'Sun'].includes(wd);
}

/**
 * True when current Pacific time is within [startHour:startMin, endHour:endMin).
 * end is exclusive.
 */
export function isPacificTimeInRange(
  ms: number,
  startHour: number,
  startMin: number,
  endHour: number,
  endMin: number,
): boolean {
  const p = pacificParts(ms);
  const cur = p.hour * 60 + p.minute;
  const start = startHour * 60 + startMin;
  const end = endHour * 60 + endMin;
  return cur >= start && cur < end;
}

/**
 * Approximate next UTC Instant for a Pacific wall-clock on a given LA dayKey.
 * Uses iterative search (±1 day window) — DST-safe without external libs.
 */
export function pacificWallClockToUtcMs(
  dayKey: string,
  hour: number,
  minute = 0,
): number {
  // Noon UTC on that calendar date as seed, then scan
  const [y, m, d] = dayKey.split('-').map(Number);
  let guess = Date.UTC(y!, m! - 1, d!, 12, 0, 0);
  // Scan from dayKey 00:00 PT ≈ dayKey 07:00–08:00 UTC through +24h
  const start = guess - 20 * 60 * 60 * 1000;
  const end = guess + 20 * 60 * 60 * 1000;
  for (let t = start; t <= end; t += 60 * 1000) {
    const p = pacificParts(t);
    if (p.dayKey === dayKey && p.hour === hour && p.minute === minute) return t;
  }
  // Fallback: construct via formatter offset probe
  return guess;
}

/** Human label for next run given a PT hour:minute on next weekday. */
export function describeNextWeekdayRun(hour: number, minute: number, fromMs = Date.now()): {
  dayKey: string;
  at_utc: string;
  at_pt: string;
} {
  let cursor = fromMs;
  for (let i = 0; i < 10; i++) {
    const p = pacificParts(cursor);
    const targetMs = pacificWallClockToUtcMs(p.dayKey, hour, minute);
    if (isPacificWeekday(targetMs) && targetMs > fromMs + 30_000) {
      return {
        dayKey: p.dayKey,
        at_utc: new Date(targetMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        at_pt: `${p.dayKey} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} PT`,
      };
    }
    // advance to next LA midnight-ish
    cursor = pacificWallClockToUtcMs(p.dayKey, 23, 59) + 120_000;
  }
  const p = pacificParts(fromMs);
  return {
    dayKey: p.dayKey,
    at_utc: new Date(fromMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    at_pt: `${p.dayKey} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} PT`,
  };
}
