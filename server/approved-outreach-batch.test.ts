import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { resetMemoryCrmDb } from './crm-db.js';
import { approvedBatchDigest, parseApprovedCopies, runApprovedOutreachBatch, recordApprovedAccepted, type ApprovedCopy, type BatchDeps, type ApprovedBatchEnv } from './approved-outreach-batch.js';
import { readMarketingState } from './marketing-automation.js';
import { readSnapshot } from './crm-sync-store.js';
import { recordAcceptedSendsBatch } from './resend-send.js';
import { readDailyCapState, recordSuccessfulSend } from './daily-cap.js';

const env:ApprovedBatchEnv={CRM_DATABASE_URL:'memory://approved-batch-tests',CRM_DATABASE_MEMORY:'1',RESEND_API_KEY:'test-only',RESEND_FROM:'Business Brand Lab <hello@bbl.studio>',BUSINESS_POSTAL_ADDRESS:'Test studio address',UNSUBSCRIBE_SECRET:'fixture-secret',APP_ORIGIN:'https://www.bbl.studio',EMAIL_OUTREACH_ENABLED:'false',MANUAL_SEND_LIVE_ENABLED:'false'};
afterEach(()=>resetMemoryCrmDb(env));
const copies=():ApprovedCopy[]=>Array.from({length:5},(_,i)=>({lead_id:`official_${i}`,email:`owner${i}@business.example`,subject:`Approved website idea ${i}`,body:'A three-page informational website for $2,000. Owner-approved exact copy.'}));
const ready=()=>({...env,OWNER_APPROVED_OUTREACH_SHA256:approvedBatchDigest(copies())});
function mockIO() {
  const sent:Array<{copy:ApprovedCopy;text:string;key:string}>=[];
  const records:string[]=[];
  const io:BatchDeps={
    checks:async()=>({provider_and_bbl_identity:true,full_inbox_read:true,booking_calendar_read:true,history_ready:true,suppressions_read:true,send_health_ready:true}),
    eligible:async()=>true,
    send:async(copy,text,key)=>{sent.push({copy,text,key});return {ok:true,id:`provider-${sent.length}`,message:'accepted'};},
    record:async(copy,id,at)=>{records.push(id);await recordAcceptedSendsBatch([{lead_id:copy.lead_id,email:copy.email,subject:copy.subject,campaign_name:'test exact approval',provider_message_id:id,sent_at:at}],env);},
  };
  return {io,sent,records};
}
void test('preparation never transmits, and unset manifest capability blocks live sending',async()=>{
  const m=mockIO();const p=await runApprovedOutreachBatch({messages:copies()},env,m.io);
  assert.equal(p.transmitted,0);assert.equal(m.sent.length,0);
  await assert.rejects(runApprovedOutreachBatch({messages:copies(),confirm_send:true},env,m.io),/not enabled/);
  assert.equal(m.sent.length,0);
});
void test('exact five send once, include signed recipient footers, and record acceptance without claiming delivery',async()=>{
  const m=mockIO();const r=await runApprovedOutreachBatch({messages:copies(),confirm_send:true},ready(),m.io);
  assert.equal(r.transmitted,5);assert.equal(m.sent.length,5);
  for(const s of m.sent){assert.ok(s.text.startsWith(s.copy.body));assert.match(s.text,/Test studio address/);assert.match(s.text,/lead_id=\d+&token=[a-f0-9]+/);assert.ok(s.text.includes(encodeURIComponent(s.copy.email)));}
  const history=(await readSnapshot(env))!.email_history;assert.equal(history.length,5);
  assert.ok(history.every(h=>h.accepted==='YES'&&h.delivered==='UNKNOWN'&&h.provider_message_id));
  const again=await runApprovedOutreachBatch({messages:copies(),confirm_send:true},ready(),m.io);assert.equal(again.transmitted,0);assert.equal(m.sent.length,5);
  assert.equal((await readDailyCapState(env)).sent_today,5);
});
void test('changed subject, body, or recipient cannot use the enabled fingerprint',async()=>{
  for(const field of ['body','subject','email'] as const){const rows=copies();rows[0][field]+='changed';if(field==='email')rows[0].email='another@business.example';const m=mockIO();await assert.rejects(runApprovedOutreachBatch({messages:rows,confirm_send:true},ready(),m.io),/not enabled/);assert.equal(m.sent.length,0);}
});
void test('rejects oversized and duplicate batches before any provider work',()=>{
  assert.throws(()=>parseApprovedCopies([...copies(),copies()[0]]),/one and five/);
  assert.throws(()=>parseApprovedCopies([copies()[0],copies()[0]]),/Duplicate/);
  assert.throws(()=>parseApprovedCopies([{...copies()[0],subject:'Header\r\nInjected'}]),/Invalid/);
});
void test('failed fresh integration checks block all sends',async()=>{
  const m=mockIO();m.io.checks=async()=>({provider_and_bbl_identity:true,full_inbox_read:false,booking_calendar_read:true,history_ready:false,suppressions_read:true,send_health_ready:true});
  const r=await runApprovedOutreachBatch({messages:copies(),confirm_send:true},ready(),m.io);assert.equal(r.ok,false);assert.equal(m.sent.length,0);
});
void test('live recipient eligibility is rechecked and suppressed recipients never transmit',async()=>{
  const m=mockIO();m.io.eligible=async c=>c.email!==copies()[2].email;
  const r=await runApprovedOutreachBatch({messages:copies(),confirm_send:true},ready(),m.io);
  assert.equal(r.transmitted,4);assert.ok(!m.sent.some(s=>s.copy.email===copies()[2].email));
});
void test('unknown provider result stops the batch and never retries on replay',async()=>{
  const m=mockIO();let attempts=0;m.io.send=async()=>{attempts++;throw new Error('timeout after possible acceptance');};
  const r=await runApprovedOutreachBatch({messages:copies(),confirm_send:true},ready(),m.io);assert.equal(r.transmitted,0);assert.equal(attempts,1);assert.equal(r.batch.entries[0].status,'UNCERTAIN');
  const again=await runApprovedOutreachBatch({messages:copies(),confirm_send:true},ready(),m.io);assert.equal(again.ok,false);assert.equal(attempts,1);assert.equal((await readDailyCapState(env)).sent_today,1);
});
void test('accepted provider result survives CRM write interruption without another transmission',async()=>{
  const m=mockIO();const record=m.io.record.bind(m.io);let fail=true;m.io.record=async(...args)=>{if(fail){fail=false;throw new Error('CRM interrupted');}return record(...args);};
  await assert.rejects(runApprovedOutreachBatch({messages:copies(),confirm_send:true},ready(),m.io),/CRM interrupted/);assert.equal(m.sent.length,1);
  await runApprovedOutreachBatch({messages:copies(),confirm_send:true},ready(),m.io);assert.equal(m.sent.length,5);assert.equal(new Set(m.sent.map(s=>s.copy.email)).size,5);assert.equal((await readSnapshot(env))!.email_history.length,5);
});
void test('daily cap and other live-path switches fail closed',async()=>{
  const m=mockIO();await recordSuccessfulSend(18,env);
  await assert.rejects(runApprovedOutreachBatch({messages:copies(),confirm_send:true},ready(),m.io),/cap insufficient/);
  await assert.rejects(runApprovedOutreachBatch({messages:copies(),confirm_send:true},{...ready(),MANUAL_SEND_LIVE_ENABLED:'true'},m.io),/remain off/);assert.equal(m.sent.length,0);
});
void test('a different enabled manifest still cannot re-send already claimed recipients',async()=>{
 const m=mockIO();await runApprovedOutreachBatch({messages:copies(),confirm_send:true},ready(),m.io);
 const changed=copies().map(c=>({...c,subject:c.subject+' revised'}));
 const r=await runApprovedOutreachBatch({messages:changed,confirm_send:true},{...env,OWNER_APPROVED_OUTREACH_SHA256:approvedBatchDigest(changed)},m.io);
 assert.equal(r.transmitted,0);assert.equal(m.sent.length,5);
});
void test('actual receipt persistence appears in both CRM history and campaign monitoring once',async()=>{
 const copy=copies()[0],at=new Date().toISOString();
 await recordApprovedAccepted(copy,'verified-provider-id',at,'Exact transmitted body with footer',env);
 await recordApprovedAccepted(copy,'verified-provider-id',at,'Exact transmitted body with footer',env);
 const state=await readMarketingState(env);assert.equal(state.attempts.length,1);assert.equal(state.attempts[0].providerId,'verified-provider-id');assert.equal(state.attempts[0].receipt,'UNKNOWN');assert.equal(state.attempts[0].body,'Exact transmitted body with footer');
 assert.equal((await readSnapshot(env))!.email_history.length,1);
});
