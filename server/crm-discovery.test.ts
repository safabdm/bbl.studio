import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { resetCrmDbClient, resetMemoryCrmDb } from './crm-db.ts';
import {
  handleDiscoveryCron,
  handleDiscoveryPause,
  handleDiscoveryResume,
  handleDiscoveryRun,
  handleDiscoveryStatus,
} from './crm-discovery-api.ts';
import { buildSearchQueries, isDiscoveryEnabled, isPlacesConfigured, maxPerRun } from './crm-discovery-places.ts';
import { buildDiscoveredLead, scoreCandidate, type WebsiteEvidence } from './crm-discovery-qualify.ts';
import { runDiscoveryCycle } from './crm-discovery-runner.ts';
import { countDiscoveredLeads, listDiscoveredLeads, resetDiscoveryDbClient, resetMemoryDiscovery } from './crm-discovery-store.ts';
import type { PlacesCandidate } from './crm-discovery-places.ts';

const memEnv = {
  CRM_DATABASE_URL: 'memory://crm',
  CRM_DATABASE_MEMORY: '1',
  EMAIL_OUTREACH_ENABLED: 'false',
  EMAIL_DRY_RUN: 'true',
  MANUAL_SEND_LIVE_ENABLED: 'false',
};

afterEach(() => {
  resetMemoryCrmDb(memEnv);
  resetMemoryDiscovery(memEnv);
  resetCrmDbClient();
  resetDiscoveryDbClient();
});

function sampleCandidate(overrides: Partial<PlacesCandidate> = {}): PlacesCandidate {
  return {
    place_id: 'ChIJtest123',
    business_name: 'Lumina Med Spa',
    website: 'https://lumina-medspa.example',
    phone: '(949) 555-0100',
    city: 'Irvine',
    category: 'Medical spa',
    source_url: 'https://maps.google.com/?cid=1',
    maps_uri: 'https://maps.google.com/?cid=1',
    types: ['spa', 'beauty_salon', 'health'],
    rating: 4.7,
    user_rating_count: 120,
    raw_query: 'med spa in Irvine, CA',
    ...overrides,
  };
}

function sampleWeb(overrides: Partial<WebsiteEvidence> = {}): WebsiteEvidence {
  return {
    fetched: true,
    final_url: 'https://lumina-medspa.example',
    status: 200,
    has_viewport: false,
    has_booking: false,
    has_instagram: true,
    has_facebook: false,
    has_linkedin: false,
    mailto_emails: [],
    visible_emails: [],
    tel_phones: [],
    title: 'Lumina Med Spa',
    looks_template: true,
    looks_outdated: false,
    has_https: true,
    error: null,
    social: { instagram: 'https://instagram.com/lumina' },
    ...overrides,
  };
}

describe('discovery config', () => {
  it('fails closed without Places key', () => {
    assert.equal(isPlacesConfigured({}), false);
    assert.equal(isDiscoveryEnabled({}), false);
    assert.equal(isDiscoveryEnabled({ GOOGLE_PLACES_API_KEY: 'k', DISCOVERY_ENABLED: 'false' }), false);
    assert.equal(isDiscoveryEnabled({ GOOGLE_PLACES_API_KEY: 'k' }), true);
    assert.equal(maxPerRun({}), 8);
  });

  it('builds OC-first search queries', () => {
    const q = buildSearchQueries({ cityLimit: 2, categoryLimit: 1 });
    assert.equal(q.length, 2);
    assert.match(q[0]!.textQuery, /Irvine/);
  });
});

describe('evidence scoring', () => {
  it('scores capacity + weak website without inventing email', () => {
    const scored = scoreCandidate(sampleCandidate(), sampleWeb());
    assert.ok(scored.score_total > 40);
    assert.equal(scored.public_email, null);
    assert.ok(scored.payment_capacity_signals.length >= 1);
    assert.ok(scored.weak_website_signals.length >= 1);
    assert.ok(scored.evidence.every((e) => e.source && e.signal));
  });

  it('marks public mailto as contactable evidence only', () => {
    const lead = buildDiscoveredLead(
      sampleCandidate({ place_id: 'ChIJemail' }),
      sampleWeb({ mailto_emails: ['hello@lumina-medspa.example'], has_viewport: true }),
    );
    assert.equal(lead.public_email, 'hello@lumina-medspa.example');
    assert.equal(lead.enrichment.email_source, 'website_mailto');
    assert.ok(['qualified', 'discovered'].includes(lead.status));
  });
});

describe('discovery runner fail-closed', () => {
  it('skips cycle with fail_closed when Places key missing', async () => {
    const run = await runDiscoveryCycle({
      trigger: 'test',
      idempotency_key: 'test:no-key',
      env: memEnv,
    });
    assert.equal(run.status, 'skipped');
    assert.equal(run.fail_closed, true);
    assert.equal(run.discovered, 0);
    const counts = await countDiscoveredLeads(memEnv);
    assert.equal(counts.total, 0);
  });

  it('is idempotent for the same cron key', async () => {
    const a = await runDiscoveryCycle({
      trigger: 'cron',
      idempotency_key: 'discovery:cron:idem',
      env: memEnv,
    });
    const b = await runDiscoveryCycle({
      trigger: 'cron',
      idempotency_key: 'discovery:cron:idem',
      env: memEnv,
    });
    assert.equal(a.id, b.id);
    assert.equal(a.status, b.status);
  });

  it('respects pause', async () => {
    await handleDiscoveryPause(true, { reason: 'maintenance' }, memEnv);
    const run = await runDiscoveryCycle({
      trigger: 'cron',
      idempotency_key: 'discovery:cron:paused',
      env: memEnv,
    });
    assert.equal(run.status, 'paused');
    await handleDiscoveryResume(true, memEnv);
  });
});

describe('discovery with mocked Places', () => {
  it('persists real mocked candidates only', async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('places.googleapis.com')) {
        return new Response(
          JSON.stringify({
            places: [
              {
                id: 'places/ChIJmock001',
                displayName: { text: 'Harbor Wellness Spa' },
                websiteUri: 'https://harbor-wellness.example',
                nationalPhoneNumber: '(949) 555-0199',
                googleMapsUri: 'https://maps.google.com/?cid=99',
                types: ['spa', 'health'],
                primaryTypeDisplayName: { text: 'Spa' },
                rating: 4.6,
                userRatingCount: 80,
                formattedAddress: '100 Pacific Coast Hwy, Newport Beach, CA 92660, USA',
                addressComponents: [{ longText: 'Newport Beach', types: ['locality'] }],
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      // website fetch
      return new Response(
        `<html><head><title>Harbor</title></head><body>
          <a href="mailto:info@harbor-wellness.example">email</a>
          <a href="https://instagram.com/harbor">ig</a>
          copyright 2012
        </body></html>`,
        { status: 200, headers: { 'Content-Type': 'text/html' } },
      );
    };

    const env = {
      ...memEnv,
      GOOGLE_PLACES_API_KEY: 'test-key',
      DISCOVERY_MAX_PER_RUN: '3',
      DISCOVERY_CITY_LIMIT: '1',
      DISCOVERY_CATEGORY_LIMIT: '1',
      DISCOVERY_ENRICH_ON_RUN: 'false',
    };

    const run = await runDiscoveryCycle({
      trigger: 'manual',
      idempotency_key: 'discovery:manual:mock1',
      env,
      fetchImpl,
      max_results: 3,
    });

    assert.equal(run.fail_closed, false);
    assert.equal(run.status, 'completed');
    assert.ok(run.discovered >= 1);
    const leads = await listDiscoveredLeads({}, env);
    assert.ok(leads.some((l) => l.business_name === 'Harbor Wellness Spa'));
    assert.ok(leads.every((l) => l.place_id && l.evidence.length > 0));
    assert.ok(!leads.some((l) => l.business_name.toLowerCase().includes('fabricat')));
  });
});

describe('discovery API auth', () => {
  it('requires admin for status/run', async () => {
    const denied = await handleDiscoveryStatus(false, memEnv);
    assert.equal(denied.status, 401);
    const runDenied = await handleDiscoveryRun(false, {}, memEnv);
    assert.equal(runDenied.status, 401);
  });

  it('returns real empty dashboard for admin without Places', async () => {
    const res = await handleDiscoveryStatus(true, memEnv);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal((res.body.config as { places_configured?: boolean }).places_configured, false);
    assert.equal((res.body.counts as { total?: number }).total, 0);
    assert.equal(res.body.live_email_send, false);
  });

  it('cron requires CRON_SECRET bearer', async () => {
    const noSecret = await handleDiscoveryCron({ authorization: 'Bearer x' }, memEnv);
    assert.equal(noSecret.status, 401);
    const withSecret = await handleDiscoveryCron(
      { authorization: 'Bearer cron-test' },
      { ...memEnv, CRON_SECRET: 'cron-test' },
    );
    assert.equal(withSecret.status, 200);
    assert.equal((withSecret.body.run as { fail_closed?: boolean }).fail_closed, true);
  });
});
