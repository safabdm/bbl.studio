import assert from 'node:assert/strict';
import { checkMarketingReceipts, hasVerifiedMarketingNeed } from './marketing-automation.js';
import { beforeEach, test } from 'node:test';
import { resetMemoryCrmDb, dbWriteKv } from './crm-db.js';
import { fixtureDiscoveredLead, buildLeadQueue } from './lead-queue.js';
import { runMarketingTick, readMarketingState, MARKETING_STATE, updateMarketingControl, renderMarketingEmail, type MarketingDeps, type MarketingEnv } from './marketing-automation.js';
import { handleSendControlsAction } from './outreach-studio-api.js';
import { readSendQueue } from './send-controls.js';
import { buildUnsubscribeUrl } from './outreach-policy.js';
import { verifyUnsubscribeToken } from './unsubscribe.js';
import { GRAPH_TOKEN_KV, saveGraphTokens, resolveAccessToken, importGraphReplies } from './graph-sender.js';

const env: MarketingEnv = { CRM_DATABASE_MEMORY:'1', CRM_DATABASE_URL:'memory://marketing-tests', MARKETING_AUTOMATION_ENABLED:'true',
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
test('dry-run safety stays enabled while draft-only marketing prepares review copy',async()=>{
  const h=await harness();const result=await runMarketingTick({...env,EMAIL_DRY_RUN:'true'},h.deps,now);
  assert.equal(result.status,'AWAITING_APPROVAL');assert.equal(result.transmitted,0);assert.equal(h.sends(),0);
  assert.equal((await readMarketingState(env)).drafts?.length,1);
});
test('configured live campaign only drafts, repeated and concurrent ticks never transmit',async()=>{
  const h=await harness();await Promise.all([runMarketingTick(env,h.deps,now),runMarketingTick(env,h.deps,now)]);
  await runMarketingTick(env,h.deps,now+1800000);
  const state=await readMarketingState(env);
  assert.equal(h.sends(),0);assert.equal(state.attempts.length,0);assert.equal(state.drafts?.length,1);
  assert.equal(state.drafts?.[0]?.status,'DRAFT');assert.match(state.drafts![0]!.body,/three-page.*\$2,000/);
});
test('failed inbox, wrong sender or unavailable calendar holds preparation',async()=>{
  const h=await harness();h.deps.inbox=async()=>({ok:false,replies:[],optouts:[]});
  assert.equal((await runMarketingTick(env,h.deps,now)).status,'BLOCKED');
  h.deps.inbox=async()=>({ok:true,replies:[],optouts:[]});h.deps.providerReady=async()=>false;
  assert.equal((await runMarketingTick(env,h.deps,now)).status,'BLOCKED');
  h.deps.providerReady=async()=>true;h.deps.bookings=async()=>{throw new Error('offline');};
  assert.equal((await runMarketingTick(env,h.deps,now)).status,'BLOCKED');assert.equal(h.sends(),0);
});
test('reply, optout and booking block new prospect drafts',async()=>{
  for (const kind of ['reply','optout','booking']) {
    resetMemoryCrmDb(env);const h=await harness();
    h.deps.inbox=async()=>({ok:true,replies:kind==='reply'?[h.item.email]:[],optouts:kind==='optout'?[h.item.email]:[]});
    h.deps.bookings=async()=>kind==='booking'?[h.item.email]:[];
    await runMarketingTick(env,h.deps,now);
    assert.equal((await readMarketingState(env)).drafts?.length || 0,0);assert.equal(h.sends(),0);
  }
});
async function historical(h:Awaited<ReturnType<typeof harness>>,age=7*86400000) {
  await runMarketingTick(env,h.deps,now-age);
  const state=await readMarketingState(env);const draft=state.drafts![0]!;
  state.drafts=[];state.attempts=[{...draft,status:'SUBMITTED',providerId:'historical-provider-id',receipt:'DELIVERED'}];
  await dbWriteKv(MARKETING_STATE,state,env);return state;
}
test('follow-up is draft only and still requires delivered receipt and due date',async()=>{
  const h=await harness();await historical(h);
  await runMarketingTick(env,h.deps,now);await runMarketingTick(env,h.deps,now+1800000);
  const state=await readMarketingState(env);assert.equal(h.sends(),0);assert.equal(state.attempts.length,1);
  assert.equal(state.drafts?.length,1);assert.equal(state.drafts?.[0]?.step,1);
});
test('unknown, failed and uncertain historical outcomes hold for reconciliation',async()=>{
  for(const kind of ['UNKNOWN','COMPLAINED','CLAIMED']) {
    resetMemoryCrmDb(env);const h=await harness();const state=await historical(h);
    if(kind==='CLAIMED')state.attempts[0]!.status='CLAIMED';
    else state.attempts[0]!.receipt=kind as 'UNKNOWN'|'COMPLAINED';
    await dbWriteKv(MARKETING_STATE,state,env);h.deps.receipt=async()=>kind==='COMPLAINED'?'COMPLAINED':'UNKNOWN';
    assert.equal((await runMarketingTick(env,h.deps,now)).status,'BLOCKED');assert.equal(h.sends(),0);
  }
});
test('owner pause and confirmed-client capacity stop new drafts',async()=>{
  const h=await harness();await updateMarketingControl(env,{paused:true});await runMarketingTick(env,h.deps,now);
  assert.equal((await readMarketingState(env)).drafts?.length || 0,0);
  await updateMarketingControl(env,{paused:false});
  for(let i=0;i<5;i++)await updateMarketingControl(env,{client_email:`client${i}@example.com`,evidence:'Owner verified payment'});
  assert.equal((await runMarketingTick(env,h.deps,now)).status,'COMPLETE');assert.equal(h.sends(),0);
});
test('routine reply prepares one deduplicated draft without claiming a customer',async()=>{
  const h=await harness();await historical(h);
  h.deps.inbox=async()=>({ok:true,replies:[h.item.email],optouts:[],messages:[{id:'in1',email:h.item.email,subject:'Re: website',text:'Yes, send an outline please',receivedAt:new Date(now-1000).toISOString(),automated:false}]});
  await runMarketingTick(env,h.deps,now);await runMarketingTick(env,h.deps,now+1800000);
  const state=await readMarketingState(env);assert.equal(h.sends(),0);assert.equal(state.clients.length,0);
  assert.equal(state.drafts?.length,1);assert.equal(state.drafts![0]!.replyTo,'in1');
});
test('explicit acceptance creates a handoff, never a confirmed paid client',async()=>{
  const h=await harness();await historical(h);
  const text='I accept the three-page informational website for $2,000.\nReady to start: Yes\nBusiness: Test Salon\nThree pages: Home, Services, Contact\nContact name: Alex Smith\nAssets: Logo and photos available, text missing';
  h.deps.inbox=async()=>({ok:true,replies:[h.item.email],optouts:[],messages:[{id:'in2',email:h.item.email,subject:'Re',text,receivedAt:new Date(now-1000).toISOString(),automated:false}]});
  await runMarketingTick(env,h.deps,now);await runMarketingTick(env,h.deps,now+1800000);
  const state=await readMarketingState(env);assert.equal(state.clients.length,0);assert.equal(state.conversations?.[0]?.status,'READY');assert.equal(h.sends(),0);
});
test('receipt inspection is read-only and never invokes the sender',async()=>{
  const h=await harness();await historical(h);
  const before=JSON.stringify(await readMarketingState(env));
  const result=await checkMarketingReceipts(env,{providerReady:async()=>true,receipt:async()=> 'DELIVERED'});
  assert.equal(result.transmitted,0);assert.equal(result.receipts.length,1);
  assert.equal(JSON.stringify(await readMarketingState(env)),before);assert.equal(h.sends(),0);
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
