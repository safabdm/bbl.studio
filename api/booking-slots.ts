import { bookingConfig, type BookingConfig } from './booking-config.js';
import {
  addCalendarDays,
  formatTimeLabel,
  getZonedParts,
  overlaps,
  ymdInZone,
  zonedLocalToUtc,
} from './booking-timezone.js';

export type BusyInterval = { start: string; end: string };

export type AvailableSlot = {
  start: string;
  end: string;
  date: string;
  timeLabel: string;
  endLabel: string;
};

function parseYmd(ymd: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

export function earliestBookableInstant(now = new Date(), config: BookingConfig = bookingConfig()) {
  return new Date(now.getTime() + config.minNoticeHours * 60 * 60 * 1000);
}

export function assertSlotMeetsNotice(startIso: string, now = new Date(), config: BookingConfig = bookingConfig()) {
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) {
    return { ok: false as const, message: 'Invalid start time.' };
  }
  if (start.getTime() <= now.getTime()) {
    return { ok: false as const, message: 'Past times cannot be booked.' };
  }
  const earliest = earliestBookableInstant(now, config);
  if (start.getTime() < earliest.getTime()) {
    return {
      ok: false as const,
      message: `Consultations require at least ${config.minNoticeHours} hours notice.`,
    };
  }
  return { ok: true as const, start };
}

/** Generate candidate slots for one calendar day in the studio timezone. */
export function generateDaySlots(ymd: string, config: BookingConfig = bookingConfig()): AvailableSlot[] {
  const parsed = parseYmd(ymd);
  if (!parsed) return [];

  const probe = zonedLocalToUtc(parsed.year, parsed.month, parsed.day, 12, 0, config.timezone);
  const weekday = getZonedParts(probe, config.timezone).weekday;
  if (!config.workDays.includes(weekday)) return [];

  const dayStart = zonedLocalToUtc(
    parsed.year,
    parsed.month,
    parsed.day,
    config.workStartHour,
    config.workStartMinute,
    config.timezone,
  );
  const dayEnd = zonedLocalToUtc(
    parsed.year,
    parsed.month,
    parsed.day,
    config.workEndHour,
    config.workEndMinute,
    config.timezone,
  );

  const slots: AvailableSlot[] = [];
  const durationMs = config.durationMinutes * 60 * 1000;
  const stepMs = config.slotIntervalMinutes * 60 * 1000;

  for (let cursor = dayStart.getTime(); cursor + durationMs <= dayEnd.getTime(); cursor += stepMs) {
    const start = new Date(cursor);
    const end = new Date(cursor + durationMs);
    const startParts = getZonedParts(start, config.timezone);
    const endParts = getZonedParts(end, config.timezone);
    slots.push({
      start: start.toISOString(),
      end: end.toISOString(),
      date: ymd,
      timeLabel: formatTimeLabel(startParts.hour, startParts.minute),
      endLabel: formatTimeLabel(endParts.hour, endParts.minute),
    });
  }
  return slots;
}

export function listCandidateDates(now = new Date(), config: BookingConfig = bookingConfig()) {
  const earliest = earliestBookableInstant(now, config);
  const startParts = getZonedParts(earliest, config.timezone);
  const dates: string[] = [];

  for (let i = 0; i <= config.maxDaysAhead + 2; i += 1) {
    const day = addCalendarDays(startParts.year, startParts.month, startParts.day, i);
    const ymd = `${day.year}-${String(day.month).padStart(2, '0')}-${String(day.day).padStart(2, '0')}`;
    const noon = zonedLocalToUtc(day.year, day.month, day.day, 12, 0, config.timezone);
    const limit = new Date(now.getTime() + config.maxDaysAhead * 24 * 60 * 60 * 1000);
    if (noon.getTime() > limit.getTime()) break;
    const weekday = getZonedParts(noon, config.timezone).weekday;
    if (!config.workDays.includes(weekday)) continue;
    if (generateDaySlots(ymd, config).some((slot) => new Date(slot.start).getTime() >= earliest.getTime())) {
      dates.push(ymd);
    }
  }
  return dates;
}

export function filterAvailableSlots(
  candidates: AvailableSlot[],
  busy: BusyInterval[],
  now = new Date(),
  config: BookingConfig = bookingConfig(),
) {
  const earliest = earliestBookableInstant(now, config).getTime();
  const busyMs = busy.map((item) => ({
    start: new Date(item.start).getTime(),
    end: new Date(item.end).getTime(),
  }));

  return candidates.filter((slot) => {
    const start = new Date(slot.start).getTime();
    const end = new Date(slot.end).getTime();
    if (Number.isNaN(start) || Number.isNaN(end)) return false;
    if (start < earliest) return false;
    if (start <= now.getTime()) return false;
    return !busyMs.some((block) => overlaps(start, end, block.start, block.end));
  });
}

export function publicBookingMeta(config: BookingConfig = bookingConfig()) {
  return {
    timezone: config.timezone,
    timezoneLabel: config.timezoneLabel,
    durationMinutes: config.durationMinutes,
    minNoticeHours: config.minNoticeHours,
    maxDaysAhead: config.maxDaysAhead,
  };
}
