import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  buildPreviews,
  clearPreviewSessions,
  createPreviewToken,
  executeManualSend,
  personalize,
  sendTestDryRun,
} from './crm-campaigns.ts';
import type { CrmLead } from './crm-types.ts';

const dir = mkdtempSync(join(tmpdir(), 'bbls-crm-'));
const env = {
  CRM_DRAFTS_PATH: join(dir, 'drafts.json'),
  CRM_SEND_LOG_PATH: join(dir, 'send-log.json'),
  EMAIL_OUTREACH_ENABLED: 'false',
  EMAIL_DRY_RUN: 'true',
  MANUAL_SEND_LIVE_ENABLED: 'false',
};

const leads: CrmLead[] = [
  {
    id: 3,
    business_name: 'House of Lange',
    contact_name: 'Team',
    email: 'team@houseoflange.com',
    email_accepted: 'YES',
    delivered: 'UNKNOWN',
    bounced: 'UNKNOWN',
    replied: 'UNKNOWN',
    booked: 'NO',
  },
  {
    id: 21,
    business_name: 'Shadows Salon',
    contact_name: 'Info',
    email: 'info@shadowssalon.com',
    unsubscribed: true,
    email_accepted: 'UNKNOWN',
    delivered: 'UNKNOWN',
    bounced: 'UNKNOWN',
    replied: 'UNKNOWN',
    booked: 'NO',
  },
];

before(() => {
  clearPreviewSessions();
});

after(() => {
  clearPreviewSessions();
  rmSync(dir, { recursive: true, force: true });
});

describe('personalization + preview', () => {
  it('fills placeholders', () => {
    const text = personalize('Hi {{contact_name}} at {{business_name}}', leads[0]!);
    assert.equal(text, 'Hi Team at House of Lange');
  });

  it('builds per-recipient previews', () => {
    const previews = buildPreviews(leads, [3], 'Hello {{business_name}}', 'Body for {{email}}');
    assert.equal(previews.length, 1);
    assert.equal(previews[0]?.subject, 'Hello House of Lange');
    assert.equal(previews[0]?.body, 'Body for team@houseoflange.com');
  });
});

describe('dry-run send path', () => {
  it('blocks send without preview + confirm', () => {
    const result = executeManualSend(
      {
        campaign_name: 'Test',
        subject: 'Hi',
        body: 'Body',
        recipient_ids: [3],
        preview_token: 'missing',
        confirmed: true,
      },
      leads,
      env,
    );
    assert.equal(result.ok, false);
    assert.equal(result.dry_run, true);
    assert.equal(result.live, false);
  });

  it('dry-runs after select → preview → confirm and never marks live', () => {
    const subject = 'Hello {{business_name}}';
    const body = 'Note for {{contact_name}}';
    const token = createPreviewToken([3, 21], subject, body);
    const result = executeManualSend(
      {
        campaign_name: 'Dry run campaign',
        subject,
        body,
        recipient_ids: [3, 21],
        preview_token: token,
        confirmed: true,
        confirm_live: true,
      },
      leads,
      env,
    );
    assert.equal(result.ok, true);
    assert.equal(result.dry_run, true);
    assert.equal(result.live, false);
    assert.equal(result.recipient_count, 1);
    assert.equal(result.excluded_count, 1);
    assert.match(result.message, /Dry-run only|No emails were sent/i);
    assert.equal(result.intended[0]?.email, 'team@houseoflange.com');
  });

  it('send test is always dry-run', () => {
    const result = sendTestDryRun('admin@bbls.studio', 'Subject', 'Body');
    assert.equal(result.ok, true);
    assert.equal(result.dry_run, true);
    assert.match(result.message, /Nothing was sent/);
  });
});
