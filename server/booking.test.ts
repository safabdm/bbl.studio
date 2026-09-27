import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MemoryCalendar,
  addCalendarDays,
  bookConsultation,
  bookingConfig,
  buildCandidateSlots,
  dayKey,
  isBookableInstant,
  openSlots,
  zonedTimeToUtc,
} from '../api/booking-core.ts';

const config = bookingConfig({
  BOOKING_TIMEZONE: 'America/Los_Angeles',
  CONSULTATION_MINUTES: '30',
  BOOKING_START_MINUTES: '600',
  BOOKING_END_MINUTES: '960',
  BOOKING_WEEKDAYS: '1,2,3,4,5',
  BOOKING_HORIZON_DAYS: '14',
});

const mondayMorning = new Date('2026-09-28T17:00:00.000Z');

describe('studio timezone', () => {
  it('converts Pacific wall time to UTC in daylight and standard time', () => {
    assert.equal(zonedTimeToUtc(2026, 9, 28, 10, 0, config.timeZone).toISOString(), '2026-09-28T17:00:00.000Z');
    assert.equal(zonedTimeToUtc(2026, 1, 15, 10, 0, config.timeZone).toISOString(), '2026-01-15T18:00:00.000Z');
    assert.equal(dayKey(mondayMorning, config.timeZone), '2026-09-28');
  });
});

describe('48-hour booking rule', () => {
  it('blocks past times, today, tomorrow, and anything under 48 hours', () => {
    const today = zonedTimeToUtc(2026, 9, 28, 15, 0, config.timeZone);
    const tomorrow = zonedTimeToUtc(2026, 9, 29, 15, 0, config.timeZone);
    const justUnder = new Date(mondayMorning.getTime() + 48 * 60 * 60 * 1000 - 60_000);
    const exactly = new Date(mondayMorning.getTime() + 48 * 60 * 60 * 1000);
    assert.equal(isBookableInstant(new Date(mondayMorning.getTime() - 60_000), mondayMorning, config.timeZone), false);
    assert.equal(isBookableInstant(today, mondayMorning, config.timeZone), false);
    assert.equal(isBookableInstant(tomorrow, mondayMorning, config.timeZone), false);
    assert.equal(dayKey(tomorrow, config.timeZone), addCalendarDays(dayKey(mondayMorning, config.timeZone), 1));
    assert.equal(isBookableInstant(justUnder, mondayMorning, config.timeZone), false);
    assert.equal(isBookableInstant(exactly, mondayMorning, config.timeZone), true);
  });

  it('only offers weekday slots at least 48 hours ahead', () => {
    const slots = buildCandidateSlots(mondayMorning, config);
    assert.ok(slots.length > 0);
    assert.equal(slots[0].start, '2026-09-30T17:00:00.000Z');
    assert.equal(slots[0].label, '10:00 AM');
    const wednesday = slots.filter((slot) => slot.date === '2026-09-30');
    assert.equal(wednesday.length, 12);
    assert.equal(wednesday.at(-1)?.label, '3:30 PM');
    assert.ok(slots.every((slot) => slot.date >= '2026-09-30'));
    assert.ok(!slots.some((slot) => slot.date === '2026-10-03' || slot.date === '2026-10-04'));
  });
});

describe('double booking', () => {
  it('hides a taken slot and rejects a second booking', async () => {
    const store = new MemoryCalendar();
    const first = await bookConsultation(store, {
      start: '2026-09-30T17:00:00.000Z',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      company: 'Analytical Engines',
      phone: '9495550100',
      note: 'New website',
    }, mondayMorning, config);
    assert.equal(first.event.summary, 'BBL Studio consultation — Ada Lovelace');
    const slots = await openSlots(store, mondayMorning, config);
    assert.ok(!slots.some((slot) => slot.start === '2026-09-30T17:00:00.000Z'));
    await assert.rejects(
      () => bookConsultation(store, {
        start: '2026-09-30T17:00:00.000Z',
        name: 'Grace Hopper',
        email: 'grace@example.com',
        company: 'Navy',
        phone: '9495550199',
        note: 'Website',
      }, mondayMorning, config),
      (error: { code?: string }) => error.code === 'taken',
    );
  });

  it('rejects a time less than 48 hours away even if the client asks for it', async () => {
    const store = new MemoryCalendar();
    await assert.rejects(
      () => bookConsultation(store, {
        start: '2026-09-29T22:00:00.000Z',
        name: 'Grace Hopper',
        email: 'grace@example.com',
        company: 'Navy',
        phone: '9495550199',
        note: 'Website',
      }, mondayMorning, config),
      (error: { code?: string }) => error.code === 'too_soon',
    );
    assert.equal(store.events.length, 0);
  });
});
