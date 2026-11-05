import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildLeadQueue,fixtureCrmLead,fixtureDiscoveredLead} from './lead-queue.js';
test('unrelated businesses using Gmail stay separate, while the exact contact still merges',async()=>{
  const first=fixtureCrmLead({id:1,business_name:'First fixture',email:'first.fixture@gmail.com'});
  const second=fixtureDiscoveredLead({id:'second',place_id:'second-place',business_name:'Second fixture',public_email:'second.fixture@gmail.com'});
  const matching=fixtureDiscoveredLead({id:'first',place_id:'first-place',business_name:'First fixture',public_email:'first.fixture@gmail.com'});
  const result=await buildLeadQueue({fixturesOnly:true,crmLeads:[first],discovered:[second,matching],history:[],suppressedEmails:new Set()}, {CRM_DATABASE_MEMORY:'1'});
  assert.equal(result.items.length,2);
  assert.equal(result.items.find(x=>x.email==='second.fixture@gmail.com')?.business_name,'Second fixture');
  assert.equal(result.items.find(x=>x.email==='first.fixture@gmail.com')?.discovery_id,'first');
});
