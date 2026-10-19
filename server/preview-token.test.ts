import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createSignedPreviewToken,
  hashBody,
  PREVIEW_TTL_MS,
  previewMatchesComposition,
  verifySignedPreviewToken,
} from './preview-token.ts';

const env = { SESSION_SECRET: 'test-session-secret-for-preview-hmac' };

describe('HMAC preview tokens', () => {
  it('signs and verifies within 2h', () => {
    const now = Date.now();
    const token = createSignedPreviewToken([3, 21], 'Subj', 'Body {{website_observation}}', env, now);
    const session = verifySignedPreviewToken(token, env, now + 60_000);
    assert.ok(session);
    assert.deepEqual(session!.recipient_ids, ['21', '3']);
    assert.equal(session!.subject, 'Subj');
    assert.equal(session!.body_hash, hashBody('Body {{website_observation}}'));
    assert.equal(
      previewMatchesComposition(session!, [21, 3], 'Subj', 'Body {{website_observation}}'),
      true,
    );
  });

  it('rejects tampered tokens and expired tokens', () => {
    const now = Date.now();
    const token = createSignedPreviewToken([1], 'S', 'B', env, now);
    assert.equal(verifySignedPreviewToken(`${token}x`, env, now), null);
    assert.equal(verifySignedPreviewToken(token, env, now + PREVIEW_TTL_MS + 1), null);
    assert.equal(verifySignedPreviewToken(token, { SESSION_SECRET: 'other' }, now), null);
  });

  it('requires SESSION_SECRET to create', () => {
    assert.throws(() => createSignedPreviewToken([1], 'S', 'B', {}), /SESSION_SECRET/);
  });
});
