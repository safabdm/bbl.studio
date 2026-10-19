import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BOOKING_CTA_URL,
  buildUnsubscribeUrl,
  containsPricing,
  evaluateCopyPolicy,
  filterObservationRequired,
  listUnsubscribeHeaders,
  normalizeWebsiteObservation,
  personalizeLead,
  policyBlocksSend,
} from './outreach-policy.ts';
import { DEFAULT_TEMPLATES } from './crm-campaigns.ts';

describe('outreach pricing block', () => {
  it('detects dollar amounts and package pricing language', () => {
    assert.equal(containsPricing('Landing page: from $3,000'), true);
    assert.equal(containsPricing('fixed pricing from $3,000'), true);
    assert.equal(containsPricing('custom quote after consult'), false);
  });

  it('DEFAULT_TEMPLATES have no pricing and require website_observation', () => {
    for (const tpl of DEFAULT_TEMPLATES) {
      assert.equal(containsPricing(`${tpl.subject}\n${tpl.body}`), false);
      assert.match(tpl.body, /\{\{\s*website_observation\s*\}\}/);
      assert.match(tpl.body, new RegExp(BOOKING_CTA_URL.replace(/\./g, '\\.')));
      const issues = evaluateCopyPolicy(tpl.subject, tpl.body, {
        BUSINESS_POSTAL_ADDRESS: '1 Test St, Irvine, CA 92618',
        UNSUBSCRIBE_SECRET: 'test-unsub-secret',
        APP_ORIGIN: 'https://www.bbl.studio',
      });
      assert.equal(policyBlocksSend(issues), false, JSON.stringify(issues));
    }
  });

  it('blocks copy that includes prices', () => {
    const issues = evaluateCopyPolicy('Hi', 'Packages from $3,000 — {{website_observation}}');
    assert.equal(policyBlocksSend(issues), true);
    assert.equal(issues.some((i) => i.code === 'pricing_forbidden'), true);
  });
});

describe('website_observation exclusions', () => {
  it('excludes leads without observation', () => {
    const { included, excluded } = filterObservationRequired(
      [
        { id: 1, business_name: 'A', email: 'a@x.com', website_observation: 'no booking CTA', email_accepted: 'UNKNOWN', delivered: 'UNKNOWN', bounced: 'UNKNOWN', replied: 'UNKNOWN', booked: 'NO' },
        { id: 2, business_name: 'B', email: 'b@x.com', email_accepted: 'UNKNOWN', delivered: 'UNKNOWN', bounced: 'UNKNOWN', replied: 'UNKNOWN', booked: 'NO' },
      ],
      [1, 2],
    );
    assert.equal(included.length, 1);
    assert.equal(excluded[0]?.reason, 'missing_website_observation');
  });
});

describe('unsubscribe + List-Unsubscribe', () => {
  it('builds signed unsubscribe URL and headers', () => {
    const url = buildUnsubscribeUrl('Owner@Example.com', 42, {
      UNSUBSCRIBE_SECRET: 'secret-hex-value',
      APP_ORIGIN: 'https://www.bbl.studio',
    });
    assert.match(url, /^https:\/\/www\.bbl\.studio\/unsubscribe\?/);
    assert.match(url, /lead_id=42/);
    assert.match(url, /email=owner%40example\.com/);
    const headers = listUnsubscribeHeaders(url);
    assert.match(headers['List-Unsubscribe'] || '', /<https:\/\/www\.bbl\.studio\/unsubscribe/);
    assert.equal(headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  });

  it('personalize fills observation and postal override', () => {
    const text = personalizeLead(
      'Note: {{website_observation}}. Addr {{BUSINESS_POSTAL_ADDRESS}}',
      {
        id: 1,
        business_name: 'Spa',
        email: 'a@b.com',
        website_observation: 'missing mobile viewport',
      },
      { BUSINESS_POSTAL_ADDRESS: '9 Owner Ave, Irvine, CA', UNSUBSCRIBE_SECRET: 'x', APP_ORIGIN: 'https://www.bbl.studio' },
    );
    assert.match(text, /missing mobile viewport/);
    assert.match(text, /9 Owner Ave/);
  });

  it('normalizes website_observation so trailing period never doubles', () => {
    assert.equal(normalizeWebsiteObservation('  no clear online booking path.  '), 'no clear online booking path');
    assert.equal(normalizeWebsiteObservation('outdated homepage banner...'), 'outdated homepage banner');
    assert.equal(normalizeWebsiteObservation('ends with double..'), 'ends with double');
    assert.equal(normalizeWebsiteObservation('..'), '');
    const text = personalizeLead(
      'I noticed {{website_observation}}.',
      {
        id: 1,
        business_name: 'Spa',
        email: 'a@b.com',
        website_observation: 'missing mobile viewport.',
      },
      { BUSINESS_POSTAL_ADDRESS: '9 Owner Ave', UNSUBSCRIBE_SECRET: 'x', APP_ORIGIN: 'https://www.bbl.studio' },
    );
    assert.match(text, /I noticed missing mobile viewport\./);
    assert.doesNotMatch(text, /\.\./);
    const doubledInput = personalizeLead(
      'noticed {{website_observation}}.',
      { id: 2, business_name: 'X', email: 'x@y.com', website_observation: 'no booking CTA..' },
      { BUSINESS_POSTAL_ADDRESS: '9 Owner Ave', UNSUBSCRIBE_SECRET: 'x', APP_ORIGIN: 'https://www.bbl.studio' },
    );
    assert.equal(doubledInput.includes('noticed no booking CTA.'), true);
    assert.equal(doubledInput.includes('..'), false);
  });
});
