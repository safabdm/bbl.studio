/**
 * Daily outreach scheduler — PT-gated morning pipeline, GHA primary,
 * idempotency, exclusions, no auto-send.
 */
import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { resetMemoryCrmDb } from './crm-db.ts';
import { resetMemoryDiscovery } from './crm-discovery-store.ts';
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
  GITHUB_ACTIONS_CRON_SCHEDULE,
  MORNING_PIPELINE_JOBS,
  OUTREACH_CRON_SCHEDULE,
  OUTREACH_CRON_SCHEDULE_PST_BACKUP,
  SCHEDULER_SOURCE_OF_TRUTH,
  dispatchOutreachCron,
  getOutreachReadinessSnapshot,
  getSchedulerDashboard,
  idempotencyKey,
  isJobComplete,
  jobsDueAt,
  morningPipelineJobs,
  readSchedulerState,
  runSchedulerJob,
  shouldDispatchMorningPipeline,
} from './daily-outreach-scheduler.ts';
import { pacificParts } from './pacific-time.ts';
import { notifyOwnerDailyReviewReady } from './owner-notify.ts';
import { listStudioDrafts } from './email-studio.ts';

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
  resetMemoryDiscovery(memEnv);
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

describe('PT-gated morning pipeline (GHA primary)', () => {
  it('documents source of truth + Hobby-safe Vercel backups', () => {
    assert.equal(SCHEDULER_SOURCE_OF_TRUTH, 'github-actions');
    assert.equal(GITHUB_ACTIONS_CRON_SCHEDULE, '5 13-17 * * 1-5');
    assert.equal(OUTREACH_CRON_SCHEDULE, '0 14 * * 1-5');
    assert.equal(OUTREACH_CRON_SCHEDULE_PST_BACKUP, '0 15 * * 1-5');
    assert.ok(!OUTREACH_CRON_SCHEDULE.includes('*/'));
    assert.ok(!OUTREACH_CRON_SCHEDULE_PST_BACKUP.includes('*/'));
  });

  it('jobsDueAt only inside 07:00–08:59 PT weekday; never send_window', () => {
    // PDT Friday 7:05 PT
    const startMs = Date.parse('2026-10-23T14:05:00Z');
    assert.equal(shouldDispatchMorningPipeline(startMs), true);
    assert.deepEqual(jobsDueAt(startMs), ['discover', 'verify', 'select', 'notify']);
    assert.deepEqual(morningPipelineJobs(), MORNING_PIPELINE_JOBS);
    assert.ok(!jobsDueAt(startMs).includes('send_window'));

    // PDT Friday 9:10 PT — past window
    const lateMs = Date.parse('2026-10-23T16:10:00Z');
    assert.equal(pacificParts(lateMs).hour, 9);
    assert.equal(shouldDispatchMorningPipeline(lateMs), false);
    assert.deepEqual(jobsDueAt(lateMs), []);

    // PST Wednesday 6:05 PT — too early (Vercel 14:00 UTC in winter)
    const earlyPst = Date.parse('2026-01-14T14:05:00Z');
    assert.equal(pacificParts(earlyPst).hour, 6);
    assert.deepEqual(jobsDueAt(earlyPst), []);

    // PST Wednesday 7:05 PT — run
    const pst7 = Date.parse('2026-01-14T15:05:00Z');
    assert.deepEqual(jobsDueAt(pst7), MORNING_PIPELINE_JOBS);

    const weekend = Date.parse('2026-10-24T15:00:00Z');
    assert.deepEqual(jobsDueAt(weekend), []);
  });

  it('dispatch skips outside PT window; runs full pipeline inside (with drafts)', async () => {
    const outside = await dispatchOutreachCron(
      { authorization: 'Bearer cron-test-secret' },
      memEnv,
      {
        nowMs: Date.parse('2026-10-23T16:10:00Z'), // 9:10 PT
        fixturesOnly: true,
        source: 'github-actions',
      },
    );
    assert.equal(outside.status, 200);
    assert.equal(outside.body.skipped, true);
    assert.equal(outside.body.reason, 'outside_pt_dispatch_window');
    assert.equal(outside.body.auto_send, false);

    const ok = await dispatchOutreachCron(
      { authorization: 'Bearer cron-test-secret' },
      memEnv,
      {
        nowMs: Date.parse('2026-10-23T14:05:00Z'), // 7:05 PT PDT
        fixturesOnly: true,
        seedProofFixtures: true,
        source: 'github-actions',
        fetchImpl: async () => new Response(JSON.stringify({ id: 'mock' }), { status: 200 }),
      },
    );
    assert.equal(ok.status, 200);
    assert.equal(ok.body.hobby_single_cron, true);
    assert.equal(ok.body.source_of_truth, 'github-actions');
    assert.equal(ok.body.source, 'github-actions');
    assert.equal(ok.body.auto_send, false);
    assert.equal(ok.body.send_window_in_cron, false);
    assert.deepEqual(ok.body.due, ['discover', 'verify', 'select', 'notify']);
    const results = ok.body.results as Array<{ job: string; status: string; details?: Record<string, unknown> }>;
    assert.deepEqual(
      results.map((r) => r.job),
      ['discover', 'verify', 'select', 'notify'],
    );
    assert.ok(results.every((r) => r.status === 'completed' || r.status === 'idempotent_skip'));
    assert.ok(!results.some((r) => r.job === 'send_window'));
    const select = results.find((r) => r.job === 'select');
    assert.ok((select?.details?.qualified as number) >= 1);
    assert.ok((select?.details?.drafts_ready as number) >= 1);
    assert.equal(select?.details?.padded, false);

    const stages = ok.body.stages as Record<string, { intended_pt: string; status: string }>;
    assert.equal(stages.discover?.intended_pt, '07:00');
    assert.equal(stages.notify?.intended_pt, '09:00');

    // Second tick same LA day is idempotent (no double heavy work)
    const again = await dispatchOutreachCron(
      { authorization: 'Bearer cron-test-secret' },
      memEnv,
      {
        nowMs: Date.parse('2026-10-23T15:10:00Z'), // 8:10 PT catch-up
        fixturesOnly: true,
        seedProofFixtures: true,
        source: 'vercel',
      },
    );
    assert.equal(again.status, 200);
    const againResults = again.body.results as Array<{ status: string }>;
    assert.ok(againResults.every((r) => r.status === 'idempotent_skip'));
  });

  it('select persists unapproved personalized drafts for Daily Review', async () => {
    const { upsertDiscoveredLead } = await import('./crm-discovery-store.ts');
    const nowMs = Date.parse('2026-10-23T14:30:00Z');
    for (let i = 0; i < 25; i++) {
      await upsertDiscoveredLead(
        fixtureDiscoveredLead({
          id: `d${i}`,
          place_id: `places/d${i}`,
          public_email: `lead${i}@ocspa.example`,
          business_name: `OC Spa ${i}`,
          city: 'Irvine',
          category: 'med spa',
          website: `https://ocspa${i}.example`,
          score_total: 80,
          status: 'qualified',
          weak_website_signals: [`booking widget lacks confirm ${i}`],
        }),
        memEnv,
      );
    }
    // Live select path (no fixturesOnly) reads discovered store → qualify → persist drafts
    const select = await runSchedulerJob('select', memEnv, { nowMs, fixturesOnly: false });
    assert.equal(select.status, 'completed');
    assert.ok((select.details?.qualified as number) >= 1);
    assert.ok((select.details?.drafts_ready as number) >= 1);
    assert.equal(select.details?.auto_approved, false);
    assert.equal(select.details?.padded, false);
    const drafts = await listStudioDrafts(memEnv);
    assert.ok(drafts.length >= 1);
    assert.ok(drafts.every((d) => d.approved === false));
    assert.ok(drafts.every((d) => d.observation_verified));
  });

  it('is idempotent for the same job/day', async () => {
    const nowMs = Date.parse('2026-10-23T14:40:00Z');
    const first = await runSchedulerJob('select', memEnv, { nowMs, fixturesOnly: true, force: false });
    assert.equal(first.status, 'completed');
    const second = await runSchedulerJob('select', memEnv, { nowMs, fixturesOnly: true, force: false });
    assert.equal(second.status, 'idempotent_skip');
    const state = await readSchedulerState(memEnv);
    assert.equal(isJobComplete(state, 'select', first.day_key), true);
    assert.equal(idempotencyKey('select', first.day_key), `select:${first.day_key}`);
    assert.equal(state.stages.select?.status, 'idempotent_skip');
  });

  it('cron requires CRON_SECRET and never auto-sends (even if send_window forced)', async () => {
    const denied = await dispatchOutreachCron({ authorization: 'Bearer wrong' }, memEnv, {
      nowMs: Date.parse('2026-10-23T14:10:00Z'),
      fixturesOnly: true,
    });
    assert.equal(denied.status, 401);

    const ok = await dispatchOutreachCron(
      { authorization: 'Bearer cron-test-secret' },
      memEnv,
      {
        nowMs: Date.parse('2026-10-23T14:10:00Z'),
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

  it('dashboard next_runs use America/Los_Angeles', async () => {
    const nowMs = Date.parse('2026-01-14T14:00:00Z'); // 6am PST Wed
    const dash = await getSchedulerDashboard(memEnv, nowMs);
    assert.equal(dash.timezone, 'America/Los_Angeles');
    assert.equal(dash.source_of_truth, 'github-actions');
    assert.equal(dash.auto_send, false);
    assert.match(dash.next_runs.cron.at_pt, /America\/Los_Angeles/);
    assert.equal(dash.next_runs.cron.dayKey, '2026-01-14');
    assert.equal(pacificParts(Date.parse(dash.next_runs.cron.at_utc)).hour, 7);
  });

  it('readiness snapshot exposes booleans only (send stays safe by default)', () => {
    const snap = getOutreachReadinessSnapshot({
      ...memEnv,
      OUTREACH_CRON_SEND_ENABLED: 'false',
      GOOGLE_PLACES_API_KEY: '',
    });
    assert.equal(snap.auto_send, false);
    assert.equal(snap.config.cron_secret_configured, true);
    assert.equal(snap.config.places_configured, false);
    assert.equal(snap.config.outreach_cron_send_enabled, false);
    assert.equal(snap.config.email_dry_run, true);
    assert.equal(snap.safety.live_cron_send_allowed, false);
    assert.ok(snap.deploy_blockers.includes('GOOGLE_PLACES_API_KEY'));
    assert.ok(!JSON.stringify(snap).includes(memEnv.CRON_SECRET));
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
