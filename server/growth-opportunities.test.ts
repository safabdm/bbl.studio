import { test } from 'node:test';
import assert from 'node:assert/strict';
import { growthOpportunities } from './growth-opportunities.js';
import type { GrowthMonitor } from './growth-monitor.js';
const now = Date.parse('2026-11-10T18:00:00Z');
const base: GrowthMonitor = {
  at: new Date(now).toISOString(),
  technical: [],
  search: { status: 'verified', rows: [] },
  traffic: {
    status: 'verified',
    report: {
      dimensionHeaders: [{ name: 'sessionSource' }, { name: 'sessionMedium' }],
      metricHeaders: [{ name: 'sessions' }],
    },
  },
};
void test('empty, missing and stale reports never become zero traffic claims', () => {
  assert.equal(growthOpportunities(null, now).organicSessionsInSample, null);
  assert.equal(growthOpportunities(base, now).aiReferralSessionsInSample, null);
  assert.equal(
    growthOpportunities({ ...base, at: 'invalid' }, now).fresh,
    false,
  );
  assert.equal(
    growthOpportunities({ ...base, at: new Date(now + 1).toISOString() }, now)
      .fresh,
    false,
  );
});
void test('bounded attribution uses metric headers and exact source hosts, not lookalike domains', () => {
  const row = (source: string, medium: string, n: string) => ({
    dimensionValues: [{ value: source }, { value: medium }],
    metricValues: [{ value: n }],
  });
  const result = growthOpportunities(
    {
      ...base,
      traffic: {
        status: 'verified',
        report: {
          ...(base.traffic.report as object),
          rows: [
            row('chatgpt.com', 'referral', '4'),
            row('chatgpt.com.attacker.test', 'referral', '100'),
            row('google', 'organic', '7'),
          ],
          rowCount: 1000,
        },
      },
    },
    now,
  );
  assert.equal(result.aiReferralSessionsInSample, 4);
  assert.equal(result.organicSessionsInSample, 7);
  assert.equal(result.coverage.siteWideTotal, false);
  assert.equal(result.coverage.returnedRows, 3);
});
void test('observed technical failures produce evidence-linked actions', () => {
  const result = growthOpportunities(
    {
      ...base,
      technical: [
        {
          url: 'https://www.bbl.studio/booking',
          status: 200,
          checks: { structured_data: false },
        },
      ],
    },
    now,
  );
  assert.ok(
    result.actions.some(
      (a) =>
        a.source.endsWith('/booking') && a.reason.includes('structured_data'),
    ),
  );
});
