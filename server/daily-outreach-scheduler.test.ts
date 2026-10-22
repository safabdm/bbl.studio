/**
 * Daily outreach scheduler — Hobby single-cron, sequential morning pipeline,
 * idempotency, exclusions, no auto-send.
 */
import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { resetMemoryCrmDb } from './crm-db.ts';
import {
  DAILY_20_BATCH_1_SENT_EMAILS,
  HARD_EXCLUDE_EMAILS,
  HOLD_BLOCKLIST_EMAILS,
  buildDaily20Cohort,
  hardExcludeReason,
  isHardExcludedEmail,
} from './daily-20-pipeline.ts';
import { fixtureCrmLead, fixtureDiscoveredLead } from './lead-queue.ts';
import {
  MORNING_PIPELINE_JOBS,
  OUTREACH_CRON_SCHEDULE,
  dispatchOutreachCron,
  idempotencyKey,
  isJobComplete,
  jobsDueAt,
  morningPipelineJobs,
  readSchedulerState,
  runSchedulerJob,
} from './daily-outreach-scheduler.ts';
import { pacificParts } from './pacific-time.ts';
import { notifyOwnerDailyReviewReady } from './owner-notify.ts';

const memEnv = {
  CRM_DATABASE_MEMORY: '1',
  CRM_DATABASE_URL: 'memory://crm',
  SESSION_SECRET: 'test-session-scheduler',
  UNSUBSCRIBE_SECRET: 'test-unsub',
  APP_ORIGIN: 'https://www.bbl.studio',
  BUSINESS_POSTAL_ADDRESS: '120 Newport Center Drive, Newport Beach, CA 92660',
  EMAIL_OUTREACH_ENABLED: 'false',
  EMAIL_DRY_RUN: 'true',
  MANUAL_SEND_LIVE_ENABLED: 'false',
  OUTREACH_CRON_SEND_ENABLED: 'false',
  CRON_SECRET: 'cron-test-secret',
  ADMIN_EMAIL: 'hello@bbl.studio',
};

beforeEach(() => {
  resetMemoryCrmDb(memEnv);
});

describe('hard exclusions (Batch 1 + Daily-20 19 + AKA HOLD)', () => {
  it('blocks all forever-exclude emails', () => {
    assert.equal(DAILY_20_BATCH_1_SENT_EMAILS.length, 19);
    assert.equal(HOLD_BLOCKLIST_EMAILS[0], 'info@akahairsalon.com');
    assert.ok(HARD_EXCLUDE_EMAILS.length >= 26);
    assert.equal(isHardExcludedEmail('admin@cellemedical.com'), true);
    assert.equal(isHardExcludedEmail('info@akahairsalon.com'), true);
    assert.equal(isHardExcludedEmail('laguna@spadelrio.com'), true);
    assert.equal(hardExcludeReason('info@akahairsalon.com'), 'hold_aka');
    assert.equal(hardExcludeReason('info@newportbeachmedspa.com'), 'daily_20_batch_1_sent');
  });

  it('excludes SENT/HOLD from daily cohort', async () => {
    const now = Date.parse('2026-10-23T16:00:00Z'); // Thu ~9am PT PDT
    const crm = [
      fixtureCrmLead({
        id: 1,
        email: 'admin@cellemedical.com',
        business_name: 'Cellé',
        location: 'Newport Beach, CA',
        category: 'med spa',
        website_observation: 'should exclude',
      }),
      fixtureCrmLead({
        id: 2,
        email: 'info@akahairsalon.com',
        business_name: 'AKA',
        location: 'Newport Beach, CA',
        category: 'salon',
        website_observation: 'hold',
      }),
      fixtureCrmLead({
        id: 3,
        email: 'fresh@newmedspa.example',
        business_name: 'Fresh Med Spa',
        location: 'Irvine, CA',
        category: 'med spa',
        website_observation: 'booking form uses a third-party widget with no confirm step',
      }),
    ];
    const discovered = Array.from({ length: 30 }, (_, i) =>
      fixtureDiscoveredLead({
        id: `s${i}`,
        place_id: `places/sched${i}`,
        public_email: `sched${i}@ocwell.example`,
        business_name: `OC Well ${i}`,
        city: 'Costa Mesa',
        category: 'wellness spa',
        website: `https://ocwell${i}.example`,
        score_total: 70,
        weak_website_signals: [`hero CTA is phone-only ${i}`],
      }),
    );
    const cohort = await buildDaily20Cohort(
      {
        crmLeads: crm,
        discovered,
        history: [],
        suppressedEmails: new Set(),
        fixturesOnly: true,
        now,
      },
      memEnv,
    );
    assert.ok(!cohort.qualified.some((q) => q.email === 'admin@cellemedical.com'));
    assert.ok(!cohort.qualified.some((q) => q.email === 'info@akahairsalon.com'));
    assert.ok(cohort.rejected_pool.some((r) => r.reason === 'daily_20_batch_1_sent'));
    assert.ok(cohort.rejected_pool.some((r) => r.reason === 'hold_aka'));
    assert.ok(cohort.qualified.every((q) => q.website_observation && q.email));
  });
});

describe('Hobby single-cron + morning pipeline', () => {
  it('cron schedule fires once per weekday (Hobby-safe)', () => {
    // Once at minute 0 of hour 14 UTC, Mon–Fri — not */30 and not an hour range.
    assert.equal(OUTREACH_CRON_SCHEDULE, '0 14 * * 1-5');
    assert.ok(!OUTREACH_CRON_SCHEDULE.includes('*/'));
    assert.ok(!/\d+-\d+/.test(OUTREACH_CRON_SCHEDULE.split(' ')[1] || ''));
  });

  it('weekday cron due list is full morning pipeline; never send_window', () => {
    // 2026-10-23 Friday: any weekday PT time → full pipeline (Hobby single fire)
    const morningMs = Date.parse('2026-10-23T14:00:00Z'); // 7:00 PT PDT
    const middayMs = Date.parse('2026-10-23T16:10:00Z'); // 9:10 PT
    assert.deepEqual(jobsDueAt(morningMs), ['discover', 'verify', 'select', 'notify']);
    assert.deepEqual(jobsDueAt(middayMs), MORNING_PIPELINE_JOBS);
    assert.deepEqual(morningPipelineJobs(), MORNING_PIPELINE_JOBS);
    assert.ok(!jobsDueAt(morningMs).includes('send_window'));
    assert.ok(!jobsDueAt(middayMs).includes('replies'));

    const weekend = Date.parse('2026-10-24T16:00:00Z'); // Sat
    assert.deepEqual(jobsDueAt(weekend), []);
  });

  it('dispatch runs discover→verify→select→notify sequentially with stage stamps', async () => {
    const nowMs = Date.parse('2026-10-23T14:00:00Z');
    const ok = await dispatchOutreachCron(
      { authorization: 'Bearer cron-test-secret' },
      memEnv,
      {
        nowMs,
        fixturesOnly: true,
        fetchImpl: async () => new Response(JSON.stringify({ id: 'mock' }), { status: 200 }),
      },
    );
    assert.equal(ok.status, 200);
    assert.equal(ok.body.hobby_single_cron, true);
    assert.equal(ok.body.auto_send, false);
    assert.equal(ok.body.send_window_in_cron, false);
    assert.equal(ok.body.cron_schedule, '0 14 * * 1-5');
    assert.deepEqual(ok.body.due, ['discover', 'verify', 'select', 'notify']);
    const results = ok.body.results as Array<{ job: string; status: string }>;
    assert.deepEqual(
      results.map((r) => r.job),
      ['discover', 'verify', 'select', 'notify'],
    );
    assert.ok(results.every((r) => r.status === 'completed' || r.status === 'idempotent_skip'));
    assert.ok(!results.some((r) => r.job === 'send_window'));

    const stages = ok.body.stages as Record<string, { intended_pt: string; status: string }>;
    assert.equal(stages.discover?.intended_pt, '07:00');
    assert.equal(stages.verify?.intended_pt, '08:00');
    assert.equal(stages.select?.intended_pt, '08:30');
    assert.equal(stages.notify?.intended_pt, '09:00');
    assert.ok(['completed', 'idempotent_skip'].includes(stages.notify?.status));
  });

  it('is idempotent for the same job/day', async () => {
    const nowMs = Date.parse('2026-10-23T15:40:00Z');
    const first = await runSchedulerJob('select', memEnv, { nowMs, fixturesOnly: true, force: false });
    assert.equal(first.status, 'completed');
    const second = await runSchedulerJob('select', memEnv, { nowMs, fixturesOnly: true, force: false });
    assert.equal(second.status, 'idempotent_skip');
    const state = await readSchedulerState(memEnv);
    assert.equal(isJobComplete(state, 'select', first.day_key), true);
    assert.equal(idempotencyKey('select', first.day_key), `select:${first.day_key}`);
    assert.equal(state.stages.select?.status, 'idempotent_skip');
    assert.equal(state.hobby_single_cron, true);
  });

  it('cron requires CRON_SECRET and never auto-sends (even if send_window forced)', async () => {
    const denied = await dispatchOutreachCron({ authorization: 'Bearer wrong' }, memEnv, {
      nowMs: Date.parse('2026-10-23T16:10:00Z'),
      fixturesOnly: true,
    });
    assert.equal(denied.status, 401);

    const ok = await dispatchOutreachCron(
      { authorization: 'Bearer cron-test-secret' },
      memEnv,
      {
        nowMs: Date.parse('2026-10-23T16:10:00Z'),
        forceJobs: ['notify', 'send_window'],
        fixturesOnly: true,
        fetchImpl: async () => new Response(JSON.stringify({ id: 'mock' }), { status: 200 }),
      },
    );
    assert.equal(ok.status, 200);
    assert.equal(ok.body.auto_send, false);
    assert.equal(ok.body.live_email_send, false);
    const results = ok.body.results as Array<{ job: string; status: string; message: string }>;
    const send = results.find((r) => r.job === 'send_window');
    assert.ok(send);
    assert.ok(send!.status === 'skipped' || /live cron send OFF/i.test(send!.message));
  });
});

describe('owner notify (no prospect send)', () => {
  it('logs when RESEND_API_KEY missing; uses mocked Resend when set', async () => {
    const logged = await notifyOwnerDailyReviewReady(
      { day_key: '2026-10-23', qualified_count: 12, discovered_count: 40 },
      memEnv,
    );
    assert.equal(logged.channel, 'log');
    assert.equal(logged.to, 'hello@bbl.studio');

    let called = 0;
    const sent = await notifyOwnerDailyReviewReady(
      { day_key: '2026-10-23', qualified_count: 12, discovered_count: 40 },
      { ...memEnv, RESEND_API_KEY: 're_test' },
      async (_url, init) => {
        called += 1;
        const body = JSON.parse(String(init?.body || '{}')) as { to?: string[] };
        assert.deepEqual(body.to, ['hello@bbl.studio']);
        return new Response(JSON.stringify({ id: 'email_1' }), { status: 200 });
      },
    );
    assert.equal(called, 1);
    assert.equal(sent.ok, true);
    assert.equal(sent.channel, 'resend');
  });

  it('pacificParts dayKey is stable', () => {
    const p = pacificParts(Date.parse('2026-10-23T16:00:00Z'));
    assert.equal(p.dayKey, '2026-10-23');
    assert.equal(p.hour, 9);
  });
});
