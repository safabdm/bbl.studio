import assert from 'node:assert/strict';
import {test,afterEach} from 'node:test';
import {dbWriteKv,resetMemoryCrmDb} from './crm-db.js';
import {approvedBatchDigest,recordApprovedAccepted,type ApprovedBatchEnv} from './approved-outreach-batch.js';
import {monitorApprovedOutreach} from './approved-outreach-monitor.js';
import {readMarketingState,type MarketingDeps} from './marketing-automation.js';
import {readSnapshot} from './crm-sync-store.js';
import {isEmailDurablySuppressed} from './crm-suppressions.js';
const copies=Array.from({length:5},(_,i)=>({lead_id:`lead${i}`,email:`owner${i}@example.org`,subject:`Website idea ${i}`,body:'Approved offer'}));
const digest=approvedBatchDigest(copies);
const env:ApprovedBatchEnv={CRM_DATABASE_URL:'memory://monitor',CRM_DATABASE_MEMORY:'1',OWNER_APPROVED_OUTREACH_SHA256:digest,UNSUBSCRIBE_SECRET:'test-only',BUSINESS_POSTAL_ADDRESS:'Test address',APP_ORIGIN:'https://www.bbl.studio'};
afterEach(()=>resetMemoryCrmDb(env));
async function seed(){
 const at='2026-11-11T10:26:27Z';
 await dbWriteKv(`outreach:approved-batch:${digest}`,{digest,entries:copies.map((c,i)=>({...c,status:'ACCEPTED',provider_id:`p${i}`,at}))},env);
 for(let i=0;i<5;i++)await recordApprovedAccepted(copies[i],`p${i}`,at,copies[i].body,env);
}
function reads():Pick<MarketingDeps,'providerReady'|'inbox'|'receipt'>{return {providerReady:async()=>true,inbox:async()=>({ok:true,replies:[],optouts:[],messages:[]}),receipt:async()=> 'DELIVERED'};}
const message={id:'reply1',email:copies[0].email,subject:`Re: ${copies[0].subject}`,text:'Interested. Could you explain the pages?\n\nOn Wednesday wrote:\n> unsubscribe',receivedAt:'2026-11-11T11:00:00Z',automated:false};
void test('five actual receipts persist in CRM without transmission or publishing',async()=>{
 await seed();const r=await monitorApprovedOutreach(env,reads());assert.equal(r.transmitted,0);assert.equal(r.published,0);assert.equal(r.crm_recorded,true);assert.equal(r.receipts.length,5);assert.ok((await readSnapshot(env))!.email_history.every(h=>h.delivered==='YES'));assert.equal(r.drafts.length,0);
});
void test('human reply drafts once; quoted unsubscribe is not an opt-out',async()=>{
 await seed();const io=reads();io.inbox=async()=>({ok:true,replies:[],optouts:[],messages:[message]});
 const r=await monitorApprovedOutreach(env,io);assert.equal(r.drafts.length,1);assert.equal(r.drafts[0].approved,false);assert.equal(r.replies[0].thread_matched,true);assert.equal(await isEmailDurablySuppressed(message.email,env),false);
 await monitorApprovedOutreach(env,io);assert.equal((await readMarketingState(env)).drafts!.length,1);assert.equal((await readSnapshot(env))!.email_history.find(h=>h.email===message.email)!.replied,'YES');
});
void test('incomplete mailbox and receipt errors never become false success',async()=>{
 await seed();const io=reads();io.receipt=async()=>{throw new Error('offline');};io.inbox=async()=>({ok:false,replies:[],optouts:[]});const r=await monitorApprovedOutreach(env,io);assert.equal(r.ok,false);assert.equal(r.reply_scan_complete,false);assert.ok(r.receipts.every(r=>r.receipt==='UNKNOWN'&&r.error));assert.ok((await readSnapshot(env))!.email_history.every(h=>h.delivered==='UNKNOWN'));
});
void test('automatic replies and opt-outs produce no response draft',async()=>{
 await seed();const io=reads();io.inbox=async()=>({ok:true,replies:[],optouts:[],messages:[{...message,automated:true},{...message,id:'optout',email:copies[1].email,subject:`Re: ${copies[1].subject}`,text:'Please remove me.'}]});const r=await monitorApprovedOutreach(env,io);assert.equal(r.drafts.length,0);assert.equal(await isEmailDurablySuppressed(copies[1].email,env),true);assert.notEqual((await readSnapshot(env))!.email_history.find(h=>h.email===message.email)!.replied,'YES');
});
void test('unrelated messages are candidates, not verified thread replies; prior mail excluded',async()=>{
 await seed();const io=reads();io.inbox=async()=>({ok:true,replies:[],optouts:[],messages:[{...message,subject:'Another topic'},{...message,id:'old',receivedAt:'2026-11-01T00:00:00Z'}]});const r=await monitorApprovedOutreach(env,io);assert.equal(r.replies.length,1);assert.equal(r.replies[0].thread_matched,false);assert.notEqual((await readSnapshot(env))!.email_history.find(h=>h.email===message.email)!.replied,'YES');
});
void test('mailbox identity mismatch fails closed',async()=>{await seed();const io=reads();io.providerReady=async()=>false;await assert.rejects(monitorApprovedOutreach(env,io),/identity/);assert.ok((await readSnapshot(env))!.email_history.every(h=>h.delivered==='UNKNOWN'));});
