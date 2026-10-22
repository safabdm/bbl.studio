import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  OUTLOOK_MAC_LICENSE_NOTE,
  OWA_URL,
  buildEml,
  buildMailtoUrl,
  draftFilename,
  encodeMailtoParam,
} from './mail-handoff.js';

describe('mail-handoff', () => {
  it('builds mailto with encoded subject and body', () => {
    const url = buildMailtoUrl({
      to: 'info@example.com',
      subject: 'Idea for Spa',
      body: 'Hi there,\n\nLine two.',
    });
    assert.match(url, /^mailto:info@example\.com\?/);
    assert.ok(url.includes('subject='));
    assert.ok(url.includes('body='));
    assert.equal(encodeMailtoParam('a b'), 'a%20b');
  });

  it('builds unsent .eml with plain text body', () => {
    const eml = buildEml(
      {
        to: 'info@example.com',
        subject: 'Hello',
        body: 'First line\nSecond line',
        business_name: 'Spa Del Rio',
      },
      { date: new Date('2026-10-22T17:00:00Z') },
    );
    assert.match(eml, /To: info@example\.com/);
    assert.match(eml, /Subject: Hello/);
    assert.match(eml, /X-Unsent: 1/);
    assert.match(eml, /First line\r\nSecond line/);
    assert.equal(draftFilename({ to: 'x', subject: '', body: '', business_name: 'Spa Del Rio' }, 0), '01-spa-del-rio.eml');
  });

  it('documents Outlook Mac license path', () => {
    assert.match(OUTLOOK_MAC_LICENSE_NOTE, /Outlook for Mac/);
    assert.match(OUTLOOK_MAC_LICENSE_NOTE, /Mail\.app/);
    assert.equal(OWA_URL, 'https://outlook.office.com/mail/');
  });
});
