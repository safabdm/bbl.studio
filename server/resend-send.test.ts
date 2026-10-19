import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSignedPreviewToken } from './preview-token.ts';
import {
  DEFAULT_BATCH_CAP,
  executeApprovedManualSend,
  sendViaResend,
  wasContactedWithinWindow,
} from './resend-send.ts';
import type { CrmLead } from './crm-types.ts';

const sessionEnv = {
  SESSION_SECRET: 'test-session-secret-for-preview-hmac',
  UNSUBSCRIBE_SECRET: 'test-unsub',
  APP_ORIGIN: 'https://www.bbl.studio',
  BUSINESS_POSTAL_ADDRESS: '1 Test St, Irvine, CA 92618',
  EMAIL_OUTREACH_ENABLED: 'false',
  EMAIL_DRY_RUN: 'true',
  MANUAL_SEND_LIVE_ENABLED: 'false',
};

const body = [
  'Hi {{contact_name}},',
  '',
  'I noticed {{website_observation}}.',
  '',
  'Book: https://www.bbl.studio/book',
  '',
  '{{BUSINESS_POSTAL_ADDRESS}}',
  '{{signed_unsubscribe_url}}',
].join('\n');

const leads: CrmLead[] = [
  {
    id: 3,
    business_name: 'House of Lange',
    contact_name: 'Team',
    email: 'team@houseoflange.com',
    website_observation: 'no clear online booking path',
    email_accepted: 'UNKNOWN',
    delivered: 'UNKNOWN',
    bounced: 'UNKNOWN',
    replied: 'UNKNOWN',
    booked: 'NO',
  },
  {
    id: 21,
    business_name: 'Shadows',
    email: 'info@shadowssalon.com',
    website_observation: 'outdated homepage banner',
    email_accepted: 'UNKNOWN',
    delivered: 'UNKNOWN',
    bounced: 'UNKNOWN',
    replied: 'UNKNOWN',
    booked: 'NO',
  },
];

describe('resend-send gates', () => {
  it('dry-runs without calling fetch', async () => {
    let fetchCalls = 0;
    const subject = 'Idea for {{business_name}}';
    const token = createSignedPreviewToken([3, 21], subject, body, sessionEnv);
    const result = await executeApprovedManualSend(
      {
        campaign_name: 'Test',
        subject,
        body,
        recipient_ids: [3, 21],
        preview_token: token,
        confirmed: true,
        confirm_live: true,
      },
      leads,
      sessionEnv,
      {
        fetchImpl: (async () => {
          fetchCalls += 1;
          return new Response('{}', { status: 200 });
        }) as typeof fetch,
        serverLeads: leads,
        serverHistory: [],
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.dry_run, true);
    assert.equal(result.live, false);
    assert.equal(fetchCalls, 0);
    assert.equal(result.recipient_count, 2);
  });

  it('live send uses mock fetch only and server leads', async () => {
    const liveEnv = {
      ...sessionEnv,
      EMAIL_DRY_RUN: 'false',
      MANUAL_SEND_LIVE_ENABLED: 'true',
      RESEND_API_KEY: 're_test_key',
      MANUAL_SEND_BATCH_CAP: '10',
    };
    const subject = 'Idea for {{business_name}}';
    const token = createSignedPreviewToken([3], subject, body, liveEnv);
    const calls: string[] = [];
    const result = await executeApprovedManualSend(
      {
        campaign_name: 'Live',
        subject,
        body,
        recipient_ids: [3],
        preview_token: token,
        confirmed: true,
        confirm_live: true,
      },
      [], // client leads empty — must use serverLeads
      liveEnv,
      {
        serverLeads: leads,
        serverHistory: [],
        fetchImpl: (async (_url, init) => {
          calls.push(String(init?.body || ''));
          return new Response(JSON.stringify({ id: 'msg_mock_1' }), { status: 200 });
        }) as typeof fetch,
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.live, true);
    assert.equal(result.dry_run, false);
    assert.equal(calls.length, 1);
    assert.match(calls[0]!, /team@houseoflange\.com/);
    assert.doesNotMatch(calls[0]!, /\$3,?000/);
    assert.equal(result.sent_ids?.[0], 'msg_mock_1');
  });

  it('enforces 30d dedupe and batch cap', async () => {
    const now = Date.now();
    assert.equal(
      wasContactedWithinWindow(
        'team@houseoflange.com',
        [
          {
            email: 'team@houseoflange.com',
            accepted: 'YES',
            delivered: 'UNKNOWN',
            bounced: 'UNKNOWN',
            replied: 'UNKNOWN',
            dry_run: false,
            status: 'SENT',
            sent_at: new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString(),
          },
        ],
        now,
      ),
      true,
    );
    assert.equal(DEFAULT_BATCH_CAP, 10);

    const liveEnv = {
      ...sessionEnv,
      EMAIL_DRY_RUN: 'false',
      MANUAL_SEND_LIVE_ENABLED: 'true',
      RESEND_API_KEY: 're_test',
      MANUAL_SEND_BATCH_CAP: '1',
    };
    const subject = 'Idea for {{business_name}}';
    const token = createSignedPreviewToken([3, 21], subject, body, liveEnv);
    let fetchCalls = 0;
    const result = await executeApprovedManualSend(
      {
        campaign_name: 'Cap',
        subject,
        body,
        recipient_ids: [3, 21],
        preview_token: token,
        confirmed: true,
        confirm_live: true,
      },
      leads,
      liveEnv,
      {
        serverLeads: leads,
        serverHistory: [],
        fetchImpl: (async () => {
          fetchCalls += 1;
          return new Response(JSON.stringify({ id: `msg_${fetchCalls}` }), { status: 200 });
        }) as typeof fetch,
      },
    );
    assert.equal(fetchCalls, 1);
    assert.equal(result.recipient_count, 1);
    assert.equal(result.excluded.some((e) => e.reason === 'batch_cap'), true);
  });

  it('sendViaResend mocks fetch and never hits network without mock', async () => {
    const result = await sendViaResend(
      { to: 'a@b.com', subject: 'S', text: 'T' },
      { RESEND_API_KEY: 're_x', RESEND_FROM: 'BBL Studio <hello@bbl.studio>' },
      (async () => new Response(JSON.stringify({ id: 'abc' }), { status: 200 })) as typeof fetch,
    );
    assert.equal(result.ok, true);
    assert.equal(result.id, 'abc');
  });
});
