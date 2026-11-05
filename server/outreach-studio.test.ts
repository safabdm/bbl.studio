/**
 * Outreach Studio unit tests — mocked providers + fixture leads only.
 */
import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { resetMemoryCrmDb } from './crm-db.ts';
import {
  applySuggestedCap,
  clampDailyCap,
  DEFAULT_DAILY_SEND_CAP,
  laDayKey,
  maybeResetForNewLaDay,
  maybeSuggestCapRaise,
  readDailyCapState,
  recordSuccessfulSend,
  remainingSends,
  setDailyCap,
  writeDailyCapState,
  RAMP_WEEK1_MAX,
} from './daily-cap.ts';
import {
  approveStudioDrafts,
  draftBlocks,
  observationGate,
  OWNER_SIGNATURE,
  renderStudioDraft,
  signatureAndFooterPresent,
  upsertStudioDraftFromLead,
} from './email-studio.ts';
import {
  buildGraphAuthUrl,
  exchangeGraphAuthCode,
  importGraphReplies,
  saveGraphTokens,
  sendViaGraph,
  setActiveSender,
  getActiveSender,
} from './graph-sender.ts';
import {
  applyLeadQueueAction,
  buildLeadQueue,
  extractDomain,
  fixtureCrmLead,
  fixtureDiscoveredLead,
  filterLeadQueue,
  queueItemId,
  readLeadQueueState,
} from './lead-queue.ts';
import { normalizeOutreachStatus } from './outreach-status.ts';
import {
  cancelSending,
  countResendRisk,
  enqueueApprovedRecipients,
  pauseSending,
  processNextSend,
  readSendQueue,
  recordBounceOrComplaint,
  resumeSending,
} from './send-controls.ts';
import { containsPricing } from './outreach-policy.ts';

const memEnv = {
  CRM_DATABASE_MEMORY: '1',
  CRM_DATABASE_URL: 'memory://crm',
  SESSION_SECRET: 'test-session-secret-outreach-studio',
  UNSUBSCRIBE_SECRET: 'test-unsub',
  APP_ORIGIN: 'https://www.bbl.studio',
  BUSINESS_POSTAL_ADDRESS: '1 Test St, Irvine, CA 92618',
  EMAIL_OUTREACH_ENABLED: 'false',
  EMAIL_DRY_RUN: 'true',
  MANUAL_SEND_LIVE_ENABLED: 'false',
};

beforeEach(() => {
  resetMemoryCrmDb(memEnv);
});

describe('outreach status model', () => {
  it('keeps unknown explicit and maps only clear aliases', () => {
    assert.equal(normalizeOutreachStatus(null), 'unknown');
    assert.equal(normalizeOutreachStatus(''), 'unknown');
    assert.equal(normalizeOutreachStatus('weird'), 'unknown');
    assert.equal(normalizeOutreachStatus('queued'), 'queued');
    assert.equal(normalizeOutreachStatus('SENT'), 'submitted');
    assert.equal(normalizeOutreachStatus('delivered'), 'delivered');
  });
});

describe('lead queue dedupe both stores', () => {
  it('dedupes CRM snapshot + discovery by email and domain', async () => {
    const crm = fixtureCrmLead({
      id: 1,
      email: 'info@shared.example',
      business_name: 'Shared Brand CRM',
      website_observation: 'mobile menu overflows',
    });
    const disc = fixtureDiscoveredLead({
      id: 'd1',
      place_id: 'places/ChIJabc',
      public_email: 'info@shared.example',
      business_name: 'Shared Brand Discovery',
      website: 'https://www.shared.example',
    });
    const built = await buildLeadQueue(
      { crmLeads: [crm], discovered: [disc], history: [], suppressedEmails: new Set(), fixturesOnly: true },
      memEnv,
    );
    assert.equal(built.items.length, 1);
    assert.ok(built.items[0]!.sources.includes('crm_snapshot'));
    assert.ok(built.items[0]!.sources.includes('discovery'));
    assert.equal(built.items[0]!.email, 'info@shared.example');
    assert.equal(extractDomain('Info@Shared.Example'), 'shared.example');
    assert.equal(queueItemId({ place_id: 'places/X' }), 'place:places/x');
  });

  it('excludes suppressed and contacted last 30d', async () => {
    const recent = fixtureCrmLead({ id: 2, email: 'recent@ex.com' });
    const suppressed = fixtureCrmLead({ id: 3, email: 'sup@ex.com' });
    const ok = fixtureCrmLead({ id: 4, email: 'ok@ex.com' });
    const now = Date.parse('2026-10-22T18:00:00Z');
    const built = await buildLeadQueue(
      {
        crmLeads: [recent, suppressed, ok],
        discovered: [],
        history: [
          {
            email: 'recent@ex.com',
            status: 'SENT',
            accepted: 'YES',
            delivered: 'UNKNOWN',
            bounced: 'NO',
            replied: 'UNKNOWN',
            sent_at: '2026-10-10T12:00:00Z',
            dry_run: false,
          },
        ],
        suppressedEmails: new Set(['sup@ex.com']),
        fixturesOnly: true,
        now,
      },
      memEnv,
    );
    assert.equal(built.items.length, 1);
    assert.equal(built.items[0]!.email, 'ok@ex.com');
    assert.equal(built.excluded.length, 2);
  });

  it('persists approve/reject with audit', async () => {
    const lead = fixtureCrmLead({ id: 9, email: 'act@ex.com' });
    const built = await buildLeadQueue(
      { crmLeads: [lead], discovered: [], history: [], suppressedEmails: new Set(), fixturesOnly: true },
      memEnv,
    );
    const id = built.items[0]!.id;
    const approved = await applyLeadQueueAction({ lead_id: id, action: 'approve' }, memEnv);
    assert.equal(approved.ok, true);
    const rejected = await applyLeadQueueAction(
      { lead_id: id, action: 'reject', reason: 'wrong niche' },
      memEnv,
    );
    assert.equal(rejected.ok, true);
    if (!rejected.ok) return;
    const state = await readLeadQueueState(memEnv);
    assert.equal(state.by_id[id]?.queue_status, 'rejected');
    assert.equal(state.by_id[id]?.reject_reason, 'wrong niche');
    const missingReason = await applyLeadQueueAction({ lead_id: id, action: 'reject' }, memEnv);
    assert.equal(missingReason.ok, false);
  });

  it('filters by search and observation', async () => {
    const a = fixtureCrmLead({ id: 1, email: 'a@ex.com', business_name: 'Alpha Spa', website_observation: 'x' });
    const b = fixtureCrmLead({
      id: 2,
      email: 'b@ex.com',
      business_name: 'Beta Salon',
      website_observation: '',
    });
    const built = await buildLeadQueue(
      { crmLeads: [a, b], discovered: [], history: [], suppressedEmails: new Set(), fixturesOnly: true },
      memEnv,
    );
    const filtered = filterLeadQueue(built.items, { q: 'alpha', has_observation: true });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]!.business_name, 'Alpha Spa');
  });
});

describe('email studio gates', () => {
  it('blocks approve without verified observation and shows why', () => {
    const gate = observationGate({
      id: 1,
      business_name: 'No Obs',
      email: 'x@y.com',
      website_observation: '',
      email_accepted: 'UNKNOWN',
      delivered: 'UNKNOWN',
      bounced: 'UNKNOWN',
      replied: 'UNKNOWN',
      booked: 'NO',
    });
    assert.equal(gate.ok, false);
    assert.match(gate.reason || '', /website_observation/);
  });

  it('blocks pricing and requires signature + footer', () => {
    const lead = fixtureCrmLead();
    const draft = renderStudioDraft(lead as never, {}, memEnv);
    assert.ok(draft.body.includes(OWNER_SIGNATURE));
    assert.ok(signatureAndFooterPresent(draft.body));
    assert.ok(draft.body.includes('https://www.bbl.studio/book'));
    assert.equal(draft.observation_verified, true);
    assert.ok(!draft.blocked_reasons.includes('missing_website_observation'));

    const priced = draftBlocks('Packages from $2,000', draft.body, lead, memEnv);
    assert.ok(priced.includes('pricing_forbidden'));
    assert.ok(containsPricing('Our package starts at $1500'));
  });

  it('approve individually respects observation gate', async () => {
    const good = fixtureCrmLead({ id: 'g1', email: 'good@ex.com' });
    const bad = fixtureCrmLead({
      id: 'b1',
      email: 'bad@ex.com',
      website_observation: '',
      outreach_observation: '',
    });
    await upsertStudioDraftFromLead(good as never, { regenerate: true }, memEnv);
    await upsertStudioDraftFromLead(bad as never, { regenerate: true }, memEnv);
    const result = await approveStudioDrafts(['g1', 'b1'], memEnv);
    assert.equal(result.approved.length, 1);
    assert.equal(result.approved[0]!.lead_id, 'g1');
    assert.equal(result.blocked.length, 1);
    assert.ok(result.blocked[0]!.reasons.includes('missing_website_observation'));
  });
});

describe('daily cap + LA midnight reset', () => {
  it('defaults to 20, clamps 10–100, ramp week1 max 20', async () => {
    assert.equal(clampDailyCap(5), 10);
    assert.equal(clampDailyCap(200), 100);
    assert.equal(DEFAULT_DAILY_SEND_CAP, 20);
    assert.equal(RAMP_WEEK1_MAX, 20);
    const state = await setDailyCap(50, memEnv, Date.parse('2026-10-22T20:00:00Z'));
    assert.equal(state.cap, 50);
    // still within ramp → remaining uses min(50,20)
    assert.ok(remainingSends(state, Date.parse('2026-10-22T20:00:00Z')) <= 20);
  });

  it('resets counter at America/Los_Angeles midnight', () => {
    const morningLa = Date.parse('2026-10-22T15:00:00Z'); // 8am LA PDT
    const nextMorning = Date.parse('2026-10-23T15:00:00Z');
    const state = maybeResetForNewLaDay(
      {
        cap: 20,
        sent_today: 7,
        day_key: laDayKey(morningLa),
        ramp_started_at: null,
        suggested_cap: null,
        suggestion_reason: null,
        updated_at: new Date(morningLa).toISOString(),
      },
      nextMorning,
    );
    assert.equal(state.sent_today, 0);
    assert.equal(state.day_key, laDayKey(nextMorning));
    assert.notEqual(laDayKey(morningLa), laDayKey(nextMorning));
  });

  it('cap suggestion never auto-applies', async () => {
    let state = await readDailyCapState(memEnv);
    state = await writeDailyCapState(
      {
        ...state,
        ramp_started_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
        cap: 20,
      },
      memEnv,
    );
    state = await maybeSuggestCapRaise({ total_sends: 50, bounces: 0, complaints: 0 }, memEnv);
    assert.equal(state.suggested_cap, 30);
    assert.equal(state.cap, 20); // not applied
    const applied = await applySuggestedCap(memEnv);
    assert.equal(applied.ok, true);
    if (applied.ok) assert.equal(applied.state.cap, 30);

    // ineligible → no suggestion
    await setDailyCap(20, memEnv);
    state = await writeDailyCapState(
      {
        ...(await readDailyCapState(memEnv)),
        ramp_started_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      },
      memEnv,
    );
    state = await maybeSuggestCapRaise({ total_sends: 50, bounces: 5, complaints: 0 }, memEnv);
    assert.equal(state.suggested_cap, null);
  });
});

describe('send controls', () => {
  it('auto-pauses on bounce >5% or any complaint', async () => {
    await recordSuccessfulSend(10, memEnv);
    // simulate submitted counts via bounce recording after manual bump
    let controls = await pauseSending('setup', memEnv);
    controls = await resumeSending(memEnv);
    // record 10 submitted via process path would be heavy — use bounce helper after setting counts
    const { writeSendControls, readSendControls } = await import('./send-controls.ts');
    await writeSendControls({ ...(await readSendControls(memEnv)), submitted_count: 10, bounce_count: 0 }, memEnv);
    controls = await recordBounceOrComplaint('bounce', memEnv); // 10%
    assert.equal(controls.auto_paused, true);
    assert.ok(controls.paused);

    await resumeSending(memEnv);
    await writeSendControls({ ...(await readSendControls(memEnv)), submitted_count: 5, bounce_count: 0, complaint_count: 0 }, memEnv);
    controls = await recordBounceOrComplaint('complaint', memEnv);
    assert.equal(controls.auto_paused, true);
    assert.match(controls.paused_reason || '', /complaint/i);
  });

  it('does not resend after refresh once submitted', async () => {
    const { writeSendControls, readSendControls } = await import('./send-controls.ts');
    await writeSendControls(
      { ...(await readSendControls(memEnv)), enforce_send_window: false, paused: false, cancelled: false },
      memEnv,
    );
    const first = await enqueueApprovedRecipients(
      [
        {
          lead_id: 'L1',
          email: 'once@ex.com',
          business_name: 'Once',
          subject: 'Hi',
          body: 'Body',
          draft_id: 'draft_1',
        },
      ],
      memEnv,
    );
    assert.equal(first.added, 1);
    // 10:00 America/Los_Angeles on a weekday (PDT = UTC-7)
    const insideWindow = Date.parse('2026-10-22T17:00:00Z');
    const processed = await processNextSend(
      async (item) => ({ ok: true, provider_message_id: `mock_${item.id}` }),
      memEnv,
      { allowLive: true, rng: () => 0, nowMs: insideWindow },
    );
    assert.equal(processed.processed, true);
    assert.equal(processed.item?.status, 'submitted');

    const again = await enqueueApprovedRecipients(
      [
        {
          lead_id: 'L1',
          email: 'once@ex.com',
          business_name: 'Once',
          subject: 'Hi',
          body: 'Body',
          draft_id: 'draft_1',
        },
      ],
      memEnv,
    );
    assert.equal(again.added, 0);
    assert.equal(again.skipped, 1);
    const risk = countResendRisk(await readSendQueue(memEnv));
    assert.equal(risk.submitted, 1);
    assert.equal(risk.pending, 0);

    await cancelSending(memEnv);
  });
});

describe('graph sender mocked fetch', () => {
  it('sends and imports replies via mocked fetch only', async () => {
    const auth = buildGraphAuthUrl('state123', {
      ...memEnv,
      MICROSOFT_GRAPH_CLIENT_ID: 'cid',
      MICROSOFT_GRAPH_CLIENT_SECRET: 'sec',
      MICROSOFT_GRAPH_TENANT_ID: 'tid',
    });
    assert.equal(auth.ok, true);
    if (auth.ok) assert.match(auth.url, /login\.microsoftonline\.com/);

    const exchanged = await exchangeGraphAuthCode(
      'code',
      {
        ...memEnv,
        MICROSOFT_GRAPH_CLIENT_ID: 'cid',
        MICROSOFT_GRAPH_CLIENT_SECRET: 'sec',
        MICROSOFT_GRAPH_TENANT_ID: 'tid',
      },
      async () =>
        new Response(JSON.stringify({ access_token: 'tok', refresh_token: 'ref', expires_in: 3600 }), {
          status: 200,
        }),
    );
    assert.equal(exchanged.ok, true);
    if (!exchanged.ok) return;
    await saveGraphTokens({ access_token: exchanged.access_token, refresh_token: exchanged.refresh_token }, memEnv);
    await setActiveSender('graph', memEnv);
    assert.equal(await getActiveSender(memEnv), 'graph');

    let sendCalls = 0;
    const sent = await sendViaGraph(
      { email: 'lead@ex.com', subject: 'Hi', body: 'Hello', attempt_token: 'tok1' },
      memEnv,
      async () => {
        sendCalls += 1;
        return new Response(null, { status: 202 });
      },
    );
    assert.equal(sent.ok, true);
    assert.equal(sendCalls, 1);

    const imported = await importGraphReplies(
      { known_emails: new Set(['lead@ex.com']) },
      memEnv,
      async () =>
        new Response(
          JSON.stringify({
            value: [
              {
                id: 'm1',
                conversationId: 'c1',
                subject: 'Re: Hi',
                bodyPreview: 'Thanks',
                receivedDateTime: '2026-10-22T12:00:00Z',
                from: { emailAddress: { address: 'lead@ex.com' } },
                internetMessageHeaders: [{ name: 'In-Reply-To', value: '<abc>' }],
              },
            ],
          }),
          { status: 200 },
        ),
    );
    assert.equal(imported.ok, true);
    if (imported.ok) {
      assert.equal(imported.items.length, 1);
      assert.deepEqual(imported.marked_replied, ['lead@ex.com']);
    }
  });
});
