import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseVerifiedOpportunities} from './marketing-verified-import.js';
const now=Date.parse('2026-11-05T22:10:00Z');
const row={business_name:'Research fixture',website:'https://fixture.example/',source_url:'https://fixture.example/contact',email:'contact@fixture.example',observation:'the service menu is marked Coming Soon',verified_at:'2026-11-05T22:09:00Z'};
test('official research keeps exact observation and does not invent ratings or Google place IDs',()=>{
  const [lead]=parseVerifiedOpportunities({opportunities:[row]},now);
  assert.equal(lead.weak_website_signals[0],row.observation);
  assert.equal(lead.score_total,0); assert.deepEqual(lead.payment_capacity_signals,[]);
  assert.match(lead.place_id,/^official_/);
});
test('stale, future and cross-site attestations are rejected',()=>{
  for(const patch of [{verified_at:'2026-11-04T22:00:00Z'},{verified_at:'2026-11-06T22:00:00Z'},{source_url:'https://directory.example/contact'}])
    assert.throws(()=>parseVerifiedOpportunities({opportunities:[{...row,...patch}]},now));
});
