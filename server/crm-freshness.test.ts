import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  mergeLeadFreshness,
  mergeMacLeadsIntoExisting,
  shouldAcceptIncoming,
  trackingRankFromStatus,
  type CrmLeadWithMeta,
} from './crm-freshness.ts';

const baseLead = (over: Partial<CrmLeadWithMeta> = {}): CrmLeadWithMeta => ({
  id: 42,
  business_name: 'Hair NB',
  email: 'sandra@hairnewportbeach.com',
  email_accepted: 'YES',
  delivered: 'UNKNOWN',
  bounced: 'UNKNOWN',
  replied: 'UNKNOWN',
  booked: 'NO',
  provider_message_ids: ['msg_cohort_42'],
  ...over,
});

describe('tracking ranks', () => {
  it('orders statuses so delivery outranks accepted', () => {
    assert.ok(trackingRankFromStatus('DELIVERED') > trackingRankFromStatus('ACCEPTED'));
    assert.ok(trackingRankFromStatus('BOUNCED') > trackingRankFromStatus('SENT'));
    assert.equal(trackingRankFromStatus('UNKNOWN'), 0);
  });

  it('prefers webhook over mac on equal rank', () => {
    assert.equal(
      shouldAcceptIncoming(
        { source: 'mac', rank: 3, at: '2026-10-01T00:00:00Z' },
        { source: 'webhook', rank: 3, at: '2026-09-01T00:00:00Z' },
      ),
      true,
    );
    assert.equal(
      shouldAcceptIncoming(
        { source: 'webhook', rank: 3, at: '2026-10-01T00:00:00Z' },
        { source: 'mac', rank: 3, at: '2026-11-01T00:00:00Z' },
      ),
      false,
    );
  });
});

describe('webhook vs older Mac sync', () => {
  it('does not let older Mac UNKNOWN/NO clobber webhook DELIVERED', () => {
    const afterWebhook = mergeLeadFreshness(
      baseLead(),
      baseLead({ delivered: 'YES', email_status: 'DELIVERED' }),
      'webhook',
      '2026-10-10T12:00:00Z',
      'email.delivered',
    );
    assert.equal(afterWebhook.delivered, 'YES');
    assert.equal(afterWebhook.tracking?.delivered?.source, 'webhook');

    const afterOlderMac = mergeLeadFreshness(
      afterWebhook,
      baseLead({
        delivered: 'UNKNOWN',
        email_status: 'SENT',
        email_accepted: 'YES',
        business_name: 'Hair Newport Beach',
      }),
      'mac',
      '2026-10-01T00:00:00Z',
    );
    assert.equal(afterOlderMac.delivered, 'YES');
    assert.equal(afterOlderMac.email_status, 'DELIVERED');
    assert.equal(afterOlderMac.business_name, 'Hair Newport Beach');
    assert.equal(afterOlderMac.tracking?.delivered?.source, 'webhook');
  });

  it('mergeMacLeadsIntoExisting preserves webhook replied/bounced', () => {
    const existing = [
      mergeLeadFreshness(
        baseLead({ id: 1, email: 'a@example.com' }),
        baseLead({ id: 1, email: 'a@example.com', replied: 'YES', email_status: 'REPLIED' }),
        'webhook',
        '2026-10-12T00:00:00Z',
        'email.received',
      ),
    ];
    const macPush = [
      baseLead({
        id: 1,
        email: 'a@example.com',
        replied: 'UNKNOWN',
        delivered: 'UNKNOWN',
        email_status: 'SENT',
        business_name: 'Updated Name',
      }),
    ];
    const merged = mergeMacLeadsIntoExisting(existing, macPush, '2026-10-13T00:00:00Z');
    assert.equal(merged[0].replied, 'YES');
    assert.equal(merged[0].business_name, 'Updated Name');
  });
});
