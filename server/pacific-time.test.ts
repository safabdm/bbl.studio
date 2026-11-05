/**
 * America/Los_Angeles helpers — DST-safe next-run + morning dispatch window.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PACIFIC_TZ,
  describeNextWeekdayRun,
  isMorningPipelineDispatchWindow,
  isMorningPipelineStartHour,
  isPacificWeekday,
  pacificParts,
  pacificWallClockToUtcMs,
} from './pacific-time.ts';

describe('pacific-time DST + dispatch window', () => {
  it('maps PDT summer 14:00 UTC → 07:00 PT start hour', () => {
    // 2026-07-15 Wed — PDT (UTC-7)
    const ms = Date.parse('2026-07-15T14:05:00Z');
    const p = pacificParts(ms);
    assert.equal(p.dayKey, '2026-07-15');
    assert.equal(p.hour, 7);
    assert.equal(isPacificWeekday(ms), true);
    assert.equal(isMorningPipelineStartHour(ms), true);
    assert.equal(isMorningPipelineDispatchWindow(ms), true);
  });

  it('maps PST winter 15:00 UTC → 07:00 PT (not 14:00 UTC)', () => {
    // 2026-01-14 Wed — PST (UTC-8)
    const at6am = Date.parse('2026-01-14T14:05:00Z'); // 6:05 PT — too early
    assert.equal(pacificParts(at6am).hour, 6);
    assert.equal(isMorningPipelineStartHour(at6am), false);
    assert.equal(isMorningPipelineDispatchWindow(at6am), false);

    const at7am = Date.parse('2026-01-14T15:05:00Z'); // 7:05 PT
    assert.equal(pacificParts(at7am).hour, 7);
    assert.equal(isMorningPipelineStartHour(at7am), true);
    assert.equal(isMorningPipelineDispatchWindow(at7am), true);
  });

  it('catch-up window includes 08:xx PT; closes before 09:00 PT', () => {
    const catchUpPdt = Date.parse('2026-07-15T15:30:00Z'); // 8:30 PT PDT
    assert.equal(pacificParts(catchUpPdt).hour, 8);
    assert.equal(isMorningPipelineDispatchWindow(catchUpPdt), true);
    assert.equal(isMorningPipelineStartHour(catchUpPdt), false);

    const at9 = Date.parse('2026-07-15T16:00:00Z'); // 9:00 PT PDT
    assert.equal(pacificParts(at9).hour, 9);
    assert.equal(isMorningPipelineDispatchWindow(at9), false);
  });

  it('describeNextWeekdayRun uses America/Los_Angeles wall clock (DST)', () => {
    // Before 7am PDT on a Wednesday
    const before = Date.parse('2026-07-15T13:00:00Z'); // 6am PDT
    const next = describeNextWeekdayRun(7, 0, before);
    assert.equal(next.timezone, PACIFIC_TZ);
    assert.equal(next.dayKey, '2026-07-15');
    assert.match(next.at_pt, /America\/Los_Angeles/);
    const wall = pacificParts(Date.parse(next.at_utc));
    assert.equal(wall.hour, 7);
    assert.equal(wall.minute, 0);

    // Winter: next 7am PT from 6am PST
    const beforePst = Date.parse('2026-01-14T14:00:00Z');
    const nextPst = describeNextWeekdayRun(7, 0, beforePst);
    assert.equal(nextPst.dayKey, '2026-01-14');
    assert.equal(pacificParts(Date.parse(nextPst.at_utc)).hour, 7);
  });

  it('pacificWallClockToUtcMs is DST-correct for 07:00', () => {
    const pdt = pacificWallClockToUtcMs('2026-07-15', 7, 0);
    assert.equal(new Date(pdt).toISOString().startsWith('2026-07-15T14:00:00'), true);
    const pst = pacificWallClockToUtcMs('2026-01-14', 7, 0);
    assert.equal(new Date(pst).toISOString().startsWith('2026-01-14T15:00:00'), true);
  });

  it('weekend is outside dispatch window', () => {
    const sat = Date.parse('2026-01-17T15:05:00Z'); // Sat 7am PST
    assert.equal(isPacificWeekday(sat), false);
    assert.equal(isMorningPipelineDispatchWindow(sat), false);
  });
});
