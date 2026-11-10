import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetMemoryCrmDb } from './crm-db.js';
import {
  runInstagramRead,
  readInstagramSnapshot,
  type InstagramReadEnv,
} from './instagram-read.js';
const env: InstagramReadEnv = {
  CRM_DATABASE_MEMORY: '1',
  CRM_DATABASE_URL: 'memory://instagram-read',
  INSTAGRAM_READ_ENABLED: 'true',
  INSTAGRAM_READ_ACCESS_TOKEN: 'synthetic-secret',
  INSTAGRAM_READ_ACCOUNT_ID: '17841467961734048',
};
beforeEach(() => resetMemoryCrmDb(env));
void test('Unified Login reads only fixed Facebook Graph GET endpoints and stores bounded verified evidence', async () => {
  const calls: string[] = [];
  const result = await runInstagramRead(env, async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    calls.push(url);
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    assert.equal(
      (init?.headers as Record<string, string> | undefined)?.Authorization,
      'Bearer synthetic-secret',
    );
    return new Response(
      JSON.stringify(
        url.includes('/media?')
          ? {
              data: [
                {
                  id: '123',
                  media_type: 'VIDEO',
                  timestamp: '2026-11-09T12:00:00Z',
                },
              ],
              paging: { next: 'https://evil.invalid' },
            }
          : { id: env.INSTAGRAM_READ_ACCOUNT_ID, username: 'businessbrandlab' },
      ),
    );
  });
  assert.equal(result.status, 'verified');
  assert.equal(calls.length, 2);
  assert.ok(
    calls.every((url) => url.startsWith('https://graph.facebook.com/v27.0/')),
  );
  assert.equal(
    JSON.stringify(await readInstagramSnapshot(env)).includes(
      'synthetic-secret',
    ),
    false,
  );
});
void test('disabled or missing credentials cause zero provider calls', async () => {
  const forbidden: typeof fetch = async () => {
    throw Error('unexpected network');
  };
  assert.equal(
    (
      await runInstagramRead(
        { ...env, INSTAGRAM_READ_ENABLED: 'false' },
        forbidden,
      )
    ).reason,
    'disabled',
  );
  assert.equal(
    (
      await runInstagramRead(
        { ...env, INSTAGRAM_READ_ACCESS_TOKEN: '' },
        forbidden,
      )
    ).reason,
    'credentials_missing',
  );
});
void test('wrong identity stops before media and failure replaces old verified evidence without leaking provider errors', async () => {
  let calls = 0;
  await runInstagramRead(env, async () => {
    calls++;
    return new Response(
      JSON.stringify({
        id: env.INSTAGRAM_READ_ACCOUNT_ID,
        username: 'someone_else',
      }),
    );
  });
  assert.equal(calls, 1);
  assert.equal((await readInstagramSnapshot(env))?.status, 'unavailable');
  const result = await runInstagramRead(env, async () => {
    throw Error('synthetic-secret');
  });
  assert.equal(JSON.stringify(result).includes('synthetic-secret'), false);
});
