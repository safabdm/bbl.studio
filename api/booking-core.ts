import { bookingConfig, googleCalendarConfigured } from './booking-config.js';
import { calendarConnectionStatus, createCalendarBooking, listBusyIntervals } from './booking-calendar.js';
import { sendBookingConfirmation } from './booking-email.js';
import {
  assertSlotMeetsNotice,
  filterAvailableSlots,
  generateDaySlots,
  listCandidateDates,
  publicBookingMeta,
} from './booking-slots.js';
import { addCalendarDays, getZonedParts, zonedLocalToUtc } from './booking-timezone.js';

export type BookRequest = {
  start: string;
  name: string;
  email: string;
  company?: string;
  phone?: string;
  note?: string;
  website?: string; // honeypot
};

function clean(value: unknown, max = 500) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, max);
}

export async function getAvailabilityPayload(dateYmd?: string) {
  const config = bookingConfig();
  const now = new Date();
  const meta = publicBookingMeta(config);
  const connection = calendarConnectionStatus();

  const dates = listCandidateDates(now, config);
  const selected = dateYmd && dates.includes(dateYmd) ? dateYmd : dates[0] || '';

  if (!selected) {
    return {
      ok: true as const,
      ...meta,
      calendar: connection,
      dates: [],
      selectedDate: '',
      slots: [] as ReturnType<typeof filterAvailableSlots>,
    };
  }

  const parts = selected.split('-').map(Number);
  const dayStart = zonedLocalToUtc(parts[0], parts[1], parts[2], 0, 0, config.timezone);
  const next = addCalendarDays(parts[0], parts[1], parts[2], 1);
  const dayEnd = zonedLocalToUtc(next.year, next.month, next.day, 0, 0, config.timezone);

  const busy = await listBusyIntervals(dayStart.toISOString(), dayEnd.toISOString());
  const candidates = generateDaySlots(selected, config);
  const slots = filterAvailableSlots(candidates, busy, now, config);

  return {
    ok: true as const,
    ...meta,
    calendar: connection,
    dates,
    selectedDate: selected,
    slots,
  };
}

export async function createBooking(body: BookRequest) {
  const config = bookingConfig();

  if (process.env.VERCEL && !googleCalendarConfigured()) {
    return {
      ok: false as const,
      status: 503,
      message:
        'Online booking is being connected. Please email hello@bbl.studio or call (949) 524-2324 to schedule.',
    };
  }

  if (clean(body.website, 80)) {
    return { ok: false as const, status: 400, message: 'Request could not be submitted.' };
  }

  const name = clean(body.name, 120);
  const email = clean(body.email, 180).toLowerCase();
  const company = clean(body.company, 120);
  const phone = clean(body.phone, 60);
  const note = clean(body.note, 800);
  const startIso = clean(body.start, 64);

  if (!name || !email || !startIso) {
    return { ok: false as const, status: 400, message: 'Please provide your name, email, and a time slot.' };
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return { ok: false as const, status: 400, message: 'Please enter a valid email address.' };
  }

  const notice = assertSlotMeetsNotice(startIso, new Date(), config);
  if (!notice.ok) {
    return { ok: false as const, status: 400, message: notice.message };
  }

  const startParts = getZonedParts(notice.start, config.timezone);
  const ymd = `${startParts.year}-${String(startParts.month).padStart(2, '0')}-${String(startParts.day).padStart(2, '0')}`;
  const daySlots = generateDaySlots(ymd, config);
  const matched = daySlots.find((slot) => slot.start === notice.start.toISOString());
  if (!matched) {
    return {
      ok: false as const,
      status: 400,
      message: 'That time is outside available consultation hours. Please choose another slot.',
    };
  }

  try {
    const created = await createCalendarBooking({
      startIso: matched.start,
      endIso: matched.end,
      guest: {
        name,
        email,
        company: company || undefined,
        phone: phone || undefined,
        note: note || undefined,
      },
    });

    const mail = await sendBookingConfirmation(
      {
        to: email,
        name,
        startIso: matched.start,
        endIso: matched.end,
        timezoneLabel: config.timezoneLabel,
        durationMinutes: config.durationMinutes,
        company: company || undefined,
        note: note || undefined,
        calendarMode: created.mode,
      },
      config.timezone,
    );

    return {
      ok: true as const,
      status: 200,
      booking: {
        id: created.id,
        start: matched.start,
        end: matched.end,
        timeLabel: matched.timeLabel,
        endLabel: matched.endLabel,
        date: matched.date,
        durationMinutes: config.durationMinutes,
        timezone: config.timezone,
        timezoneLabel: config.timezoneLabel,
        calendarMode: created.mode,
        calendarConfigured: googleCalendarConfigured(),
        htmlLink: created.htmlLink,
        emailConfirmation: mail.sent ? 'sent' : mail.mode,
      },
      message:
        created.mode === 'google'
          ? 'Your consultation is booked. Check your email for the calendar invitation.'
          : 'Your consultation is reserved. Calendar invitations will activate once Google Calendar is connected.',
    };
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code === 'conflict') {
      return {
        ok: false as const,
        status: 409,
        message: 'That time was just booked. Please choose another slot.',
      };
    }
    console.error('[booking] create failed', error instanceof Error ? error.message : error);
    return {
      ok: false as const,
      status: 503,
      message: 'Booking is temporarily unavailable. Please email hello@bbl.studio or try again shortly.',
    };
  }
}
