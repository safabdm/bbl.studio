import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const storeDir = mkdtempSync(join(tmpdir(), 'bbl-book-'));
process.env.BOOKING_STORE_PATH = join(storeDir, 'bookings.json');
process.env.BOOKING_TIMEZONE = 'America/Los_Angeles';
process.env.BOOKING_DURATION_MINUTES = '30';
process.env.BOOKING_MIN_NOTICE_HOURS = '48';
process.env.BOOKING_MAX_DAYS_AHEAD = '28';
process.env.BOOKING_SLOT_INTERVAL_MINUTES = '30';
process.env.BOOKING_WORK_DAYS = '1,2,3,4,5';
process.env.BOOKING_WORK_START_HOUR = '10';
process.env.BOOKING_WORK_END_HOUR = '16';
process.env.BOOKING_EMAIL_MODE = 'log';
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
delete process.env.GOOGLE_REFRESH_TOKEN;

const { bookingConfig } = await import('../api/booking-config.ts');
const { assertSlotMeetsNotice, filterAvailableSlots, generateDaySlots, earliestBookableInstant } =
  await import('../api/booking-slots.ts');
const { createBooking, getAvailabilityPayload } = await import('../api/booking-core.ts');
const { zonedLocalToUtc } = await import('../api/booking-timezone.ts');

before(() => {
  // ensure clean store
});

after(() => {
  rmSync(storeDir, { recursive: true, force: true });
});

describe('booking 48-hour notice', () => {
  it('rejects past and under-notice slots', () => {
    const now = new Date('2026-10-05T17:00:00.000Z'); // 10:00 AM PT
    const tooSoon = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const ok = assertSlotMeetsNotice(tooSoon, now);
    assert.equal(ok.ok, false);

    const past = new Date(now.getTime() - 60_000).toISOString();
    assert.equal(assertSlotMeetsNotice(past, now).ok, false);

    const farEnough = new Date(now.getTime() + 49 * 60 * 60 * 1000).toISOString();
    assert.equal(assertSlotMeetsNotice(farEnough, now).ok, true);
  });

  it('earliest bookable is now + min notice', () => {
    const config = bookingConfig();
    const now = new Date('2026-10-05T17:00:00.000Z');
    const earliest = earliestBookableInstant(now, config);
    assert.equal(earliest.getTime(), now.getTime() + 48 * 60 * 60 * 1000);
  });
});

describe('slot generation', () => {
  it('builds weekday slots inside work hours', () => {
    // 2026-10-07 is a Wednesday
    const slots = generateDaySlots('2026-10-07');
    assert.ok(slots.length > 0);
    assert.equal(slots[0].timeLabel.includes('AM') || slots[0].timeLabel.includes('PM'), true);
    const first = new Date(slots[0].start);
    const lastEnd = new Date(slots[slots.length - 1].end);
    const startBound = zonedLocalToUtc(2026, 10, 7, 10, 0, 'America/Los_Angeles');
    const endBound = zonedLocalToUtc(2026, 10, 7, 16, 0, 'America/Los_Angeles');
    assert.equal(first.getTime(), startBound.getTime());
    assert.ok(lastEnd.getTime() <= endBound.getTime());
  });

  it('skips weekends', () => {
    assert.deepEqual(generateDaySlots('2026-10-10'), []); // Saturday
    assert.deepEqual(generateDaySlots('2026-10-11'), []); // Sunday
  });

  it('filters busy intervals and under-notice slots', () => {
    const now = new Date('2026-10-05T17:00:00.000Z');
    const slots = generateDaySlots('2026-10-08');
    const busyStart = slots[2].start;
    const busyEnd = slots[2].end;
    const open = filterAvailableSlots(slots, [{ start: busyStart, end: busyEnd }], now);
    assert.ok(!open.some((slot) => slot.start === busyStart));
    assert.ok(open.every((slot) => new Date(slot.start).getTime() >= now.getTime() + 48 * 60 * 60 * 1000));
  });
});

describe('booking create + double-book protection (local calendar)', () => {
  it('creates a booking and blocks the same slot', async () => {
    const availability = await getAvailabilityPayload();
    assert.equal(availability.ok, true);
    assert.ok(availability.dates.length > 0);
    const day = await getAvailabilityPayload(availability.dates[0]);
    assert.ok(day.slots.length > 0);
    const slot = day.slots[0];

    const first = await createBooking({
      start: slot.start,
      name: 'Test Guest',
      email: 'guest@example.com',
      company: 'Example Co',
      note: 'Need a website',
    });
    assert.equal(first.ok, true);
    if (first.ok) {
      assert.equal(first.booking.calendarMode, 'local');
      assert.equal(first.booking.durationMinutes, 30);
    }

    const second = await createBooking({
      start: slot.start,
      name: 'Other Guest',
      email: 'other@example.com',
    });
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.status, 409);

    const refreshed = await getAvailabilityPayload(slot.date);
    assert.ok(!refreshed.slots.some((item) => item.start === slot.start));
  });

  it('rejects same-day / next-day attempts server-side', async () => {
    const now = new Date();
    const soon = new Date(now.getTime() + 20 * 60 * 60 * 1000).toISOString();
    const result = await createBooking({
      start: soon,
      name: 'Too Soon',
      email: 'soon@example.com',
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.message, /48 hours|outside available|Past times/i);
    }
  });
});
