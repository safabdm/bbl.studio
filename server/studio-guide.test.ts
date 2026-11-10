import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guideReply } from '../public/studio-guide-data.js';
import { PROJECT_OFFERS } from '../lib/offers';

test('guide starting prices agree with the studio offer source', () => {
  const reply = guideReply('View pricing');
  for (const offer of PROJECT_OFFERS.filter(offer => offer.cents > 0)) {
    assert.ok(reply.text.includes(`$${(offer.cents / 100).toLocaleString('en-US')}`));
  }
});
test('page ranges select the matching inquiry option', () => {
  for (const [question, expected] of [['One page','Simple Landing Page'], ['2–5 pages','Business Website'], ['6–10 pages','Commercial Website']]) {
    const reply=guideReply(question); assert.ok('service' in reply); assert.equal(reply.service,expected);
  }
});
test('custom functionality takes precedence over a simple page count', () => {
  const reply = guideReply('One page with an online store and checkout');
  assert.ok('service' in reply);
  assert.equal(reply.service, 'Not sure yet');
  assert.match(reply.text, /custom scope/);
});
test('unknown questions do not generate unsupported claims', () => {
  const reply = guideReply('Can you guarantee a million dollars in sales?');
  assert.match(reply.text, /not guaranteed|studio will review/);
  assert.equal(guideReply('email a person').action, 'Start a brief');
  assert.match(guideReply('how long?').text, /confirm a realistic schedule/);
});

test('consultation requests open the calendar without quoting a website package', () => {
  const reply=guideReply('Book a consultation');
  assert.ok('href' in reply);
  assert.equal(reply.href, '/booking');
  assert.match(guideReply('One page with a booking system').text, /custom scope/);
});
