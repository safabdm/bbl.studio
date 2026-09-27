import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  isEmailSuppressed,
  makeUnsubscribeToken,
  processUnsubscribe,
  verifyUnsubscribeToken,
} from './unsubscribe.ts';

const SECRET = 'test-unsubscribe-secret-do-not-use-in-prod-0123456789abcdef';
const priorSecret = process.env.UNSUBSCRIBE_SECRET;
const dir = mkdtempSync(join(tmpdir(), 'bbls-unsub-'));
const storePath = join(dir, 'email-suppressions.json');

before(() => {
  process.env.UNSUBSCRIBE_SECRET = SECRET;
});

after(() => {
  if (priorSecret === undefined) delete process.env.UNSUBSCRIBE_SECRET;
  else process.env.UNSUBSCRIBE_SECRET = priorSecret;
  rmSync(dir, { recursive: true, force: true });
});

describe('signed unsubscribe tokens', () => {
  it('validates matching HMAC tokens', () => {
    const email = 'Owner@Salon.Example';
    const leadId = 42;
    const token = makeUnsubscribeToken(email, leadId, SECRET);
    assert.equal(token.length, 32);
    assert.equal(verifyUnsubscribeToken(email, leadId, token, SECRET), true);
    assert.equal(verifyUnsubscribeToken(email.toLowerCase(), leadId, token, SECRET), true);
  });

  it('rejects tampered email, lead_id, or token', () => {
    const email = 'team@example.com';
    const leadId = 7;
    const token = makeUnsubscribeToken(email, leadId, SECRET);
    assert.equal(verifyUnsubscribeToken('other@example.com', leadId, token, SECRET), false);
    assert.equal(verifyUnsubscribeToken(email, 8, token, SECRET), false);
    assert.equal(verifyUnsubscribeToken(email, leadId, `${token.slice(0, 31)}0`, SECRET), false);
    assert.equal(verifyUnsubscribeToken(email, leadId, 'short', SECRET), false);
  });

  it('matches the agent Python HMAC scheme', async () => {
    // Mirror: hmac.new(secret, f"{lead_id}:{email.lower()}".encode(), sha256).hexdigest()[:32]
    const { createHmac } = await import('node:crypto');
    const email = 'hello@bbl.studio';
    const leadId = 104;
    const expected = createHmac('sha256', SECRET)
      .update(`${leadId}:${email}`)
      .digest('hex')
      .slice(0, 32);
    assert.equal(makeUnsubscribeToken(email, leadId, SECRET), expected);
  });
});

describe('unsubscribe processing', () => {
  it('records a valid unsubscribe', () => {
    const email = 'first@example.com';
    const leadId = 11;
    const token = makeUnsubscribeToken(email, leadId, SECRET);
    const result = processUnsubscribe({ email, lead_id: leadId, token }, storePath);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.already, false);
    assert.equal(result.email, email);
    assert.equal(isEmailSuppressed(email, storePath), true);
  });

  it('is idempotent on repeated unsubscribe', () => {
    const email = 'repeat@example.com';
    const leadId = 12;
    const token = makeUnsubscribeToken(email, leadId, SECRET);
    const first = processUnsubscribe({ email, lead_id: String(leadId), token }, storePath);
    const second = processUnsubscribe({ email, lead_id: leadId, token }, storePath);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.equal(first.already, false);
    assert.equal(second.already, true);
  });

  it('rejects invalid tokens without recording', () => {
    const email = 'nope@example.com';
    const result = processUnsubscribe(
      {
        email,
        lead_id: 99,
        token: makeUnsubscribeToken(email, 98, SECRET),
      },
      storePath,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, 'invalid_token');
    assert.equal(isEmailSuppressed(email, storePath), false);
  });

  it('rejects missing params', () => {
    const result = processUnsubscribe({ email: '', lead_id: '', token: '' }, storePath);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, 'missing_params');
  });
});
