/**
 * Daily 20 pipeline + follow-ups + send window — mocked / fixtures only.
 */
import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { resetMemoryCrmDb } from './crm-db.ts';
import {
  BATCH_1_BLOCKLIST_EMAILS,
  buildDaily20Cohort,
  isBatch1Email,
  isCompetitorDomain,
  isWeekdayLa,
  nichePriority,
} from './daily-20-pipeline.ts';
import {
  addBusinessDaysLa,
  buildFollowUpDraftForLead,
  businessDaysBetweenLa,
  generateFollowUpDrafts,
  looksInterested,
  recordInterestedFromInbox,
} from './follow-up-drafts.ts';
import { fixtureCrmLead, fixtureDiscoveredLead } from './lead-queue.ts';
import {
  enqueueApprovedRecipients,
  isWithinSendWindow,
  processNextSend,
  readSendControls,
  writeSendControls,
} from './send-controls.ts';

const memEnv = {
  CRM_DATABASE_MEMORY: '1',
  CRM_DATABASE_URL: 'memory://crm',
  SESSION_SECRET: 'test-session-daily-20',
  UNSUBSCRIBE_SECRET: 'test-unsub',
  APP_ORIGIN: 'https://www.bbl.studio',
  BUSINESS_POSTAL_ADDRESS: '120 Newport Center Drive, Newport Beach, CA 92660',
  EMAIL_OUTREACH_ENABLED: 'false',
  EMAIL_DRY_RUN: 'true',
  MANUAL_SEND_LIVE_ENABLED: 'false',
};

beforeEach(() => {
  resetMemoryCrmDb(memEnv);
});

describe('daily-20 exclusions', () => {
  it('hard-blocks Batch 1 six and competitors', () => {
    assert.equal(BATCH_1_BLOCKLIST_EMAILS.length, 6);
    assert.equal(isBatch1Email('laguna@spadelrio.com'), true);
    assert.equal(isBatch1Email('new@salon.example'), false);
    assert.equal(isCompetitorDomain('hello@bbl.studio'), true);
    assert.equal(isCompetitorDomain('info@squarespace.com'), true);
    assert.equal(isCompetitorDomain('owner@localspa.com'), false);
  });

  it('prioritizes OC med spa niches', () => {
    const oc = nichePriority({
      category: 'med spa',
      business_name: 'Irvine Aesthetics',
      location: 'Irvine, CA',
    });
    const la = nichePriority({
      category: 'salon',
      business_name: 'LA Cuts',
      location: 'Los Angeles, CA',
    });
    assert.ok(oc > la);
  });

  it('qualifies best 20 with observation+email; excludes Batch 1', async () => {
    // Wednesday UTC ~ afternoon PT
    const now = Date.parse('2026-10-21T20:00:00Z');
    assert.equal(isWeekdayLa(now), true);

    const crm = [
      fixtureCrmLead({
        id: 1,
        email: 'laguna@spadelrio.com',
        business_name: 'Spa Del Rio',
        location: 'Laguna Beach, CA',
        website_observation: 'should be excluded',
      }),
      fixtureCrmLead({
        id: 2,
        email: 'hello@okmedspa.com',
        business_name: 'OK Med Spa',
        location: 'Irvine, CA',
        category: 'med spa',
        website_observation: 'booking CTA buried under services',
      }),
      fixtureCrmLead({
        id: 3,
        email: 'noobs@salon.com',
        business_name: 'No Obs Salon',
        location: 'Irvine, CA',
        website_observation: '',
        outreach_observation: '',
      }),
    ];
    const discovered = Array.from({ length: 28 }, (_, i) =>
      fixtureDiscoveredLead({
        id: `d${i}`,
        place_id: `places/ChIJ${i}`,
        public_email: `lead${i}@beautyoc${i}.example`,
        business_name: `OC Beauty ${i}`,
        city: 'Newport Beach',
        category: 'beauty salon',
        website: `https://beautyoc${i}.example`,
        score_total: 60 + (i % 20),
        weak_website_signals: [`mobile nav collapses awkwardly ${i}`],
      }),
    );

    const cohort = await buildDaily20Cohort(
      {
        crmLeads: crm,
        discovered,
        history: [],
        suppressedEmails: new Set(),
        fixturesOnly: true,
        now,
        qualifyCap: 20,
      },
      memEnv,
    );

    assert.ok(cohort.discovered_count >= 30);
    assert.equal(cohort.qualified.length, 20);
    assert.ok(!cohort.qualified.some((q) => q.email === 'laguna@spadelrio.com'));
    assert.ok(!cohort.qualified.some((q) => q.email === 'noobs@salon.com'));
    assert.ok(cohort.qualified.every((q) => q.website_observation && q.email));
    assert.ok(cohort.qualified.every((q) => q.preview_subject && q.preview_body));
    assert.ok(cohort.rejected_pool.some((r) => r.reason === 'batch_1_sent'));
  });
});

describe('follow-up drafts + interested', () => {
  it('builds follow-up after 3 business days; not before', () => {
    // Sent Monday Oct 19 2026 18:00Z → eligible after 3 biz days
    const sent = '2026-10-19T18:00:00Z';
    const sentMs = Date.parse(sent);
    const tooSoon = addBusinessDaysLa(sentMs, 2);
    const ok = addBusinessDaysLa(sentMs, 3);
    assert.ok(businessDaysBetweenLa(sentMs, tooSoon) < 3);
    assert.ok(businessDaysBetweenLa(sentMs, ok) >= 3);

    const lead = fixtureCrmLead({ id: 9, email: 'fu@ex.com' });
    assert.equal(buildFollowUpDraftForLead(lead, sent, memEnv, tooSoon), null);
    const draft = buildFollowUpDraftForLead(lead, sent, memEnv, ok);
    assert.ok(draft);
    assert.match(draft!.body, /Safa/);
    assert.match(draft!.body, /www\.bbl\.studio\/book/);
  });

  it('generates drafts for nonresponders and flags interested replies', async () => {
    const lead = fixtureCrmLead({ id: 11, email: 'reply@ex.com', website_observation: 'weak CTA' });
    const sentAt = '2026-10-15T17:00:00Z';
    const nowMs = addBusinessDaysLa(Date.parse(sentAt), 4);
    const created = await generateFollowUpDrafts(
      {
        leads: [lead],
        history: [
          {
            email: 'reply@ex.com',
            status: 'SENT',
            accepted: 'YES',
            delivered: 'UNKNOWN',
            bounced: 'NO',
            replied: 'UNKNOWN',
            sent_at: sentAt,
            dry_run: false,
            business_name: lead.business_name,
            lead_id: 11,
          },
        ],
        nowMs,
      },
      memEnv,
    );
    assert.equal(created.length, 1);

    assert.equal(looksInterested('Re: idea', 'Sounds good — interested in booking'), true);
    const flagged = await recordInterestedFromInbox(
      [
        {
          id: 'in_1',
          from_email: 'reply@ex.com',
          subject: 'Re: idea',
          snippet: 'Sounds good — interested',
          received_at: nowIsoSafe(),
          source: 'unknown',
        },
      ],
      memEnv,
    );
    assert.equal(flagged.length, 1);
  });
});

function nowIsoSafe() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

describe('send window 9–11 PT', () => {
  it('blocks process outside window without marking sent', async () => {
    await writeSendControls(
      {
        ...(await readSendControls(memEnv)),
        enforce_send_window: true,
        window_start_hour_pt: 9,
        window_end_hour_pt: 11,
        paused: false,
        cancelled: false,
      },
      memEnv,
    );
    await enqueueApprovedRecipients(
      [
        {
          lead_id: 'L',
          email: 'win@ex.com',
          business_name: 'Win',
          subject: 'Hi',
          body: 'Body',
          draft_id: 'd1',
        },
      ],
      memEnv,
    );

    // 3 PM PT ≈ 22:00 UTC (PDT)
    const outside = Date.parse('2026-10-22T22:00:00Z');
    assert.equal(
      isWithinSendWindow({ enforce_send_window: true, window_start_hour_pt: 9, window_end_hour_pt: 11 }, outside),
      false,
    );
    const result = await processNextSend(
      async () => ({ ok: true, provider_message_id: 'should-not-run' }),
      memEnv,
      { allowLive: true, nowMs: outside },
    );
    assert.equal(result.processed, false);
    assert.match(result.message, /Outside send window/);

    // 10 AM PT ≈ 17:00 UTC PDT
    const inside = Date.parse('2026-10-22T17:00:00Z');
    assert.equal(
      isWithinSendWindow({ enforce_send_window: true, window_start_hour_pt: 9, window_end_hour_pt: 11 }, inside),
      true,
    );
  });
});
