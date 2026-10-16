import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  clearSelection,
  filterSendableRecipients,
  isDryRun,
  isManualLiveSendEnabled,
  isOutreachEnabled,
  maySendLive,
  selectAllIds,
  selectedCount,
  toggleSelection,
  validateManualSendGate,
} from './crm-safety.ts';

describe('CRM safety flags', () => {
  it('keeps outreach off and dry-run on by default', () => {
    assert.equal(isOutreachEnabled({}), false);
    assert.equal(isDryRun({}), true);
    assert.equal(isManualLiveSendEnabled({}), false);
    assert.equal(maySendLive({ confirm_live: true }, {}), false);
  });

  it('only allows live when dry-run is false, manual flag is on, and confirm_live', () => {
    const env = {
      EMAIL_DRY_RUN: 'false',
      MANUAL_SEND_LIVE_ENABLED: 'true',
    };
    assert.equal(maySendLive({ confirm_live: false }, env), false);
    assert.equal(maySendLive({ confirm_live: true }, env), true);
    assert.equal(maySendLive({ confirm_live: true }, { ...env, EMAIL_DRY_RUN: 'true' }), false);
  });
});

describe('lead selection', () => {
  it('toggles, counts, selects all, and clears', () => {
    let selected = toggleSelection([], 3);
    selected = toggleSelection(selected, '21');
    assert.deepEqual(selected.sort(), ['21', '3']);
    assert.equal(selectedCount(selected), 2);
    selected = toggleSelection(selected, 3);
    assert.deepEqual(selected, ['21']);
    assert.deepEqual(selectAllIds([1, '1', 2]), ['1', '2']);
    assert.deepEqual(clearSelection(), []);
  });

  it('excludes unsubscribed, suppressed, and bounced leads', () => {
    const { included, excluded } = filterSendableRecipients(
      [
        { id: 1, email: 'a@example.com' },
        { id: 2, email: 'b@example.com', unsubscribed: true },
        { id: 3, email: 'c@example.com', suppressed: true },
        { id: 4, email: 'd@example.com', bounced: 'YES' },
        { id: 5, email: 'e@example.com', email_status: 'COMPLAINED' },
      ],
      [1, 2, 3, 4, 5],
    );
    assert.equal(included.length, 1);
    assert.equal(included[0]?.id, 1);
    assert.equal(excluded.length, 4);
  });

  it('excludes NOT CONTACTABLE / missing-email leads from outreach', () => {
    const { included, excluded } = filterSendableRecipients(
      [
        { id: 1, email: 'a@example.com', contactable: true },
        { id: 2, email: '', contactable: false, email_status: 'NOT CONTACTABLE' },
        { id: 3, email: '', email_status: 'NOT CONTACTABLE' },
        { id: 4, email: 'nope' },
      ],
      [1, 2, 3, 4],
    );
    assert.equal(included.length, 1);
    assert.equal(included[0]?.id, 1);
    assert.equal(excluded.some((e) => e.reason === 'not_contactable'), true);
    assert.equal(excluded.some((e) => e.reason === 'invalid_email'), true);
  });
});

describe('manual send confirm gate', () => {
  it('requires recipients, preview token, and confirm', () => {
    assert.equal(validateManualSendGate({ recipient_ids: [] }).ok, false);
    assert.equal(
      validateManualSendGate({
        recipient_ids: [1],
        preview_token: 'abc',
        expected_preview_token: 'abc',
        confirmed: false,
      }).ok,
      false,
    );
    assert.equal(
      validateManualSendGate({
        recipient_ids: [1],
        preview_token: 'abc',
        expected_preview_token: 'xyz',
        confirmed: true,
      }).ok,
      false,
    );
    assert.equal(
      validateManualSendGate({
        recipient_ids: [1],
        preview_token: 'abc',
        expected_preview_token: 'abc',
        confirmed: true,
      }).ok,
      true,
    );
  });
});
