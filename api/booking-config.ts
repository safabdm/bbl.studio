/**
 * Central booking configuration. Durations and windows are env-driven —
 * never hard-code consultation length at call sites.
 */

export type BookingConfig = {
  timezone: string;
  timezoneLabel: string;
  durationMinutes: number;
  minNoticeHours: number;
  maxDaysAhead: number;
  slotIntervalMinutes: number;
  /** 0=Sun … 6=Sat */
  workDays: number[];
  workStartHour: number;
  workStartMinute: number;
  workEndHour: number;
  workEndMinute: number;
  calendarId: string;
  titlePrefix: string;
};

function intEnv(name: string, fallback: number) {
  const raw = (process.env[name] || '').trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function parseWorkDays(raw: string | undefined, fallback: number[]) {
  if (!raw?.trim()) return fallback;
  const days = raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  return days.length ? days : fallback;
}

export function bookingConfig(): BookingConfig {
  const timezone = (process.env.BOOKING_TIMEZONE || 'America/Los_Angeles').trim() || 'America/Los_Angeles';
  return {
    timezone,
    timezoneLabel: (process.env.BOOKING_TIMEZONE_LABEL || 'Pacific Time (PT)').trim() || 'Pacific Time (PT)',
    durationMinutes: Math.max(15, intEnv('BOOKING_DURATION_MINUTES', 30)),
    minNoticeHours: Math.max(1, intEnv('BOOKING_MIN_NOTICE_HOURS', 48)),
    maxDaysAhead: Math.max(7, intEnv('BOOKING_MAX_DAYS_AHEAD', 28)),
    slotIntervalMinutes: Math.max(15, intEnv('BOOKING_SLOT_INTERVAL_MINUTES', 30)),
    workDays: parseWorkDays(process.env.BOOKING_WORK_DAYS, [1, 2, 3, 4, 5]),
    workStartHour: intEnv('BOOKING_WORK_START_HOUR', 10),
    workStartMinute: intEnv('BOOKING_WORK_START_MINUTE', 0),
    workEndHour: intEnv('BOOKING_WORK_END_HOUR', 16),
    workEndMinute: intEnv('BOOKING_WORK_END_MINUTE', 0),
    calendarId: (process.env.GOOGLE_CALENDAR_ID || 'primary').trim() || 'primary',
    titlePrefix: (process.env.BOOKING_EVENT_TITLE_PREFIX || 'BBL Studio Consultation').trim(),
  };
}

export function googleCalendarConfigured() {
  const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
  const refreshToken = (process.env.GOOGLE_REFRESH_TOKEN || '').trim();
  return Boolean(clientId && clientSecret && refreshToken);
}

/** Local JSON store used only when Google Calendar OAuth is not configured (dev / unconfigured). */
export function localBookingStorePath() {
  if (process.env.BOOKING_STORE_PATH) return process.env.BOOKING_STORE_PATH;
  if (process.env.VERCEL) return '/tmp/bbls-bookings.json';
  return `${process.cwd()}/data/bookings.json`;
}
