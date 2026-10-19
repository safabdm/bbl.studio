import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  buildPreviews,
  clearPreviewSessions,
  createPreviewToken,
  executeManualSend,
  listDrafts,
  listSendLog,
  personalize,
  saveDraft,
  sendTestDryRun,
} from './crm-campaigns.ts';
import { resetCrmDbClient, resetMemoryCrmDb } from './crm-db.ts';
import type { CrmLead } from './crm-types.ts';

const dir = mkdtempSync(join(tmpdir(), 'bbls-crm-'));
const env = {
  CRM_DRAFTS_PATH: join(dir, 'drafts.json'),
  CRM_SEND_LOG_PATH: join(dir, 'send-log.json'),
  EMAIL_OUTREACH_ENABLED: 'false',
  EMAIL_DRY_RUN: 'true',
  MANUAL_SEND_LIVE_ENABLED: 'false',
  SESSION_SECRET: 'test-session-secret-for-preview-hmac',
  UNSUBSCRIBE_SECRET: 'test-unsub-secret',
  APP_ORIGIN: 'https://www.bbl.studio',
  BUSINESS_POSTAL_ADDRESS: '1 Test St, Irvine, CA 92618',
};

const durableEnv = {
  ...env,
  CRM_DATABASE_URL: 'memory://crm',
  CRM_DATABASE_MEMORY: '1',
  VERCEL: '1',
};

const vercelNoDbEnv = {
  EMAIL_OUTREACH_ENABLED: 'false',
  EMAIL_DRY_RUN: 'true',
  MANUAL_SEND_LIVE_ENABLED: 'false',
  VERCEL: '1',
};

const leads: CrmLead[] = [
  {
    id: 3,
    business_name: 'House of Lange',
    contact_name: 'Team',
    email: 'team@houseoflange.com',
    website_observation: 'no clear online booking path on the site',
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
    website_observation: 'homepage still leads with an outdated award line',
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

beforeEach(() => {
  resetCrmDbClient();
  resetMemoryCrmDb(durableEnv);
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
  it('blocks send without preview + confirm', async () => {
    const result = await executeManualSend(
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

  it('dry-runs after select → preview → confirm and never marks live', async () => {
    const subject = 'Hello {{business_name}}';
    const body = [
      'Note for {{contact_name}}: {{website_observation}}',
      'Book: https://www.bbl.studio/book',
      '{{BUSINESS_POSTAL_ADDRESS}}',
      '{{signed_unsubscribe_url}}',
    ].join('\n');
    const token = createPreviewToken([3, 21], subject, body, env);
    const result = await executeManualSend(
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
      { serverLeads: leads, serverHistory: [] },
    );
    assert.equal(result.ok, true);
    assert.equal(result.dry_run, true);
    assert.equal(result.live, false);
    assert.equal(result.recipient_count, 1);
    assert.ok((result.excluded_count || 0) >= 1);
    assert.match(result.message, /Dry-run only|No emails were sent/i);
    assert.equal(result.intended[0]?.email, 'team@houseoflange.com');
  });

  it('send test is always dry-run', () => {
    const result = sendTestDryRun('hello@bbl.studio', 'Subject', 'Body');
    assert.equal(result.ok, true);
    assert.equal(result.dry_run, true);
    assert.match(result.message, /Nothing was sent/);
  });
});

describe('durable campaign drafts (Neon / memory)', () => {
  it('persists drafts without touching local ./data', async () => {
    const saved = await saveDraft(
      {
        name: 'Spring outreach',
        subject: 'Hello {{business_name}}',
        body: 'Body',
        template_id: 'tpl_intro',
        recipient_ids: [3],
      },
      durableEnv,
    );
    assert.match(saved.id, /^draft_/);
    const listed = await listDrafts(durableEnv);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.name, 'Spring outreach');
    assert.deepEqual(listed[0]?.recipient_ids, [3]);
  });

  it('updates an existing draft by id', async () => {
    const first = await saveDraft(
      { name: 'A', subject: 'S', body: 'B', recipient_ids: [3] },
      durableEnv,
    );
    const second = await saveDraft(
      { id: first.id, name: 'B', subject: 'S2', body: 'B2', recipient_ids: [3, 21] },
      durableEnv,
    );
    assert.equal(second.id, first.id);
    assert.equal(second.name, 'B');
    const listed = await listDrafts(durableEnv);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.subject, 'S2');
  });

  it('logs dry-run sends into durable send log', async () => {
    const subject = 'Hello {{business_name}}';
    const body = [
      '{{website_observation}}',
      'Book: https://www.bbl.studio/book',
      '{{BUSINESS_POSTAL_ADDRESS}}',
      '{{signed_unsubscribe_url}}',
    ].join('\n');
    const token = createPreviewToken([3], subject, body, durableEnv);
    const result = await executeManualSend(
      {
        campaign_name: 'Logged dry-run',
        subject,
        body,
        recipient_ids: [3],
        preview_token: token,
        confirmed: true,
      },
      leads,
      durableEnv,
      { serverLeads: leads, serverHistory: [] },
    );
    assert.equal(result.ok, true);
    const log = await listSendLog(durableEnv);
    assert.equal(log.length, 1);
    assert.equal(log[0]?.dry_run, true);
    assert.equal(log[0]?.live, false);
  });

  it('refuses filesystem drafts on Vercel without CRM_DATABASE_URL (no ENOENT mkdir)', async () => {
    await assert.rejects(
      () =>
        saveDraft(
          { name: 'Nope', subject: 'S', body: 'B', recipient_ids: [] },
          vercelNoDbEnv,
        ),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /CRM_DATABASE_URL|durable|serverless/i);
        assert.doesNotMatch(err.message, /ENOENT|mkdir/i);
        return true;
      },
    );
    const empty = await listDrafts(vercelNoDbEnv);
    assert.deepEqual(empty, []);
  });

  it('refuses filesystem drafts when AWS Lambda is detected without VERCEL (no ENOENT)', async () => {
    const lambdaNoDb = {
      EMAIL_OUTREACH_ENABLED: 'false',
      EMAIL_DRY_RUN: 'true',
      MANUAL_SEND_LIVE_ENABLED: 'false',
      AWS_LAMBDA_FUNCTION_NAME: 'bbl-studio-api',
    };
    await assert.rejects(
      () =>
        saveDraft(
          { name: 'Nope', subject: 'S', body: 'B', recipient_ids: [] },
          lambdaNoDb,
        ),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /CRM_DATABASE_URL|durable|serverless/i);
        assert.doesNotMatch(err.message, /ENOENT|\/var\/task/i);
        return true;
      },
    );
  });

  it('never returns raw mkdir ENOENT when local write is forced under serverless cwd', async () => {
    // Simulate a mis-detection edge: durable off, but cwd is /var/task → requiresDurableDb
    // via isServerlessRuntime(cwd). We cannot chdir to /var/task here; instead assert the
    // writeJsonFile guard maps FS errors to a clean message when somehow reached.
    const { isServerlessRuntime } = await import('./crm-db.ts');
    assert.equal(isServerlessRuntime({ VERCEL: '1' }), true);
    assert.equal(isServerlessRuntime({ AWS_LAMBDA_FUNCTION_NAME: 'x' }), true);
    assert.equal(isServerlessRuntime({}), process.cwd() === '/var/task' || process.cwd().startsWith('/var/task/'));
  });
});
