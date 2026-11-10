import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetMemoryCrmDb, dbReadKv, dbWriteKv } from './crm-db.js';
import {
  runGrowthTick,
  LOG_KEY,
  type GrowthEnv,
  type GrowthLog,
  type GrowthServices,
} from './growth.js';
import { growthReadiness } from './growth-readiness.js';
import {
  publishNextSocial,
  saveSocialPost,
  readSocialQueue,
} from './growth-social.js';

const env: GrowthEnv = {
  CRM_DATABASE_MEMORY: '1',
  CRM_DATABASE_URL: 'memory://worker-review-tests',
};
const now = Date.parse('2026-11-09T18:00:00Z');
const noNetwork: typeof fetch = async () => {
  throw new Error('Network forbidden in worker proof');
};
const services: Partial<GrowthServices> = {
  marketing: async () => ({
    ok: true,
    status: 'IDLE',
    message: 'Synthetic read check',
    transmitted: 0,
  }),
  reviews: async () => [],
  social: async () => ({ status: 'disabled', published: 0 }),
};
beforeEach(() => resetMemoryCrmDb(env));

void test('Google failures retry after an hour and incomplete Google evidence is never logged verified', async () => {
  let checked=0;
  const failed={at:new Date(now-2*3600000).toISOString(),technical:[],search:{status:'verified' as const,rows:[]},traffic:{status:'unavailable' as const}};
  const result=await runGrowthTick({...env,GROWTH_MONITOR_ENABLED:'true'},noNetwork,now,{
    ...services,readMonitor:async()=>failed,monitor:async()=>{checked++;return {...failed,at:new Date(now).toISOString()};},
  });
  assert.equal(checked,1);
  assert.ok(result.logs?.some(l=>l.agent==='seo_geo' && l.status==='partial'));
});

void test('readiness distinguishes missing permissions from connected providers without leaking secrets', () => {
  const result = growthReadiness(
    {
      ...env,
      RESEND_API_KEY: 'private-provider-marker',
      SOCIAL_PUBLISH_ENABLED: 'true',
      SOCIAL_QUEUE_RECONCILED_AT: '2027-01-01T00:00:00Z',
    },
    now,
  );
  assert.equal(result.configurationOnly, true);
  assert.equal(result.providerAuthorizationVerified, false);
  assert.equal(result.social.existingQueueReconciled, false);
  assert.equal(result.monitoring.enabled, false);
  assert.ok(
    result.social.instagram.missingConfiguration.includes(
      'INSTAGRAM_ACCESS_TOKEN',
    ),
  );
  assert.equal(
    JSON.stringify(result).includes('private-provider-marker'),
    false,
  );
});
void test('default worker without credentials fails closed and makes no provider calls', async () => {
  let calls = 0;
  const result = await runGrowthTick(
    env,
    async () => {
      calls++;
      throw Error('Forbidden');
    },
    now,
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.transmitted, 0);
  assert.equal(result.prospect_emails_transmitted, 0);
  assert.equal(result.social_publications, 0);
  assert.equal(calls, 0);
});
void test('a failed monitor read does not suppress social checks or lose the failure log', async () => {
  let socialChecks = 0;
  const result = await runGrowthTick(
    { ...env, GROWTH_MONITOR_ENABLED: 'true' },
    noNetwork,
    now,
    {
      ...services,
      readMonitor: async () => {
        throw Error('Synthetic database failure');
      },
      social: async () => {
        socialChecks++;
        return { status: 'disabled', published: 0 };
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(socialChecks, 1);
  assert.ok(
    result.logs?.some((l) => l.agent === 'seo_geo' && l.status === 'failed'),
  );
  assert.ok(
    (await dbReadKv<GrowthLog[]>(LOG_KEY, [], env)).some(
      (l) => l.agent === 'seo_geo' && l.status === 'failed',
    ),
  );
});
void test('missing enabled-provider credentials are reported as blocked rather than healthy', async () => {
  const result = await runGrowthTick(env, noNetwork, now, {
    ...services,
    social: async () => ({ status: 'credentials_missing', published: 0 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.logs?.some((l) => l.status === 'credentials_missing'));
});
void test('old failures remain in history but cannot contaminate a successful current run', async () => {
  await dbWriteKv(
    LOG_KEY,
    [
      {
        at: new Date(now).toISOString(),
        agent: 'previous',
        status: 'failed',
        message: 'Old synthetic run',
      },
    ],
    env,
  );
  const result = await runGrowthTick(env, noNetwork, now, services);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'COMPLETED');
  assert.equal(
    result.logs?.some((l) => l.agent === 'previous'),
    false,
  );
  assert.equal(
    (await dbReadKv<GrowthLog[]>(LOG_KEY, [], env)).some(
      (l) => l.agent === 'previous',
    ),
    true,
  );
});
void test('social publication receipts and zero prospect emails use separate counters', async () => {
  const result = await runGrowthTick(env, noNetwork, now, {
    ...services,
    social: async () => ({ status: 'published', published: 1 }),
  });
  assert.equal(result.social_publications, 1);
  assert.equal(result.prospect_emails_transmitted, 0);
});
void test('future queue reconciliation and malformed queue records cannot authorize publication', async () => {
  const result = await publishNextSocial(
    {
      ...env,
      SOCIAL_PUBLISH_ENABLED: 'true',
      SOCIAL_QUEUE_RECONCILED_AT: '2027-01-01T00:00:00Z',
    },
    noNetwork,
    now,
  );
  assert.equal(result.status, 'reconciliation_required');
  assert.equal(result.published, 0);
  await assert.rejects(
    saveSocialPost(
      {
        id: '',
        network: 'linkedin',
        caption: 'Synthetic draft',
        scheduledAt: '2026-11-09T18:00:00Z',
        createdAt: '',
        status: 'review',
      },
      env,
    ),
    /queue ID/,
  );
  assert.deepEqual(await readSocialQueue(env), []);
});

void test('Unified Login read stage stores real-shaped evidence independently of publishing and reports failures', async () => {
  const result = await runGrowthTick(
    { ...env, INSTAGRAM_READ_ENABLED: 'true' },
    noNetwork,
    now,
    {
      ...services,
      readInstagram: async () => null,
      instagramRead: async () => ({
        at: new Date(now).toISOString(),
        status: 'unavailable',
        reason: 'credentials_missing',
      }),
    },
  );
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.social_publications, 0);
  const logs = await dbReadKv<GrowthLog[]>(LOG_KEY, [], env);
  assert.ok(
    logs.some(
      (log) => log.agent === 'instagram_read' && log.status === 'failed',
    ),
  );
});
