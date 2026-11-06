import assert from 'node:assert/strict';
import { hasVerifiedMarketingNeed } from './marketing-automation.js';
import { beforeEach, test } from 'node:test';
import { resetMemoryCrmDb, dbWriteKv } from './crm-db.js';
import { fixtureDiscoveredLead, buildLeadQueue } from './lead-queue.js';
import { runMarketingTick, readMarketingState, MARKETING_STATE, updateMarketingControl, renderMarketingEmail, type MarketingDeps, type MarketingEnv } from './marketing-automation.js';
import { handleSendControlsAction } from './outreach-studio-api.js';
import { readSendQueue } from './send-controls.js';
import { buildUnsubscribeUrl } from './outreach-policy.js';
import { verifyUnsubscribeToken } from './unsubscribe.js';
import { GRAPH_TOKEN_KV, saveGraphTokens, resolveAccessToken, importGraphReplies } from './graph-sender.js';

const env: MarketingEnv & NodeJS.ProcessEnv = { CRM_DATABASE_MEMORY:'1', CRM_DATABASE_URL:'memory://marketing-tests', MARKETING_AUTOMATION_ENABLED:'true',
  MICROSOFT_GRAPH_CLIENT_ID:'mock',MICROSOFT_GRAPH_CLIENT_SECRET:'mock',MICROSOFT_GRAPH_TENANT_ID:'mock',GOOGLE_CALENDAR_ID:'mock',GOOGLE_REFRESH_TOKEN:'mock',EMAIL_DRY_RUN:'false', RESEND_API_KEY:'mock-only', RESEND_FROM:'Business Brand Lab <hello@bbl.studio>',
  UNSUBSCRIBE_SECRET:'test',SESSION_SECRET:'test',CRON_SECRET:'test',BUSINESS_POSTAL_ADDRESS:'120 Newport Center Drive, Newport Beach, CA 92660' };
const now=Date.parse('2026-11-04T18:00:00Z'); // Wednesday 10am PST
beforeEach(()=>resetMemoryCrmDb(env));
test('booking fingerprint absence and builder footprints do not qualify a marketing need',()=>{
  assert.equal(hasVerifiedMarketingNeed(fixtureDiscoveredLead({evidence:[{field:'booking',signal:'no_booking',detail:'No widget detected',source:'https://example.org'}],weak_website_signals:['Template footprint']})),false);
  assert.equal(hasVerifiedMarketingNeed(fixtureDiscoveredLead({evidence:[{field:'website',signal:'verified_website_need',detail:'your website displays placeholder text',source:'https://example.org'}],weak_website_signals:['your website displays placeholder text']})),true);
});
async function harness() {
  const built=await buildLeadQueue({fixturesOnly:true,crmLeads:[],history:[],suppressedEmails:new Set(),
    discovered:[fixtureDiscoveredLead({id:'m1',business_name:'Test Salon',public_email:'owner@testsalon.com',website:'https://testsalon.com',problems:['booking requires a callback']})]},env);
  const item=built.items[0]!;
  assert.ok(item,'test fixture must produce a real queue candidate');
  item.website_observation='the appointment page uses a callback request';
  let sends=0;
  const deps:MarketingDeps={candidates:async()=>[item],inbox:async()=>({ok:true,replies:[],optouts:[]}),bookings:async()=>[],providerReady:async()=>true,
    receipt:async()=> 'DELIVERED',send:async()=>{sends++;return {ok:true,id:'provider-test-id'};}};
  return {item,deps,sends:()=>sends};
}
test('disabled campaign never calls providers',async()=>{
  const h=await harness();const r=await runMarketingTick({...env,MARKETING_AUTOMATION_ENABLED:'false'},h.deps,now);
  assert.equal(r.status,'BLOCKED');assert.equal(h.sends(),0);
});
test('one initial, accepted is not delivered, duplicate tick cannot resend',async()=>{
  const h=await harness();await runMarketingTick(env,h.deps,now);await runMarketingTick(env,h.deps,now+1800000);
  assert.equal(h.sends(),1);const state=await readMarketingState(env);assert.equal(state.attempts.length,1);
  assert.match(state.attempts[0]!.body,/three-page.*\$2,000/);assert.equal(state.attempts[0]!.status,'SUBMITTED');
});
test('receipt starts UNKNOWN despite successful submission',async()=>{
  const h=await harness();await runMarketingTick(env,h.deps,now);
  assert.equal((await readMarketingState(env)).attempts[0]!.receipt,'UNKNOWN');
});
test('concurrent ticks transmit only once',async()=>{
  const h=await harness();await Promise.all([runMarketingTick(env,h.deps,now),runMarketingTick(env,h.deps,now)]);
  assert.equal(h.sends(),1);
});
test('failed inbox, wrong sender or unavailable calendar holds send',async()=>{
  const h=await harness();h.deps.inbox=async()=>({ok:false,replies:[],optouts:[]});
  assert.equal((await runMarketingTick(env,h.deps,now)).status,'BLOCKED');assert.equal(h.sends(),0);
  h.deps.inbox=async()=>({ok:true,replies:[],optouts:[]});h.deps.providerReady=async()=>false;
  assert.equal((await runMarketingTick(env,h.deps,now)).status,'BLOCKED');
  h.deps.providerReady=async()=>true;h.deps.bookings=async()=>{throw new Error('offline');};
  assert.equal((await runMarketingTick(env,h.deps,now)).status,'BLOCKED');assert.equal(h.sends(),0);
});
test('reply or booking stops a recipient',async()=>{
  const h=await harness();h.deps.inbox=async()=>({ok:true,replies:[h.item.email],optouts:[]});
  await runMarketingTick(env,h.deps,now);assert.equal(h.sends(),0);
});
test('uncertain network transmission is never retried',async()=>{
  const h=await harness();h.deps.send=async()=>{throw new Error('timeout');};
  await runMarketingTick(env,h.deps,now);assert.equal((await readMarketingState(env)).attempts[0]!.status,'CLAIMED');
  h.deps.send=async()=>{throw new Error('must not be reached');};
  assert.equal((await runMarketingTick(env,h.deps,now+1800000)).status,'BLOCKED');
});
test('follow-up requires verified delivery and waits five business days',async()=>{
  const h=await harness();await runMarketingTick(env,h.deps,now);
  await runMarketingTick(env,h.deps,now+2*86400000);assert.equal(h.sends(),1);
  h.deps.receipt=async()=> 'UNKNOWN';
  await runMarketingTick(env,h.deps,now+7*86400000);assert.equal(h.sends(),2); // previously verified delivery remains known
  const state=await readMarketingState(env);assert.equal(state.attempts[1]!.step,1);
});
test('delivered follow-up survives removal from the new-prospect shortlist',async()=>{
  const h=await harness();await runMarketingTick(env,h.deps,now);
  h.deps.candidates=async()=>[];
  const result=await runMarketingTick(env,h.deps,now+7*86400000);
  assert.equal(result.status,'SUBMITTED');assert.equal(h.sends(),2);
  const state=await readMarketingState(env);
  assert.equal(state.attempts[1]!.email,state.attempts[0]!.email);
  assert.equal(state.attempts[1]!.step,1);
});
test('unknown delivery prevents follow-up and stops after 24 hours',async()=>{
  const h=await harness();h.deps.receipt=async()=> 'UNKNOWN';await runMarketingTick(env,h.deps,now);
  const r=await runMarketingTick(env,h.deps,now+7*86400000);assert.equal(r.status,'BLOCKED');assert.equal(h.sends(),1);
});
test('later complaint overrides previously delivered and holds campaign',async()=>{
  const h=await harness();await runMarketingTick(env,h.deps,now);await runMarketingTick(env,h.deps,now+1800000);
  h.deps.receipt=async()=> 'COMPLAINED';assert.equal((await runMarketingTick(env,h.deps,now+3600000)).status,'BLOCKED');assert.equal(h.sends(),1);
});
test('five confirmed clients or owner pause stops promotion',async()=>{
  const h=await harness();for(let i=0;i<5;i++)await updateMarketingControl(env,{client_email:`client${i}@example.com`,evidence:'Owner verified payment'});
  assert.equal((await runMarketingTick(env,h.deps,now)).status,'COMPLETE');assert.equal(h.sends(),0);
});
test('cap includes submitted and unresolved claims',async()=>{
  const h=await harness();await runMarketingTick(env,h.deps,now);const state=await readMarketingState(env);
  const first=state.attempts[0]!;state.attempts=Array.from({length:5},(_,i)=>({...first,id:String(i),email:`other${i}@example.com`,business:`Other ${i}`,domain:`other${i}.com`,receipt:'DELIVERED' as const}));
  await dbWriteKv(MARKETING_STATE,state,env);await runMarketingTick(env,h.deps,now+1800000);assert.equal(h.sends(),1);
});
test('five reply/follow-up messages do not consume the new-business allowance',async()=>{
  const h=await harness();await runMarketingTick(env,h.deps,now);
  const state=await readMarketingState(env),first=state.attempts[0]!;
  state.attempts.push(...Array.from({length:5},(_,i)=>({...first,id:`reply${i}`,replyTo:`incoming${i}`,email:`reply${i}@example.com`,receipt:'DELIVERED' as const})));
  await dbWriteKv(MARKETING_STATE,state,env);
  h.deps.candidates=async()=>[{...h.item,id:'next',email:'new@next-fixture.com',website:'https://next-fixture.com',business_name:'Next fixture'}];
  assert.equal((await runMarketingTick(env,h.deps,now+60000)).status,'SUBMITTED');
  assert.equal(h.sends(),2);
});
test('five new businesses leave room for a due delivered follow-up',async()=>{
  const h=await harness();await runMarketingTick(env,h.deps,now-7*86400000);
  const state=await readMarketingState(env),first=state.attempts[0]!;
  state.attempts.push(...Array.from({length:5},(_,i)=>({...first,id:`new${i}`,email:`new${i}@example.com`,business:`New ${i}`,domain:`new${i}.com`,claimedAt:new Date(now).toISOString(),receipt:'DELIVERED' as const})));
  await dbWriteKv(MARKETING_STATE,state,env);h.deps.candidates=async()=>[];
  assert.equal((await runMarketingTick(env,h.deps,now)).status,'SUBMITTED');
  assert.equal((await readMarketingState(env)).attempts.at(-1)?.step,1);
});
test('ten total claims prevent any eleventh message',async()=>{
  const h=await harness();await runMarketingTick(env,h.deps,now);
  const state=await readMarketingState(env),first=state.attempts[0]!;
  state.attempts=Array.from({length:10},(_,i)=>({...first,id:String(i),email:`other${i}@example.com`,business:`Other ${i}`,domain:`other${i}.com`,replyTo:i>=5?`reply${i}`:undefined,receipt:'DELIVERED' as const}));
  await dbWriteKv(MARKETING_STATE,state,env);
  assert.equal((await runMarketingTick(env,h.deps,now+60000)).status,'IDLE');assert.equal(h.sends(),1);
});
test('reply/follow-up allowance stops at five even when a delivered follow-up is due',async()=>{
  const h=await harness();await runMarketingTick(env,h.deps,now-7*86400000);
  const state=await readMarketingState(env),first=state.attempts[0]!;
  state.attempts.push(...Array.from({length:5},(_,i)=>({...first,id:`reply${i}`,replyTo:`incoming${i}`,email:`reply${i}@example.com`,claimedAt:new Date(now).toISOString(),receipt:'DELIVERED' as const})));
  await dbWriteKv(MARKETING_STATE,state,env);h.deps.candidates=async()=>[];
  assert.equal((await runMarketingTick(env,h.deps,now)).status,'IDLE');assert.equal(h.sends(),1);
});
test('dry-run process_one leaves real send queue untouched',async()=>{
  const result=await handleSendControlsAction(true,{action:'process_one',allow_live:false},env);
  assert.equal(result.body.live_email_send,false);assert.deepEqual(await readSendQueue(env),[]);
});
test('follow-up copy never exceeds two and includes exact offer',()=>{
  const item={business_name:'Salon',contact_name:null,website_observation:'the site lists two locations'};
  for(let step=0;step<=2;step++)assert.match(renderMarketingEmail(item,step).body,/three-page.*\$2,000/);
  assert.throws(()=>renderMarketingEmail(item,3));
});
test('discovered string IDs produce valid signed opt-out links',()=>{
  const url=new URL(buildUnsubscribeUrl('Owner@salon.com','email:owner@salon.com',env));
  const id=Number(url.searchParams.get('lead_id'));
  assert.ok(Number.isSafeInteger(id) && id>0);
  assert.equal(verifyUnsubscribeToken('owner@salon.com',id,url.searchParams.get('token')!,env.UNSUBSCRIBE_SECRET),true);
});
test('expired Outlook tokens refresh and rotate instead of breaking daily runs',async()=>{
  const token=await saveGraphTokens({access_token:'expired',refresh_token:'refresh',account_email:'hello@bbl.studio'},env);
  await dbWriteKv(GRAPH_TOKEN_KV,{...token,expires_at:'2020-01-01T00:00:00Z'},env);
  let requests=0;
  const mock=async()=>{requests++;return new Response(JSON.stringify({access_token:'new-token',refresh_token:'new-refresh',expires_in:3600}),{status:200});};
  const result=await resolveAccessToken(env,mock as typeof fetch);
  assert.deepEqual(result,{ok:true,token:'new-token'});assert.equal(requests,1);
});
test('reply scan paginates and ignores unrelated in-reply-to headers',async()=>{
  await saveGraphTokens({access_token:'valid'},env);
  let requests=0;
  const mock=async()=>{
    requests++;
    const data=requests===1 ? {value:[{id:'unrelated',from:{emailAddress:{address:'unrelated@example.com'}},internetMessageHeaders:[{name:'In-Reply-To',value:'not-bbl'}]}],'@odata.nextLink':'https://graph.microsoft.com/v1.0/me/messages?$skip=100'} : {value:[{id:'reply',from:{emailAddress:{address:'owner@testsalon.com'}}}]};
    return new Response(JSON.stringify(data),{status:200});
  };
  const result=await importGraphReplies({known_emails:new Set(['owner@testsalon.com'])},env,mock as typeof fetch);
  assert.equal(result.ok,true);if(result.ok)assert.deepEqual(result.marked_replied,['owner@testsalon.com']);
  assert.equal(requests,2);
});
test('delivered sequence ends after two follow-ups',async()=>{
  const h=await harness();await runMarketingTick(env,h.deps,now);
  await runMarketingTick(env,h.deps,now+7*86400000);
  await runMarketingTick(env,h.deps,now+16*86400000);
  await runMarketingTick(env,h.deps,now+26*86400000);
  assert.equal(h.sends(),3);assert.deepEqual((await readMarketingState(env)).attempts.map(a=>a.step),[0,1,2]);
});
test('owner pause stops new messages',async()=>{
  const h=await harness();await updateMarketingControl(env,{paused:true});
  await runMarketingTick(env,h.deps,now);assert.equal(h.sends(),0);
});

test('routine reply is durable, deduplicated, and does not count as acceptance',async()=>{
  const h=await harness();await runMarketingTick(env,h.deps,now);
  h.deps.inbox=async()=>({ok:true,replies:[h.item.email],optouts:[],messages:[{id:'in1',email:h.item.email,subject:'Re: website',text:'Yes, send an outline please',receivedAt:new Date(now+1000).toISOString(),automated:false}]});
  await runMarketingTick(env,h.deps,now+1800000);await runMarketingTick(env,h.deps,now+3600000);
  const state=await readMarketingState(env);assert.equal(h.sends(),2);assert.equal(state.clients.length,0);assert.equal(state.attempts[1]!.replyTo,'in1');assert.match(state.attempts[1]!.body,/Ready to start/);
});
test('explicit completed acceptance creates one handoff and reserves one place',async()=>{
  const h=await harness();await runMarketingTick(env,h.deps,now);
  const text='I accept the three-page informational website for $2,000.\nReady to start: Yes\nBusiness: Test Salon\nThree pages: Home, Services, Contact\nContact name: Alex Smith\nAssets: Logo and photos available, text missing';
  h.deps.inbox=async()=>({ok:true,replies:[h.item.email],optouts:[],messages:[{id:'in2',email:h.item.email,subject:'Re',text,receivedAt:new Date(now+1000).toISOString(),automated:false}]});
  await runMarketingTick(env,h.deps,now+1800000);await runMarketingTick(env,h.deps,now+3600000);
  const state=await readMarketingState(env);assert.equal(state.clients.length,1);assert.equal(state.conversations?.[0]?.status,'READY');assert.equal(h.sends(),2);
});
