import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  instagramPublishingApi,
  preflightInstagramPublishing,
} from './instagram-publishing.js';

const env = {
  INSTAGRAM_ACCESS_TOKEN: 'private-fixture-only',
  INSTAGRAM_ACCOUNT_ID: '123',
  INSTAGRAM_LOGIN_MODE: 'unified',
};
const fetchUrl = (url: Parameters<typeof fetch>[0]) =>
  typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
const identity = { id: '123', username: 'businessbrandlab' };
const quota = { data: [{ quota_usage: 0, config: { quota_total: 100 } }] };

void test('Unified Login uses fixed Facebook origin; Instagram Login stays compatible', () => {
  assert.equal(instagramPublishingApi(env), 'https://graph.facebook.com/v27.0');
  assert.equal(instagramPublishingApi({}), 'https://graph.instagram.com/v24.0');
  assert.equal(
    instagramPublishingApi({ ...env, META_GRAPH_VERSION: 'v28.0' }),
    'https://graph.facebook.com/v28.0',
  );
  assert.throws(() =>
    instagramPublishingApi({ INSTAGRAM_LOGIN_MODE: 'unknown' }),
  );
  assert.throws(() =>
    instagramPublishingApi({ META_GRAPH_VERSION: 'v27.0/../evil' }),
  );
});

void test('publishing preflight only reads exact identity and capability, without queue or publish calls', async () => {
  const calls: string[] = [];
  const result = await preflightInstagramPublishing(env, async (url, init) => {
    const path = fetchUrl(url);
    calls.push(path);
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    assert.equal(
      new Headers(init?.headers).get('Authorization'),
      `Bearer ${env.INSTAGRAM_ACCESS_TOKEN}`,
    );
    assert.equal(new URL(path).origin, 'https://graph.facebook.com');
    assert.equal(path.includes(env.INSTAGRAM_ACCESS_TOKEN), false);
    return Response.json(
      path.includes('content_publishing_limit') ? quota : identity,
    );
  });
  assert.equal(calls.length, 2);
  assert.equal(result.status, 'verified');
  assert.equal(result.quotaUsage, 0);
  assert.equal(result.quotaTotal, 100);
  assert.equal(result.published, 0);
  assert.equal(result.queued, 0);
  assert.equal(
    JSON.stringify(result).includes(env.INSTAGRAM_ACCESS_TOKEN),
    false,
  );
});

void test('missing credentials, invalid account and invalid login mode never contact provider', async () => {
  let calls = 0;
  const io: typeof fetch = async () => {
    calls++;
    throw Error('must not call');
  };
  for (const value of [
    {},
    { ...env, INSTAGRAM_ACCOUNT_ID: '../another' },
    { ...env, INSTAGRAM_LOGIN_MODE: 'bad' },
  ])
    assert.equal(
      (await preflightInstagramPublishing(value, io)).status,
      'unavailable',
    );
  assert.equal(calls, 0);
});

void test('mismatched id or account name stops before capability check', async () => {
  for (const account of [
    { ...identity, id: '999' },
    { ...identity, username: 'another-account' },
  ]) {
    let calls = 0;
    const result = await preflightInstagramPublishing(env, async () => {
      calls++;
      return Response.json(account);
    });
    assert.equal(calls, 1);
    assert.equal(result.reason, 'identity_mismatch');
    assert.equal(result.published, 0);
  }
});

void test('invalid quota data cannot be presented as a verified connection', async () => {
  for (const data of [
    [],
    [{ quota_usage: -1 }],
    [{ quota_usage: '0' }],
    [{ quota_usage: 0, config: { quota_total: '100' } }],
  ]) {
    const result = await preflightInstagramPublishing(env, async (url) =>
      Response.json(
        fetchUrl(url).includes('content_publishing_limit')
          ? { data }
          : identity,
      ),
    );
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, 'invalid_quota_response');
  }
  const result = await preflightInstagramPublishing(env, async (url) =>
    Response.json(
      fetchUrl(url).includes('content_publishing_limit')
        ? { data: [{ quota_usage: 2 }] }
        : identity,
    ),
  );
  assert.equal(result.status, 'verified');
  assert.equal(result.quotaTotal, null);
});

void test('provider errors and oversized responses never leak credentials or provider messages', async () => {
  for (const response of [
    new Response('private provider details', { status: 403 }),
    new Response('x'.repeat(65537)),
  ]) {
    const result = await preflightInstagramPublishing(
      env,
      async () => response,
    );
    assert.equal(result.status, 'unavailable');
    assert.equal(JSON.stringify(result).includes('private'), false);
    assert.equal(result.published, 0);
  }
});
