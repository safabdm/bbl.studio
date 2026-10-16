import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import handler, {
  processResendWebhook,
  rememberEventId,
  verifyResendSignature,
  webhookSecretBytes,
} from '../api/resend-webhook.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';

const dir = mkdtempSync(join(tmpdir(), 'bbls-resend-'));
const secret = `whsec_${Buffer.from('test-resend-webhook-secret').toString('base64')}`;
const env = {
  RESEND_WEBHOOK_SECRET: secret,
  RESEND_WEBHOOK_IDEMPOTENCY_PATH: join(dir, 'events.json'),
};

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function sign(body: string, id: string, timestamp: string) {
  const expected = createHmac('sha256', webhookSecretBytes(secret))
    .update(`${id}.${timestamp}.${body}`)
    .digest('base64');
  return `v1,${expected}`;
}

describe('Resend webhook signature', () => {
  it('accepts a valid Svix signature', () => {
    const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 'msg_1' } });
    const id = 'msg_evt_1';
    const timestamp = String(Math.floor(Date.now() / 1000));
    assert.equal(
      verifyResendSignature({
        body,
        svixId: id,
        svixTimestamp: timestamp,
        svixSignature: sign(body, id, timestamp),
        secret,
      }),
      true,
    );
  });

  it('rejects tampered bodies', () => {
    const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 'msg_1' } });
    const id = 'msg_evt_2';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(body, id, timestamp);
    assert.equal(
      verifyResendSignature({
        body: body.replace('delivered', 'bounced'),
        svixId: id,
        svixTimestamp: timestamp,
        svixSignature: signature,
        secret,
      }),
      false,
    );
  });
});

describe('Resend webhook processing', () => {
  it('is idempotent for repeated event ids', async () => {
    const body = JSON.stringify({
      type: 'email.delivered',
      data: { email_id: 'msg_abc' },
      created_at: '2026-10-15T00:00:00.000Z',
    });
    const id = 'svix_idem_1';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers = {
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': sign(body, id, timestamp),
    };
    const first = await processResendWebhook({ body, headers, env });
    assert.equal(first.ok, true);
    assert.equal(first.duplicate, false);
    assert.equal(first.stored, true);

    const second = await processResendWebhook({ body, headers, env });
    assert.equal(second.ok, true);
    assert.equal(second.duplicate, true);
  });

  it('forwards to lead agent when URL is configured', async () => {
    const body = JSON.stringify({ type: 'email.bounced', data: { email_id: 'msg_fwd' } });
    const id = 'svix_fwd_1';
    const timestamp = String(Math.floor(Date.now() / 1000));
    let forwardedBody = '';
    const result = await processResendWebhook({
      body,
      headers: {
        'svix-id': id,
        'svix-timestamp': timestamp,
        'svix-signature': sign(body, id, timestamp),
      },
      env: {
        ...env,
        LEAD_AGENT_RESEND_WEBHOOK_URL: 'https://leads.example/integrations/resend-webhook',
        RESEND_WEBHOOK_IDEMPOTENCY_PATH: join(dir, 'events-fwd.json'),
      },
      fetchImpl: (async (_url, init) => {
        forwardedBody = String(init?.body || '');
        return new Response('{"ok":true}', { status: 200 });
      }) as typeof fetch,
    });
    assert.equal(result.ok, true);
    assert.equal(result.forwarded, true);
    assert.equal(forwardedBody, body);
  });
});

describe('idempotency helper', () => {
  it('remembers event ids once', () => {
    const pathEnv = { RESEND_WEBHOOK_IDEMPOTENCY_PATH: join(dir, 'helper.json') };
    assert.equal(rememberEventId('once', pathEnv), true);
    assert.equal(rememberEventId('once', pathEnv), false);
  });
});

describe('Vercel default handler', () => {
  it('exports a default POST entry that rejects GET with 405', async () => {
    assert.equal(typeof handler, 'function');
    let status = 0;
    let body = '';
    const req = { method: 'GET', headers: {}, on() { return req; } } as unknown as IncomingMessage;
    const res = {
      setHeader() {},
      end(payload: string) {
        body = payload;
      },
      set statusCode(value: number) {
        status = value;
      },
      get statusCode() {
        return status;
      },
    } as unknown as ServerResponse;
    await handler(req, res);
    assert.equal(status, 405);
    assert.match(body, /Use POST/);
  });
});
