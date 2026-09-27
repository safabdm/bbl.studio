import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { bookingConfig, googleCalendarConfigured, localBookingStorePath } from './booking-config.js';
import type { BusyInterval } from './booking-slots.js';

export type BookingGuest = {
  name: string;
  email: string;
  company?: string;
  phone?: string;
  note?: string;
};

export type CreatedBooking = {
  id: string;
  htmlLink?: string;
  start: string;
  end: string;
  mode: 'google' | 'local';
};

type LocalBooking = {
  id: string;
  start: string;
  end: string;
  guest: BookingGuest;
  created_at: string;
};

let cachedAccessToken: { token: string; expiresAt: number } | null = null;

function readLocalBookings(): LocalBooking[] {
  const path = localBookingStorePath();
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { bookings?: LocalBooking[] };
    return Array.isArray(raw.bookings) ? raw.bookings : [];
  } catch {
    return [];
  }
}

function writeLocalBookings(bookings: LocalBooking[]) {
  const path = localBookingStorePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ bookings }, null, 2));
}

async function getGoogleAccessToken() {
  const now = Date.now();
  if (cachedAccessToken && cachedAccessToken.expiresAt > now + 60_000) {
    return cachedAccessToken.token;
  }
  const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
  const refreshToken = (process.env.GOOGLE_REFRESH_TOKEN || '').trim();
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Google Calendar OAuth is not configured.');
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = (await response.json()) as { access_token?: string; expires_in?: number; error?: string };
  if (!response.ok || !data.access_token) {
    throw new Error(data.error || 'Could not refresh Google access token.');
  }
  cachedAccessToken = {
    token: data.access_token,
    expiresAt: now + (data.expires_in || 3600) * 1000,
  };
  return data.access_token;
}

async function googleFetch(path: string, init: RequestInit = {}) {
  const token = await getGoogleAccessToken();
  const response = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const message =
      typeof data === 'object' && data && 'error' in data
        ? JSON.stringify((data as { error: unknown }).error)
        : `Google Calendar request failed (${response.status})`;
    throw new Error(message);
  }
  return data;
}

export function calendarConnectionStatus() {
  if (googleCalendarConfigured()) {
    return { configured: true as const, mode: 'google' as const };
  }
  return { configured: false as const, mode: 'local' as const };
}

export async function listBusyIntervals(timeMinIso: string, timeMaxIso: string): Promise<BusyInterval[]> {
  if (!googleCalendarConfigured()) {
    return readLocalBookings()
      .filter((item) => item.end > timeMinIso && item.start < timeMaxIso)
      .map((item) => ({ start: item.start, end: item.end }));
  }

  const config = bookingConfig();
  const data = (await googleFetch('/freeBusy', {
    method: 'POST',
    body: JSON.stringify({
      timeMin: timeMinIso,
      timeMax: timeMaxIso,
      timeZone: config.timezone,
      items: [{ id: config.calendarId }],
    }),
  })) as {
    calendars?: Record<string, { busy?: BusyInterval[] }>;
  };

  const busy = data.calendars?.[config.calendarId]?.busy || [];
  return busy.map((item) => ({ start: item.start, end: item.end }));
}

function eventDescription(guest: BookingGuest) {
  return [
    'BBL Studio free consultation booking',
    `Name: ${guest.name}`,
    `Email: ${guest.email}`,
    guest.company ? `Company: ${guest.company}` : '',
    guest.phone ? `Phone: ${guest.phone}` : '',
    guest.note ? `Note: ${guest.note}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function createCalendarBooking(opts: {
  startIso: string;
  endIso: string;
  guest: BookingGuest;
}): Promise<CreatedBooking> {
  const config = bookingConfig();

  if (!googleCalendarConfigured()) {
    const existing = readLocalBookings();
    const startMs = new Date(opts.startIso).getTime();
    const endMs = new Date(opts.endIso).getTime();
    const conflict = existing.some((item) => {
      const a = new Date(item.start).getTime();
      const b = new Date(item.end).getTime();
      return startMs < b && a < endMs;
    });
    if (conflict) {
      const err = new Error('That time was just booked. Please choose another slot.');
      (err as Error & { code?: string }).code = 'conflict';
      throw err;
    }
    const id = `local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    existing.push({
      id,
      start: opts.startIso,
      end: opts.endIso,
      guest: opts.guest,
      created_at: new Date().toISOString(),
    });
    writeLocalBookings(existing);
    return { id, start: opts.startIso, end: opts.endIso, mode: 'local' };
  }

  // Re-check FreeBusy immediately before create (double-booking protection).
  const busy = await listBusyIntervals(opts.startIso, opts.endIso);
  const startMs = new Date(opts.startIso).getTime();
  const endMs = new Date(opts.endIso).getTime();
  if (busy.some((block) => startMs < new Date(block.end).getTime() && new Date(block.start).getTime() < endMs)) {
    const err = new Error('That time was just booked. Please choose another slot.');
    (err as Error & { code?: string }).code = 'conflict';
    throw err;
  }

  const event = (await googleFetch(
    `/calendars/${encodeURIComponent(config.calendarId)}/events?sendUpdates=all&conferenceDataVersion=0`,
    {
      method: 'POST',
      body: JSON.stringify({
        summary: `${config.titlePrefix} — ${opts.guest.name}`,
        description: eventDescription(opts.guest),
        start: { dateTime: opts.startIso, timeZone: config.timezone },
        end: { dateTime: opts.endIso, timeZone: config.timezone },
        attendees: [
          { email: opts.guest.email, displayName: opts.guest.name },
          ...(process.env.BOOKING_HOST_EMAIL
            ? [{ email: process.env.BOOKING_HOST_EMAIL.trim(), displayName: 'BBL Studio', organizer: true }]
            : []),
        ],
        guestsCanInviteOthers: false,
        guestsCanModify: false,
        reminders: {
          useDefault: false,
          overrides: [
            { method: 'email', minutes: 24 * 60 },
            { method: 'popup', minutes: 30 },
          ],
        },
        extendedProperties: {
          private: {
            bbl_booking: '1',
            guest_email: opts.guest.email.slice(0, 120),
          },
        },
      }),
    },
  )) as { id?: string; htmlLink?: string; start?: { dateTime?: string }; end?: { dateTime?: string } };

  if (!event.id) {
    throw new Error('Calendar event was not created.');
  }

  return {
    id: event.id,
    htmlLink: event.htmlLink,
    start: event.start?.dateTime || opts.startIso,
    end: event.end?.dateTime || opts.endIso,
    mode: 'google',
  };
}
