import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resetMemoryCrmDb, dbWriteKv } from './crm-db.js';
import { resetMemoryDiscovery } from './crm-discovery-store.js';
import {
  growthDashboard,
  salesAssistant,
  saveSalesRecord,
  type GrowthEnv,
  prepareSalesReviews,
  SALES_KEY,
} from './growth.js';
import { MARKETING_STATE } from './marketing-automation.js';
import { buildDaily20Cohort } from './daily-20-pipeline.js';
import { fixtureCrmLead } from './lead-queue.js';
import { listStudioDrafts, upsertStudioDraftFromLead } from './email-studio.js';
import {
  saveSocialPost,
  readSocialQueue,
  socialDigest,
  publishNextSocial,
  SOCIAL_QUEUE,
  type SocialPost,
} from './growth-social.js';
import { runGrowthMonitor, readWithRetry } from './growth-monitor.js';
import { dispatchOutreachCron } from './daily-outreach-scheduler.js';

const env: GrowthEnv = {
  CRM_DATABASE_MEMORY: '1',
  CRM_DATABASE_URL: 'memory://growth-tests',
};
beforeEach(() => {
  resetMemoryCrmDb(env);
  resetMemoryDiscovery(env);
});
void test('inbound sales suggestions use evidence and never overwrite owner-confirmed stages', async () => {
  await dbWriteKv(
    MARKETING_STATE,
    {
      paused: false,
      attempts: [],
      clients: [],
      stoppedEmails: [],
      lastRun: null,
      inbound: [
        {
          id: 'inbound-proof',
          email: 'owner@example.org',
          subject: 'Website request',
          text: 'Yes, send a proposal',
          receivedAt: '2026-11-09T18:00:00Z',
          automated: false,
        },
      ],
    },
    env,
  );
  const record = {
    email: 'owner@example.org',
    stage: 'won',
    requirements: 'Three informational pages',
    evidence: 'Owner verified payment',
    updatedAt: '2026-11-09T17:00:00Z',
  };
  await dbWriteKv(SALES_KEY, [record], env);
  const reviews = await prepareSalesReviews(env);
  assert.equal(reviews[0]?.messageId, 'inbound-proof');
  assert.equal(reviews[0]?.classification, 'interested');
  assert.equal(reviews[0]?.transmitted, 0);
  assert.equal(reviews[0]?.approvalRequired, true);
  assert.match(reviews[0]!.proposal!, /Three informational pages/);
  const dashboard = await growthDashboard(env);
  assert.deepEqual(dashboard.sources.sales.data, [record]);
});
const mediaBytes = 'synthetic MP4 transport fixture';
const mediaResponse = () =>
  new Response(mediaBytes, { headers: { 'content-type': 'video/mp4' } });
const post = (change: Partial<SocialPost> = {}): SocialPost => ({
  id: 'reel',
  network: 'instagram',
  caption: 'Clear service. Clear action. #BBLStudio',
  mediaUrl: 'https://media.bbl.studio/reel.mp4',
  mediaSha256: createHash('sha256').update(mediaBytes).digest('hex'),
  authorUrn: 'urn:li:organization:42',
  scheduledAt: '2026-11-09T10:00:00-08:00',
  createdAt: '2026-11-09T17:00:00Z',
  status: 'review',
  ...change,
});
const live = {
  ...env,
  SOCIAL_PUBLISH_ENABLED: 'true',
  SOCIAL_QUEUE_RECONCILED_AT: '2026-11-09T17:00:00Z',
  INSTAGRAM_ACCESS_TOKEN: 'test-only',
  INSTAGRAM_ACCOUNT_ID: '123',
  SOCIAL_MEDIA_HOSTS: 'media.bbl.studio',
};
const approve = async (p: SocialPost, e = env) =>
  saveSocialPost(p, e, {
    reviewer: 'owner',
    qa: 'Watched motion, verified rights, checksum, caption and time.',
    digest: socialDigest(p),
  });
const now = Date.parse('2026-11-09T19:00:00Z');

void test('Daily-20 keeps same-day review stable and never counts yesterday backlog as new leads', async () => {
  const options = {
    crmLeads: [
      fixtureCrmLead({
        id: 1001,
        email: 'owner@daily-proof.example',
        website_observation: 'the site displays placeholder text',
      }),
    ],
    discovered: [],
    history: [],
    suppressedEmails: new Set<string>(),
    fixturesOnly: true,
    now,
  };
  const first = await buildDaily20Cohort(options, env);
  assert.equal(first.qualified.length, 1);
  await upsertStudioDraftFromLead(first.qualified[0]!, {}, env);
  assert.equal(
    (await buildDaily20Cohort({ ...options, now: now + 1000 }, env)).qualified
      .length,
    1,
  );
  const next = await buildDaily20Cohort(
    { ...options, now: now + 86400000 },
    env,
  );
  assert.equal(next.qualified.length, 0);
  assert.equal(
    next.rejected_pool[0]?.reason,
    'already_prepared_for_owner_review',
  );
  assert.equal((await listStudioDrafts(env)).length, 1);
});

void test('GitHub and Vercel morning dispatches share a durable lease', async () => {
  const configured = {
    ...env,
    CRON_SECRET: 'proof-only',
    EMAIL_DRY_RUN: 'true',
    OUTREACH_CRON_SEND_ENABLED: 'false',
  };
  const run = (source: string) =>
    dispatchOutreachCron({ authorization: 'Bearer proof-only' }, configured, {
      nowMs: Date.parse('2026-11-09T15:05:00Z'),
      fixturesOnly: true,
      seedProofFixtures: true,
      source,
    });
  const results = await Promise.all([run('github-actions'), run('vercel')]);
  assert.equal(
    results.filter((r) => r.body.reason === 'pipeline_busy').length,
    1,
  );
  assert.equal(
    results.filter((r) => r.body.morning_pipeline_complete === true).length,
    1,
  );
  assert.ok(results.every((r) => r.body.auto_send === false));
});

void test('empty dashboard never invents provider, social or search outcomes', async () => {
  const result = await growthDashboard(env, now);
  assert.equal(result.metrics.providerAccepted, null);
  assert.equal(result.metrics.instagramReach, null);
  assert.equal(result.health.morning, 'never_observed');
  assert.equal(result.sources.monitor.data, null);
});
void test('sales proposals require verified requirements and commitments remain unapproved', async () => {
  await assert.rejects(
    saveSalesRecord(
      {
        email: 'owner@example.org',
        stage: 'proposal',
        requirements: '',
        evidence: 'Owner verified',
        updatedAt: '',
      },
      env,
    ),
  );
  const record = await saveSalesRecord(
    {
      email: 'owner@example.org',
      stage: 'proposal',
      requirements: 'Home, Services, Contact; booking integration requested.',
      evidence: 'Client brief #42',
      updatedAt: '',
    },
    env,
  );
  assert.match(record.proposal!, /owner review required/);
  assert.match(record.proposal!, /No commitment/);
  const reply = salesAssistant({
    id: '1',
    email: record.email,
    subject: '',
    text: 'Yes, send a proposal',
    receivedAt: new Date(now).toISOString(),
    automated: false,
  });
  assert.equal(reply.classification, 'interested');
  assert.equal(reply.transmitted, 0);
  assert.equal(reply.approvalRequired, true);
  assert.equal(
    salesAssistant({
      id: '2',
      email: record.email,
      subject: '',
      text: 'Please stop emailing me',
      receivedAt: '',
      automated: false,
    }).response,
    null,
  );
});
void test('social defaults deny publishing without making any provider request', async () => {
  await approve(post());
  let calls = 0;
  const result = await publishNextSocial(
    env,
    async () => {
      calls++;
      throw Error('Forbidden');
    },
    now,
  );
  assert.equal(result.published, 0);
  assert.equal(calls, 0);
});
void test('unreviewed draft cannot publish, forged approval is rejected', async () => {
  await saveSocialPost(post(), env);
  let calls = 0;
  await publishNextSocial(
    live,
    async () => {
      calls++;
      throw Error('Forbidden');
    },
    now,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    saveSocialPost(post(), env, {
      reviewer: 'owner',
      qa: 'ok',
      digest: 'forged',
    }),
  );
});
void test('editing copy, media or schedule removes approval; ambiguous Pacific time is rejected', async () => {
  await approve(post());
  const edited = await saveSocialPost(post({ caption: 'Edited caption' }), env);
  assert.equal(edited.status, 'review');
  assert.equal(edited.approval, undefined);
  await assert.rejects(
    saveSocialPost(post({ scheduledAt: '2026-11-01T01:30:00' }), env),
  );
});
void test('duplicate content is rejected across IDs even with a different schedule', async () => {
  await saveSocialPost(post(), env);
  await assert.rejects(
    saveSocialPost(
      post({ id: 'duplicate', scheduledAt: '2026-11-10T18:00:00Z' }),
      env,
    ),
    /Duplicate/,
  );
});
void test('Instagram verifies exact account identity before a provider mutation', async () => {
  await approve(post());
  let writes = 0;
  await assert.rejects(
    publishNextSocial(
      live,
      async (_url, init) => {
        if (init?.method === 'POST') writes++;
        return Response.json({ username: 'wrongaccount' });
      },
      now,
    ),
  );
  assert.equal(writes, 0);
});
void test('approved Instagram creates container, polls, publishes once with durable receipt', async () => {
  await approve(post());
  let writes = 0;
  const io: typeof fetch = async (url, init) => {
    const u =
      typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (u.startsWith('https://media.bbl.studio/')) {
      assert.equal(new Headers(init?.headers).has('Authorization'), false);
      return mediaResponse();
    }
    if (init?.method === 'POST') {
      writes++;
      return Response.json({
        id: u.endsWith('media_publish') ? 'published-id' : 'container-id',
      });
    }
    return Response.json(
      u.includes('fields=username')
        ? { username: 'businessbrandlab' }
        : { status_code: 'FINISHED' },
    );
  };
  assert.equal((await publishNextSocial(live, io, now)).status, 'processing');
  const results = await Promise.all([
    publishNextSocial(live, io, now),
    publishNextSocial(live, io, now),
  ]);
  assert.equal(
    results.reduce((n, r) => n + r.published, 0),
    1,
  );
  assert.equal(writes, 2);
  assert.equal((await readSocialQueue(env))[0]?.providerId, 'published-id');
  await publishNextSocial(live, io, now);
  assert.equal(writes, 2);
});
void test('uncertain provider POST is held and never automatically repeated', async () => {
  await approve(post());
  let writes = 0;
  const io: typeof fetch = async (_url, init) => {
    if (
      typeof _url === 'string' &&
      _url.startsWith('https://media.bbl.studio/')
    )
      return mediaResponse();
    if (init?.method === 'POST') {
      writes++;
      throw Error('timeout after provider accepted');
    }
    return Response.json({ username: 'businessbrandlab' });
  };
  assert.equal((await publishNextSocial(live, io, now)).status, 'uncertain');
  await publishNextSocial(live, io, now);
  assert.equal(writes, 1);
  await assert.rejects(saveSocialPost(post(), env), /immutable/);
});
void test('approval hash tampering fails closed', async () => {
  const p = await approve(post());
  p.caption = 'Tampered';
  await dbWriteKv(SOCIAL_QUEUE, [p], env);
  await assert.rejects(
    publishNextSocial(
      live,
      async () => {
        throw Error('Network forbidden');
      },
      now,
    ),
    /Approval/,
  );
});
void test('changed media and untrusted media hosts cannot trigger a provider mutation', async () => {
  await approve(post());
  let writes = 0;
  const io: typeof fetch = async (url, init) => {
    if (init?.method === 'POST') writes++;
    if (typeof url === 'string' && url.startsWith('https://media.bbl.studio/'))
      return new Response('changed content', {
        headers: { 'content-type': 'video/mp4' },
      });
    return Response.json({ username: 'businessbrandlab' });
  };
  await assert.rejects(publishNextSocial(live, io, now), /checksum/);
  await assert.rejects(
    publishNextSocial({ ...live, SOCIAL_MEDIA_HOSTS: '' }, io, now),
    /trusted/,
  );
  assert.equal(writes, 0);
});
void test('changing LinkedIn account configuration invalidates the approved destination', async () => {
  await approve(post({ network: 'linkedin' }));
  let calls = 0;
  await assert.rejects(
    publishNextSocial(
      {
        ...live,
        LINKEDIN_ACCESS_TOKEN: 'test-only',
        LINKEDIN_AUTHOR_URN: 'urn:li:organization:other',
      },
      async () => {
        calls++;
        throw Error('Forbidden');
      },
      now,
    ),
    /destination/,
  );
  assert.equal(calls, 0);
});
void test('LinkedIn publication requires approved caption, author and a provider receipt', async () => {
  const p = post({
    network: 'linkedin',
    mediaUrl: undefined,
    mediaSha256: undefined,
  });
  await approve(p);
  let calls = 0;
  const result = await publishNextSocial(
    {
      ...live,
      LINKEDIN_ACCESS_TOKEN: 'test-only',
      LINKEDIN_AUTHOR_URN: 'urn:li:organization:42',
    },
    async (url, init) => {
      calls++;
      assert.equal(
        typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
        'https://api.linkedin.com/rest/posts',
      );
      assert.equal(
        JSON.parse(typeof init?.body === 'string' ? init.body : '{}')
          .commentary,
        p.caption,
      );
      return new Response(null, {
        status: 201,
        headers: { 'x-restli-id': 'urn:li:share:42' },
      });
    },
    now,
  );
  assert.equal(result.published, 1);
  assert.equal(calls, 1);
});
void test('technical SEO audit records observed evidence, missing OAuth stays unavailable', async () => {
  const result = await runGrowthMonitor(
    env,
    async () =>
      new Response(
        '<title>BBL Studio</title><meta name="viewport"><link rel="canonical"><meta name="description"><script type="application/ld+json">{}</script>',
      ),
    now,
  );
  assert.equal(result.technical.length, 5);
  assert.equal(result.search.status, 'unavailable');
  assert.equal(result.traffic.status, 'unavailable');
  assert.equal(result.technical[0]?.checks.canonical, true);
});
void test('preapproved recurring content publishes only at the exact approved DST-offset times', async () => {
  const p = post({
    network: 'linkedin',
    repeatAt: ['2026-11-16T10:00:00-08:00'],
    mediaUrl: undefined,
    mediaSha256: undefined,
  });
  await approve(p);
  const configured = {
    ...live,
    LINKEDIN_ACCESS_TOKEN: 'test-only',
    LINKEDIN_AUTHOR_URN: 'urn:li:organization:42',
  };
  let calls = 0;
  const io: typeof fetch = async () => {
    calls++;
    return new Response(null, {
      status: 201,
      headers: { 'x-restli-id': `urn:li:share:${calls}` },
    });
  };
  assert.equal((await publishNextSocial(configured, io, now)).published, 1);
  assert.equal(
    (await publishNextSocial(configured, io, now + 86400000)).published,
    0,
  );
  assert.equal(
    (
      await publishNextSocial(
        configured,
        io,
        Date.parse('2026-11-16T18:00:00Z'),
      )
    ).published,
    1,
  );
  assert.equal((await readSocialQueue(env))[0]?.receipts?.length, 2);
  assert.equal((await readSocialQueue(env))[0]?.status, 'published');
  assert.equal(calls, 2);
});
void test('safe read retries transient failure, never labels failed OAuth as verified', async () => {
  let calls = 0;
  const response = await readWithRetry(
    'https://www.bbl.studio/',
    {},
    async () => {
      calls++;
      return new Response('', { status: calls === 1 ? 503 : 200 });
    },
  );
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
  const monitor = await runGrowthMonitor(
    {
      ...env,
      GROWTH_GOOGLE_CLIENT_ID: 'test',
      GROWTH_GOOGLE_CLIENT_SECRET: 'test',
      GROWTH_GOOGLE_REFRESH_TOKEN: 'test',
    },
    async () => Response.json({ error: 'denied' }, { status: 401 }),
    now,
  );
  assert.equal(monitor.search.status, 'unavailable');
  assert.equal(monitor.traffic.status, 'unavailable');
});
