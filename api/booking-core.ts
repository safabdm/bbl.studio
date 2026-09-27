/**
 * Consultation booking. Availability lives on the studio calendar.
 * Transactional confirmations are separate from lead outreach.
 */
import { createSign } from 'node:crypto';

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const LEAD_MS = 48 * 60 * 60 * 1000;

export type BookingConfig = {
  timeZone: string;
  durationMinutes: number;
  startMinutes: number;
  endMinutes: number;
  weekdays: number[];
  horizonDays: number;
};

export type Slot = {
  start: string;
  end: string;
  date: string;
  label: string;
  dateLabel: string;
};

export type BookingInput = {
  start: string;
  name: string;
  email: string;
  company?: string;
  phone?: string;
  note?: string;
};

export type StoredEvent = {
  id: string;
  iCalUID: string;
  start: string;
  end: string;
  summary: string;
  created: string;
  reminderSent?: boolean;
  attendeeEmail?: string;
  name?: string;
  company?: string;
  phone?: string;
  note?: string;
};

export type CalendarStore = {
  mode: 'memory' | 'google';
  canInvite: boolean;
  overlapping(start: Date, end: Date): Promise<StoredEvent[]>;
  create(event: StoredEvent): Promise<StoredEvent>;
  upcomingReminders(from: Date, to: Date): Promise<StoredEvent[]>;
  markReminded(id: string): Promise<void>;
  remove(id: string): Promise<void>;
};

export class BookingError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

function clampInt(value: string | undefined, min: number, max: number, fallback: number) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function bookingConfig(env: NodeJS.ProcessEnv = process.env): BookingConfig {
  const weekdays = String(env.BOOKING_WEEKDAYS || '1,2,3,4,5')
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
  return {
    timeZone: env.BOOKING_TIMEZONE || 'America/Los_Angeles',
    durationMinutes: clampInt(env.CONSULTATION_MINUTES, 15, 180, 30),
    startMinutes: clampInt(env.BOOKING_START_MINUTES, 0, 23 * 60, 10 * 60),
    endMinutes: clampInt(env.BOOKING_END_MINUTES, 60, 24 * 60, 16 * 60),
    weekdays: weekdays.length ? weekdays : [1, 2, 3, 4, 5],
    horizonDays: clampInt(env.BOOKING_HORIZON_DAYS, 7, 60, 21),
  };
}

export function timezoneLabel(timeZone: string) {
  if (timeZone === 'America/Los_Angeles') return 'Pacific Time (Los Angeles)';
  return timeZone.replaceAll('_', ' ');
}

export function zonedParts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAY[parts.weekday] ?? 0,
  };
}

export function dayKey(date: Date, timeZone: string) {
  const parts = zonedParts(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

export function addCalendarDays(day: string, days: number) {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10);
}

export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const shift = (instant: number) => {
    const parts = zonedParts(new Date(instant), timeZone);
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
    return instant - (asUtc - instant);
  };
  const once = shift(guess);
  const parts = zonedParts(new Date(once), timeZone);
  if (parts.year === year && parts.month === month && parts.day === day && parts.hour === hour && parts.minute === minute) {
    return new Date(once);
  }
  return new Date(shift(once));
}

export function isBookableInstant(start: Date, now: Date, timeZone: string) {
  if (Number.isNaN(start.getTime()) || start.getTime() < now.getTime() + LEAD_MS) return false;
  const today = dayKey(now, timeZone);
  const tomorrow = addCalendarDays(today, 1);
  const day = dayKey(start, timeZone);
  return day !== today && day !== tomorrow;
}

function formatInZone(date: Date, timeZone: string, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat('en-US', { timeZone, ...options }).format(date);
}

export function slotFromStart(start: Date, config: BookingConfig): Slot {
  const end = new Date(start.getTime() + config.durationMinutes * 60 * 1000);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    date: dayKey(start, config.timeZone),
    label: formatInZone(start, config.timeZone, { hour: 'numeric', minute: '2-digit' }),
    dateLabel: formatInZone(start, config.timeZone, { weekday: 'short', month: 'short', day: 'numeric' }),
  };
}

export function buildCandidateSlots(now: Date, config: BookingConfig) {
  const slots: Slot[] = [];
  const today = dayKey(now, config.timeZone);
  for (let offset = 0; offset <= config.horizonDays; offset += 1) {
    const date = addCalendarDays(today, offset);
    const [year, month, day] = date.split('-').map(Number);
    const noon = zonedTimeToUtc(year, month, day, 12, 0, config.timeZone);
    if (!config.weekdays.includes(zonedParts(noon, config.timeZone).weekday)) continue;
    for (let minute = config.startMinutes; minute + config.durationMinutes <= config.endMinutes; minute += config.durationMinutes) {
      const start = zonedTimeToUtc(year, month, day, Math.floor(minute / 60), minute % 60, config.timeZone);
      if (!isBookableInstant(start, now, config.timeZone)) continue;
      slots.push(slotFromStart(start, config));
    }
  }
  return slots;
}

function overlaps(event: StoredEvent, start: Date, end: Date) {
  return Date.parse(event.start) < end.getTime() && Date.parse(event.end) > start.getTime();
}

export async function openSlots(store: CalendarStore, now: Date, config = bookingConfig()) {
  const candidates = buildCandidateSlots(now, config);
  if (!candidates.length) return [];
  const windowStart = new Date(candidates[0].start);
  const windowEnd = new Date(candidates[candidates.length - 1].end);
  const busy = await store.overlapping(windowStart, windowEnd);
  return candidates.filter((slot) => !busy.some((event) => overlaps(event, new Date(slot.start), new Date(slot.end))));
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function cleanBooking(input: BookingInput) {
  const name = String(input.name || '').trim().replace(/\s+/g, ' ');
  const email = String(input.email || '').trim().toLowerCase();
  const company = String(input.company || '').trim().slice(0, 120);
  const phone = String(input.phone || '').trim().slice(0, 40);
  const note = String(input.note || '').trim().slice(0, 1000);
  if (name.length < 2 || name.length > 120) {
    throw new BookingError('Enter your full name.', 400, 'invalid_name');
  }
  if (!EMAIL.test(email) || email.length > 160) {
    throw new BookingError('Enter a valid email address.', 400, 'invalid_email');
  }
  if (company.length < 2) {
    throw new BookingError('Enter your company or business name.', 400, 'invalid_company');
  }
  if (phone.replace(/\D/g, '').length < 7) {
    throw new BookingError('Enter a phone number.', 400, 'invalid_phone');
  }
  if (note.length < 2) {
    throw new BookingError('Tell us what you need.', 400, 'invalid_note');
  }
  return { name, email, company, phone, note };
}

export function assertOpenSlot(startIso: string, now: Date, config: BookingConfig) {
  const start = new Date(startIso);
  if (!isBookableInstant(start, now, config.timeZone)) {
    throw new BookingError('That time is no longer available. Choose a time at least 48 hours ahead.', 400, 'too_soon');
  }
  const parts = zonedParts(start, config.timeZone);
  const minutes = parts.hour * 60 + parts.minute;
  if (!config.weekdays.includes(parts.weekday) || minutes < config.startMinutes || minutes + config.durationMinutes > config.endMinutes) {
    throw new BookingError('That time is not an open consultation slot.', 400, 'invalid_slot');
  }
  if ((minutes - config.startMinutes) % config.durationMinutes !== 0) {
    throw new BookingError('That time is not an open consultation slot.', 400, 'invalid_slot');
  }
  return slotFromStart(start, config);
}

export function eventUid(start: Date) {
  return `bbl-consult-${start.toISOString().replace(/[:.]/g, '')}@bbl.studio`;
}

export async function bookConsultation(store: CalendarStore, input: BookingInput, now = new Date(), config = bookingConfig()) {
  const fields = cleanBooking(input);
  const slot = assertOpenSlot(input.start, now, config);
  const start = new Date(slot.start);
  const end = new Date(slot.end);
  const busy = await store.overlapping(start, end);
  if (busy.length) throw new BookingError('That time was just taken. Please choose another.', 409, 'taken');
  const event: StoredEvent = {
    id: '',
    iCalUID: eventUid(start),
    start: slot.start,
    end: slot.end,
    summary: `BBL Studio consultation — ${fields.name}`,
    created: now.toISOString(),
    attendeeEmail: fields.email,
    name: fields.name,
    company: fields.company,
    phone: fields.phone,
    note: fields.note,
  };
  try {
    const saved = await store.create(event);
    const again = await store.overlapping(start, end);
    const earlier = again.filter((item) => item.iCalUID !== saved.iCalUID && item.created <= saved.created);
    if (earlier.length) {
      if (saved.id) await store.remove(saved.id);
      throw new BookingError('That time was just taken. Please choose another.', 409, 'taken');
    }
    return { slot, fields, event: saved, canInvite: store.canInvite };
  } catch (error) {
    if (error instanceof BookingError) throw error;
    const status = typeof error === 'object' && error && 'status' in error ? Number(error.status) : 0;
    if (status === 409) throw new BookingError('That time was just taken. Please choose another.', 409, 'taken');
    throw new BookingError('The consultation could not be booked. Please try another time.', 502, 'calendar_failed');
  }
}

export class MemoryCalendar implements CalendarStore {
  mode = 'memory' as const;
  canInvite = false;
  events: StoredEvent[] = [];

  async overlapping(start: Date, end: Date) {
    return this.events.filter((event) => overlaps(event, start, end));
  }

  async create(event: StoredEvent) {
    if (this.events.some((item) => item.iCalUID === event.iCalUID)) {
      const conflict = new Error('conflict') as Error & { status: number };
      conflict.status = 409;
      throw conflict;
    }
    const saved = { ...event, id: `mem_${this.events.length + 1}` };
    this.events.push(saved);
    return saved;
  }

  async upcomingReminders(from: Date, to: Date) {
    return this.events.filter((event) => {
      const start = Date.parse(event.start);
      return !event.reminderSent && start >= from.getTime() && start <= to.getTime();
    });
  }

  async markReminded(id: string) {
    const event = this.events.find((item) => item.id === id);
    if (event) event.reminderSent = true;
  }

  async remove(id: string) {
    this.events = this.events.filter((event) => event.id !== id);
  }
}

type GoogleEvent = {
  id?: string;
  iCalUID?: string;
  status?: string;
  transparency?: string;
  summary?: string;
  created?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { email?: string; displayName?: string }[];
  extendedProperties?: { private?: Record<string, string> };
};

function calendarConfigured(env: NodeJS.ProcessEnv = process.env) {
  const hasOauth = Boolean(env.GOOGLE_REFRESH_TOKEN && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  const hasService = Boolean(env.GOOGLE_CLIENT_EMAIL && env.GOOGLE_PRIVATE_KEY);
  return Boolean(env.GOOGLE_CALENDAR_ID && (hasOauth || hasService));
}

function usesOauth(env: NodeJS.ProcessEnv = process.env) {
  return Boolean(env.GOOGLE_REFRESH_TOKEN && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

let tokenCache: { token: string; exp: number } | null = null;

async function googleAccessToken(env: NodeJS.ProcessEnv = process.env) {
  if (tokenCache && tokenCache.exp > Date.now() + 60_000) return tokenCache.token;
  if (usesOauth(env)) {
    const body = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID || '',
      client_secret: env.GOOGLE_CLIENT_SECRET || '',
      refresh_token: env.GOOGLE_REFRESH_TOKEN || '',
      grant_type: 'refresh_token',
    });
    const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body });
    if (!response.ok) throw new BookingError('Calendar authorization failed.', 503, 'calendar_auth');
    const json = await response.json() as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new BookingError('Calendar authorization failed.', 503, 'calendar_auth');
    tokenCache = { token: json.access_token, exp: Date.now() + (json.expires_in || 3600) * 1000 };
    return json.access_token;
  }
  const email = env.GOOGLE_CLIENT_EMAIL || '';
  const key = (env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claim = Buffer.from(JSON.stringify({
    iss: email,
    scope: 'https://www.googleapis.com/auth/calendar',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })).toString('base64url');
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  signer.end();
  const assertion = `${header}.${claim}.${signer.sign(key).toString('base64url')}`;
  const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion });
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body });
  if (!response.ok) throw new BookingError('Calendar authorization failed.', 503, 'calendar_auth');
  const json = await response.json() as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new BookingError('Calendar authorization failed.', 503, 'calendar_auth');
  tokenCache = { token: json.access_token, exp: Date.now() + (json.expires_in || 3600) * 1000 };
  return json.access_token;
}

function toStored(event: GoogleEvent, timeZone: string): StoredEvent | null {
  if (!event.id || event.status === 'cancelled' || event.transparency === 'transparent') return null;
  let start = event.start?.dateTime || '';
  let end = event.end?.dateTime || '';
  if (!start && event.start?.date) {
    const [year, month, day] = event.start.date.split('-').map(Number);
    const [endYear, endMonth, endDay] = (event.end?.date || event.start.date).split('-').map(Number);
    start = zonedTimeToUtc(year, month, day, 0, 0, timeZone).toISOString();
    end = zonedTimeToUtc(endYear, endMonth, endDay, 0, 0, timeZone).toISOString();
  }
  if (!start || !end) return null;
  const attendee = event.attendees?.find((item) => item.email);
  return {
    id: event.id,
    iCalUID: event.iCalUID || event.id,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    summary: event.summary || 'Busy',
    created: event.created || new Date(start).toISOString(),
    reminderSent: event.extendedProperties?.private?.reminderSent === '1',
    attendeeEmail: attendee?.email || event.extendedProperties?.private?.email,
    name: event.extendedProperties?.private?.name,
    company: event.extendedProperties?.private?.company,
    phone: event.extendedProperties?.private?.phone,
    note: event.extendedProperties?.private?.note,
  };
}

export class GoogleCalendar implements CalendarStore {
  mode = 'google' as const;
  canInvite: boolean;
  private calendarId: string;
  private timeZone: string;

  constructor(private env: NodeJS.ProcessEnv = process.env) {
    this.canInvite = usesOauth(env);
    this.calendarId = env.GOOGLE_CALENDAR_ID || 'primary';
    this.timeZone = bookingConfig(env).timeZone;
  }

  private async request(path: string, init: RequestInit = {}) {
    const token = await googleAccessToken(this.env);
    const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });
    if (response.status === 409) {
      const conflict = new Error('conflict') as Error & { status: number };
      conflict.status = 409;
      throw conflict;
    }
    if (!response.ok) throw new BookingError('Calendar request failed.', response.status === 401 ? 503 : 502, 'calendar_failed');
    if (response.status === 204) return {};
    return response.json() as Promise<{ items?: GoogleEvent[]; nextPageToken?: string } & GoogleEvent>;
  }

  private async listRange(start: Date, end: Date) {
    const found: StoredEvent[] = [];
    let pageToken = '';
    for (let page = 0; page < 5; page += 1) {
      const params = new URLSearchParams({
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '250',
        showDeleted: 'false',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const json = await this.request(`/events?${params}`);
      for (const item of json.items || []) {
        const stored = toStored(item, this.timeZone);
        if (stored) found.push(stored);
      }
      pageToken = json.nextPageToken || '';
      if (!pageToken) break;
    }
    return found;
  }

  async overlapping(start: Date, end: Date) {
    const events = await this.listRange(new Date(start.getTime() - 24 * 60 * 60 * 1000), new Date(end.getTime() + 24 * 60 * 60 * 1000));
    return events.filter((event) => overlaps(event, start, end));
  }

  async create(event: StoredEvent) {
    const config = bookingConfig(this.env);
    const body: GoogleEvent & { description?: string; reminders?: unknown; guestsCanInviteOthers?: boolean } = {
      iCalUID: event.iCalUID,
      summary: event.summary,
      description: [
        'Free BBL Studio consultation.',
        `Name: ${event.name || ''}`,
        `Email: ${event.attendeeEmail || ''}`,
        event.company ? `Company: ${event.company}` : '',
        event.phone ? `Phone: ${event.phone}` : '',
        event.note ? `Note: ${event.note}` : '',
      ].filter(Boolean).join('\n'),
      start: { dateTime: event.start, timeZone: config.timeZone },
      end: { dateTime: event.end, timeZone: config.timeZone },
      reminders: { useDefault: false, overrides: [{ method: 'email', minutes: 24 * 60 }, { method: 'popup', minutes: 60 }] },
      extendedProperties: {
        private: {
          bblBooking: '1',
          reminderSent: '0',
          email: event.attendeeEmail || '',
          name: event.name || '',
          company: event.company || '',
          phone: event.phone || '',
          note: event.note || '',
        },
      },
      guestsCanInviteOthers: false,
    };
    if (this.canInvite && event.attendeeEmail) {
      body.attendees = [{ email: event.attendeeEmail, displayName: event.name }];
    }
    const updates = this.canInvite ? 'all' : 'none';
    const created = await this.request(`/events?sendUpdates=${updates}`, { method: 'POST', body: JSON.stringify(body) });
    return toStored(created, config.timeZone) || { ...event, id: created.id || event.iCalUID };
  }

  async upcomingReminders(from: Date, to: Date) {
    const events = await this.listRange(from, to);
    return events.filter((event) => event.iCalUID.startsWith('bbl-consult-') && !event.reminderSent);
  }

  async markReminded(id: string) {
    await this.request(`/events/${encodeURIComponent(id)}?sendUpdates=none`, {
      method: 'PATCH',
      body: JSON.stringify({ extendedProperties: { private: { reminderSent: '1', bblBooking: '1' } } }),
    });
  }

  async remove(id: string) {
    await this.request(`/events/${encodeURIComponent(id)}?sendUpdates=none`, { method: 'DELETE' });
  }
}

const sharedMemory = new MemoryCalendar();

export function getCalendar(env: NodeJS.ProcessEnv = process.env): CalendarStore | null {
  if (env.BOOKING_STORE === 'memory' && !env.VERCEL) return sharedMemory;
  if (!calendarConfigured(env)) return null;
  return new GoogleCalendar(env);
}

export function icsEscape(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

export function consultationIcs(slot: Slot, fields: { name: string; email: string; note?: string }, timeZone: string) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const start = new Date(slot.start).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const end = new Date(slot.end).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const description = icsEscape(`Free consultation with BBL Studio.${fields.note ? ` ${fields.note}` : ''}`);
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//BBL Studio//Consultation//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    `X-WR-TIMEZONE:${timeZone}`,
    'BEGIN:VEVENT',
    `UID:${eventUid(new Date(slot.start))}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${icsEscape(`BBL Studio consultation — ${fields.name}`)}`,
    `DESCRIPTION:${description}`,
    'ORGANIZER;CN=BBL Studio:mailto:hello@bbl.studio',
    `ATTENDEE;CN=${icsEscape(fields.name)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${fields.email}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

export async function sendBookingEmail(opts: {
  to: string;
  subject: string;
  text: string;
  ics?: string;
}, env: NodeJS.ProcessEnv = process.env) {
  const key = env.RESEND_API_KEY || '';
  if (!key) return false;
  const from = env.RESEND_FROM || 'BBL Studio <hello@bbl.studio>';
  const payload: Record<string, unknown> = { from, to: [opts.to], subject: opts.subject, text: opts.text };
  if (opts.ics) {
    payload.attachments = [{ filename: 'bbl-consultation.ics', content: Buffer.from(opts.ics).toString('base64') }];
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.ok;
}

export function confirmationCopy(slot: Slot, timeZone: string) {
  const when = `${slot.dateLabel} at ${slot.label}`;
  const zone = timezoneLabel(timeZone);
  return { when, zone, subject: `Your BBL Studio consultation — ${when}` };
}

export async function sendConfirmation(slot: Slot, fields: { name: string; email: string; note?: string }, config: BookingConfig, env: NodeJS.ProcessEnv = process.env) {
  const copy = confirmationCopy(slot, config.timeZone);
  const text = [
    `Hello ${fields.name},`,
    '',
    'Your free BBL Studio consultation is booked.',
    `${copy.when}`,
    `${copy.zone}`,
    `${config.durationMinutes} minutes`,
    '',
    'A calendar file is attached. Add it to your calendar so you have the appointment.',
    '',
    'BBL Boutique Brand & Launch Studio',
    'hello@bbl.studio',
    '(949) 524-2324',
    'https://www.bbl.studio',
  ].join('\n');
  const sent = await sendBookingEmail({
    to: fields.email,
    subject: copy.subject,
    text,
    ics: consultationIcs(slot, fields, config.timeZone),
  }, env);
  return sent;
}

export async function sendDueReminders(store: CalendarStore, now = new Date(), config = bookingConfig(), env: NodeJS.ProcessEnv = process.env) {
  const from = new Date(now.getTime() + 23 * 60 * 60 * 1000);
  const to = new Date(now.getTime() + 25 * 60 * 60 * 1000);
  const due = await store.upcomingReminders(from, to);
  let sent = 0;
  for (const event of due) {
    if (!event.attendeeEmail) {
      await store.markReminded(event.id);
      continue;
    }
    const slot = slotFromStart(new Date(event.start), config);
    const copy = confirmationCopy(slot, config.timeZone);
    const ok = await sendBookingEmail({
      to: event.attendeeEmail,
      subject: `Reminder: BBL Studio consultation ${copy.when}`,
      text: [
        `Hello ${event.name || 'there'},`,
        '',
        'This is a reminder for your free BBL Studio consultation.',
        `${copy.when}`,
        `${copy.zone}`,
        '',
        'BBL Boutique Brand & Launch Studio',
        'hello@bbl.studio',
        '(949) 524-2324',
      ].join('\n'),
    }, env);
    if (ok || !env.RESEND_API_KEY) await store.markReminded(event.id);
    if (ok) sent += 1;
  }
  return { checked: due.length, sent, emailConfigured: Boolean(env.RESEND_API_KEY) };
}

export function publicBookingMeta(config = bookingConfig()) {
  return {
    timeZone: config.timeZone,
    timezoneLabel: timezoneLabel(config.timeZone),
    durationMinutes: config.durationMinutes,
    leadHours: 48,
  };
}
