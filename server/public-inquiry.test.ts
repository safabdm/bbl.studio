import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { resetSnapshotCache } from './crm-sync-store.js';
import { resetInquiryRateLimit, submitPublicInquiry } from './public-inquiry.js';

describe('public inquiry → CRM inbox', () => {
  const dirs: string[] = [];

  afterEach(() => {
    resetInquiryRateLimit();
    resetSnapshotCache();
    for (const dir of dirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  function env() {
    const dir = mkdtempSync(join(tmpdir(), 'bbl-inquiry-'));
    dirs.push(dir);
    return {
      CRM_SYNC_STORE_PATH: join(dir, 'snap.json'),
      // Force local JSON path (not Vercel durable DB requirement)
      VERCEL: undefined,
      CRM_DATABASE_URL: undefined,
    } as NodeJS.ProcessEnv;
  }

  it('appends a website_form inbox item', async () => {
    const result = await submitPublicInquiry(
      {
        name: 'Alex Owner',
        email: 'alex@example.com',
        service: 'Landing page',
        message: 'Need a clearer homepage CTA.',
      },
      '203.0.113.10',
      env(),
    );
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
  });

  it('honeypot succeeds without writing meaningful content requirement bypass', async () => {
    const result = await submitPublicInquiry(
      {
        name: 'Bot',
        email: 'bot@example.com',
        message: 'spam',
        website: 'https://spam.example',
      },
      '203.0.113.11',
      env(),
    );
    assert.equal(result.ok, true);
  });

  it('rate limits repeated posts from one IP', async () => {
    const e = env();
    for (let i = 0; i < 5; i += 1) {
      const ok = await submitPublicInquiry(
        {
          name: 'Alex',
          email: `alex${i}@example.com`,
          message: 'Hello from a real person with enough text.',
        },
        '198.51.100.9',
        e,
      );
      assert.equal(ok.ok, true, `expected success on attempt ${i + 1}`);
    }
    const blocked = await submitPublicInquiry(
      {
        name: 'Alex',
        email: 'alex5@example.com',
        message: 'One more note that should be rate limited.',
      },
      '198.51.100.9',
      e,
    );
    assert.equal(blocked.ok, false);
    assert.equal(blocked.status, 429);
  });
});
