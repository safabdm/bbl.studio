import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { authorizeCrmSync, ingestCrmSync, parseSyncPayload } from './crm-sync-ingest.ts';
import {
  connectionStatus,
  hasSuccessfulSync,
  readSnapshot,
  resetSnapshotCache,
} from './crm-sync-store.ts';
import { fetchLeads, fetchOverview } from './crm-lead-client.ts';
import { applyResendEventToSnapshot, mapResendEventType } from './crm-webhook-apply.ts';
import { handleCrmOverview, handleCrmSyncIngest } from './crm-api.ts';
import { resetCrmDbClient, resetMemoryCrmDb } from './crm-db.ts';
import { processResendWebhook, webhookSecretBytes } from '../api/resend-webhook.ts';
import { createHmac } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'bbls-crm-sync-'));
const storePath = join(dir, 'snapshot.json');
const secret = 'test-crm-sync-secret-value';
const whsec = `whsec_${Buffer.from('test-resend-webhook-secret').toString('base64')}`;

function env(extra: Record<string, string> = {}) {
  return {
    CRM_SYNC_SECRET: secret,
    CRM_SYNC_STORE_PATH: storePath,
    CRM_SYNC_STALE_HOURS: '48',
    EMAIL_OUTREACH_ENABLED: 'false',
    EMAIL_DRY_RUN: 'true',
    MANUAL_SEND_LIVE_ENABLED: 'false',
    ...extra,
  };
}

function durableEnv(extra: Record<string, string> = {}) {
  return env({
    CRM_DATABASE_URL: 'memory://crm',
    CRM_DATABASE_MEMORY: '1',
    ...extra,
  });
}

beforeEach(() => {
  resetSnapshotCache();
  resetCrmDbClient();
  resetMemoryCrmDb(durableEnv());
  try {
    rmSync(storePath, { force: true });
  } catch {
    // ignore
  }
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('CRM sync auth', () => {
  it('rejects missing secret config', () => {
    const result = authorizeCrmSync({ authorization: 'Bearer x' }, { CRM_SYNC_STORE_PATH: storePath });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 503);
  });

  it('rejects bad bearer', () => {
    const result = authorizeCrmSync({ authorization: 'Bearer wrong' }, env());
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 401);
  });

  it('accepts bearer and header key', () => {
    assert.equal(authorizeCrmSync({ authorization: `Bearer ${secret}` }, env()).ok, true);
    assert.equal(authorizeCrmSync({ 'x-bbl-crm-sync-key': secret }, env()).ok, true);
  });
});

describe('CRM connection empty states', () => {
  it('reports not_connected without secret or snapshot', async () => {
    const e = { CRM_SYNC_STORE_PATH: storePath };
    const conn = await connectionStatus(e);
    assert.equal(conn.status, 'not_connected');
    const overview = await fetchOverview(e);
    assert.equal(overview.metrics_trusted, false);
    assert.equal(overview.data, null);
    const leads = await fetchLeads('', e);
    assert.equal(leads.data.length, 0);
    assert.equal(leads.connection, 'not_connected');
  });

  it('reports sync_pending when secret set but no push yet', async () => {
    const conn = await connectionStatus(env());
    assert.equal(conn.status, 'sync_pending');
    const overview = await handleCrmOverview(true, env());
    assert.equal(overview.status, 200);
    assert.equal(overview.body.metrics, null);
    assert.equal(overview.body.metrics_trusted, false);
    assert.equal(overview.body.connection, 'sync_pending');
  });

  it('shows real zeros only after successful sync', async () => {
    const result = await ingestCrmSync(
      {
        schema_version: 1,
        leads: [],
        email_history: [],
        campaigns: [],
      },
      { env: env() },
    );
    assert.equal(result.ok, true);
    assert.equal(await hasSuccessfulSync(env()), true);
    const overview = await fetchOverview(env());
    assert.equal(overview.metrics_trusted, true);
    assert.equal(overview.data?.total_leads, 0);
    assert.equal(overview.connection, 'synced');
  });

  it('requires durable DB on Vercel (no /tmp fallback)', async () => {
    const result = await ingestCrmSync(
      { leads: [] },
      { env: env({ VERCEL: '1' }) },
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 503);
      assert.match(result.message, /CRM_DATABASE_URL/);
    }
  });
});

describe('CRM sync ingest', () => {
  it('requires leads array', () => {
    const parsed = parseSyncPayload({ email_history: [] });
    assert.equal(parsed.ok, false);
  });

  it('stores leads + 9 email history rows with Resend ids', async () => {
    const history = Array.from({ length: 9 }, (_, i) => ({
      lead_id: i + 1,
      email: `salon${i}@example.com`,
      business_name: `Salon ${i}`,
      provider_message_id: `re_${i}`,
      status: 'SENT',
      dry_run: false,
      accepted: 'YES',
      delivered: 'UNKNOWN',
      bounced: 'UNKNOWN',
      replied: 'UNKNOWN',
      sent_at: '2026-09-01T12:00:00Z',
    }));
    const leads = history.map((h, i) => ({
      id: i + 1,
      business_name: h.business_name,
      email: h.email,
      email_accepted: 'UNKNOWN',
      delivered: 'UNKNOWN',
      bounced: 'UNKNOWN',
      replied: 'UNKNOWN',
      booked: 'UNKNOWN',
    }));
    const result = await ingestCrmSync(
      { schema_version: 1, leads, email_history: history, source_host: 'test-mac' },
      { env: env() },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.counts.leads, 9);
    assert.equal(result.counts.email_history, 9);
    const snap = await readSnapshot(env());
    assert.equal(snap?.leads[0]?.email_accepted, 'YES');
    assert.equal(snap?.leads[0]?.provider_message_ids?.includes('re_0'), true);
    assert.equal(snap?.leads[0]?.delivered, 'UNKNOWN');
  });

  it('handleCrmSyncIngest enforces auth', async () => {
    const denied = await handleCrmSyncIngest({ authorization: 'Bearer nope' }, { leads: [] }, { env: env() });
    assert.equal(denied.status, 401);
    const ok = await handleCrmSyncIngest(
      { authorization: `Bearer ${secret}` },
      {
        leads: [
          {
            id: 1,
            business_name: 'A',
            email: 'a@example.com',
            email_accepted: 'NO',
            delivered: 'UNKNOWN',
            bounced: 'UNKNOWN',
            replied: 'UNKNOWN',
            booked: 'NO',
          },
        ],
      },
      { env: env() },
    );
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
  });
});

describe('Durable memory/Postgres path', () => {
  it('persists snapshot across cache reset', async () => {
    const e = durableEnv();
    const result = await ingestCrmSync(
      {
        leads: [
          {
            id: 7,
            business_name: 'Durable Salon',
            email: 'durable@example.com',
            email_accepted: 'YES',
            delivered: 'UNKNOWN',
            bounced: 'UNKNOWN',
            replied: 'UNKNOWN',
            booked: 'NO',
            provider_message_ids: ['msg_d7'],
          },
        ],
        email_history: [
          {
            lead_id: 7,
            email: 'durable@example.com',
            provider_message_id: 'msg_d7',
            status: 'SENT',
            accepted: 'YES',
            delivered: 'UNKNOWN',
            bounced: 'UNKNOWN',
            replied: 'UNKNOWN',
          },
        ],
      },
      { env: e },
    );
    assert.equal(result.ok, true);
    resetSnapshotCache();
    const snap = await readSnapshot(e);
    assert.equal(snap?.leads.length, 1);
    assert.equal(snap?.leads[0]?.business_name, 'Durable Salon');
    assert.equal(snap?.email_history[0]?.provider_message_id, 'msg_d7');
  });

  it('keeps webhook delivery after older Mac sync overwrite attempt', async () => {
    const e = durableEnv();
    await ingestCrmSync(
      {
        leads: [
          {
            id: 42,
            business_name: 'Hair NB',
            email: 'sandra@hairnewportbeach.com',
            email_accepted: 'YES',
            delivered: 'UNKNOWN',
            bounced: 'UNKNOWN',
            replied: 'UNKNOWN',
            booked: 'NO',
            provider_message_ids: ['msg_cohort_42'],
          },
        ],
        email_history: [
          {
            lead_id: 42,
            email: 'sandra@hairnewportbeach.com',
            provider_message_id: 'msg_cohort_42',
            status: 'SENT',
            accepted: 'YES',
            delivered: 'UNKNOWN',
            bounced: 'UNKNOWN',
            replied: 'UNKNOWN',
          },
        ],
      },
      { env: e },
    );

    await applyResendEventToSnapshot(
      JSON.stringify({
        type: 'email.delivered',
        data: { email_id: 'msg_cohort_42', to: ['sandra@hairnewportbeach.com'] },
        created_at: '2026-10-15T01:00:00Z',
      }),
      e,
    );

    let snap = await readSnapshot(e);
    assert.equal(snap?.leads[0]?.delivered, 'YES');

    // Older Mac payload tries to reset delivery to UNKNOWN.
    await ingestCrmSync(
      {
        mode: 'replace',
        synced_at: '2026-09-01T00:00:00Z',
        leads: [
          {
            id: 42,
            business_name: 'Hair Newport Beach',
            email: 'sandra@hairnewportbeach.com',
            email_accepted: 'YES',
            delivered: 'UNKNOWN',
            bounced: 'UNKNOWN',
            replied: 'UNKNOWN',
            booked: 'NO',
            email_status: 'SENT',
            provider_message_ids: ['msg_cohort_42'],
          },
        ],
        email_history: [
          {
            lead_id: 42,
            email: 'sandra@hairnewportbeach.com',
            provider_message_id: 'msg_cohort_42',
            status: 'SENT',
            accepted: 'YES',
            delivered: 'UNKNOWN',
            bounced: 'UNKNOWN',
            replied: 'UNKNOWN',
          },
        ],
      },
      { env: e },
    );

    snap = await readSnapshot(e);
    assert.equal(snap?.leads[0]?.delivered, 'YES');
    assert.equal(snap?.leads[0]?.business_name, 'Hair Newport Beach');
    assert.equal(snap?.email_history[0]?.delivered, 'YES');
  });
});

describe('Resend webhook → CRM snapshot', () => {
  it('maps event types', () => {
    assert.equal(mapResendEventType('email.delivered')?.delivered, 'YES');
    assert.equal(mapResendEventType('email.bounced')?.bounced, 'YES');
    assert.equal(mapResendEventType('email.received')?.replied, 'YES');
    assert.equal(mapResendEventType('email.complained')?.email_status, 'COMPLAINED');
  });

  it('updates matched lead by provider id', async () => {
    await ingestCrmSync(
      {
        leads: [
          {
            id: 42,
            business_name: 'Hair NB',
            email: 'sandra@hairnewportbeach.com',
            email_accepted: 'YES',
            delivered: 'UNKNOWN',
            bounced: 'UNKNOWN',
            replied: 'UNKNOWN',
            booked: 'NO',
            provider_message_ids: ['msg_cohort_42'],
          },
        ],
        email_history: [
          {
            lead_id: 42,
            email: 'sandra@hairnewportbeach.com',
            provider_message_id: 'msg_cohort_42',
            status: 'SENT',
            accepted: 'YES',
            delivered: 'UNKNOWN',
            bounced: 'UNKNOWN',
            replied: 'UNKNOWN',
          },
        ],
      },
      { env: env() },
    );

    const applied = await applyResendEventToSnapshot(
      JSON.stringify({
        type: 'email.delivered',
        data: { email_id: 'msg_cohort_42', to: ['sandra@hairnewportbeach.com'] },
        created_at: '2026-10-15T01:00:00Z',
      }),
      env(),
    );
    assert.equal(applied.applied, true);
    assert.equal(applied.matched_leads, 1);
    const snap = await readSnapshot(env());
    assert.equal(snap?.leads[0]?.delivered, 'YES');
    assert.equal(snap?.email_history[0]?.delivered, 'YES');
  });

  it('records inbound reply without auto-reply side effects', async () => {
    await ingestCrmSync(
      {
        leads: [
          {
            id: 3,
            business_name: 'House',
            email: 'team@houseoflange.com',
            email_accepted: 'YES',
            delivered: 'UNKNOWN',
            bounced: 'UNKNOWN',
            replied: 'UNKNOWN',
            booked: 'NO',
          },
        ],
      },
      { env: env() },
    );
    await applyResendEventToSnapshot(
      JSON.stringify({
        type: 'email.received',
        data: {
          email_id: 'in_1',
          from: 'team@houseoflange.com',
          subject: 'Re: intro',
          text: 'Thanks — interested.',
        },
      }),
      env(),
    );
    const snap = await readSnapshot(env());
    assert.equal(snap?.leads[0]?.replied, 'YES');
    assert.equal(snap?.inbox.length, 1);
    assert.equal(snap?.inbox[0]?.source, 'resend_inbound');
  });

  it('dedupes webhook events on durable store', async () => {
    const e = {
      ...durableEnv(),
      RESEND_WEBHOOK_SECRET: whsec,
    };
    await ingestCrmSync(
      {
        leads: [
          {
            id: 1,
            business_name: 'X',
            email: 'x@example.com',
            email_accepted: 'YES',
            delivered: 'UNKNOWN',
            bounced: 'UNKNOWN',
            replied: 'UNKNOWN',
            booked: 'NO',
            provider_message_ids: ['msg_dup'],
          },
        ],
      },
      { env: e },
    );

    const body = JSON.stringify({
      type: 'email.delivered',
      data: { email_id: 'msg_dup', to: ['x@example.com'] },
      created_at: '2026-10-15T02:00:00Z',
    });
    const id = 'svix_durable_dup';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = `v1,${createHmac('sha256', webhookSecretBytes(whsec))
      .update(`${id}.${timestamp}.${body}`)
      .digest('base64')}`;
    const headers = {
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': signature,
    };
    const first = await processResendWebhook({ body, headers, env: e });
    assert.equal(first.ok, true);
    assert.equal(first.duplicate, false);
    const second = await processResendWebhook({ body, headers, env: e });
    assert.equal(second.ok, true);
    assert.equal(second.duplicate, true);
  });
});

describe('admin auth gate', () => {
  it('blocks CRM overview without admin', async () => {
    const result = await handleCrmOverview(false, env());
    assert.equal(result.status, 401);
  });
});
