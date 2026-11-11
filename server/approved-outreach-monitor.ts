/** Receipt/reply refresh for the configured five-message batch. No sender is imported. */
import { createHash } from 'node:crypto';
import { acquireCrmLease, releaseCrmLease, dbReadKv, dbWriteKv } from './crm-db.js';
import { readConfiguredApprovedBatch, type ApprovedBatchEnv } from './approved-outreach-batch.js';
import { MARKETING_LEASE, MARKETING_STATE, marketingReadServices, readMarketingState, type MarketingDeps, type MarketingAttempt } from './marketing-automation.js';
import { planMarketingReply, isMarketingOptOut, type MarketingMessage } from './marketing-conversation.js';
import { complianceFooter } from './outreach-policy.js';
import { readSnapshot, emptySnapshot, writeSnapshot, computeOverviewFromLeads, upsertEmailHistory } from './crm-sync-store.js';
import { recordDurableSuppression } from './crm-suppressions.js';

type ReadServices=Pick<MarketingDeps,'providerReady'|'inbox'|'receipt'>;
type Receipt=MarketingAttempt['receipt'];
const normalizeSubject=(s:string)=>s.replace(/^(?:(?:re|fw|fwd):\s*)+/ig,'').trim().toLowerCase();
export async function monitorApprovedOutreach(env:ApprovedBatchEnv, injected?:ReadServices) {
 const batch=await readConfiguredApprovedBatch(env);
 const lease=await acquireCrmLease(MARKETING_LEASE,env,300);
 if(!lease)throw new Error('Outreach checks busy; retry monitoring later.');
 try{
  const io=injected || marketingReadServices(env);
  if(!await io.providerReady())throw new Error('Verified BBL provider and mailbox identity required.');
  const state=await readMarketingState(env);
  const attempts=batch.entries.map(e=>{
   const a=state.attempts.find(a=>a.providerId===e.provider_id && a.email===e.email && a.status==='SUBMITTED');
   if(e.status!=='ACCEPTED' || !e.provider_id || !a)throw new Error('Accepted batch/CRM receipt mismatch.');
   return a;
  });
  const checkedAt=new Date().toISOString();
  const inbox=await io.inbox(new Set(attempts.map(a=>a.email)),new Set(attempts.map(a=>a.providerId!)));
  const receipts:Array<{email:string;business:string;provider_id:string;receipt:Receipt;error?:string}>=[];
  const errors:string[]=[];
  for(const a of attempts){
   try{
    if(!injected)await new Promise(resolve=>setTimeout(resolve,650));
    const receipt=await io.receipt(a);
    if(receipt!=='UNKNOWN')a.receipt=receipt;
    a.checkedAt=checkedAt;
    receipts.push({email:a.email,business:a.business,provider_id:a.providerId!,receipt:a.receipt});
    if(['BOUNCED','COMPLAINED','FAILED'].includes(a.receipt)){
     await recordDurableSuppression(a.email,0,a.receipt.toLowerCase(),env);
     state.stoppedEmails=[...new Set([...state.stoppedEmails,a.email])];
    }
   }catch{
    receipts.push({email:a.email,business:a.business,provider_id:a.providerId!,receipt:a.receipt,error:'Provider receipt lookup failed; no new delivery claim.'});errors.push(`receipt:${a.email}`);
   }
  }
  const inbound:Array<{message:MarketingMessage;original:MarketingAttempt;thread_matched:boolean}>=[];
  if(inbox.ok){
   for(const message of inbox.messages || []){
    const original=attempts.find(a=>(a.email===message.email || Boolean(message.inReplyTo?.includes(a.providerId!))) && Date.parse(message.receivedAt)>=Date.parse(a.claimedAt));
    if(!original)continue;
    const thread_matched=Boolean(message.inReplyTo?.includes(original.providerId!)) || normalizeSubject(message.subject)===normalizeSubject(original.subject);
    inbound.push({message,original,thread_matched});
    state.stoppedEmails=[...new Set([...state.stoppedEmails,original.email])];
    if(!message.automated && isMarketingOptOut(message.text))await recordDurableSuppression(original.email,0,'reply_optout',env);
   }
   state.inbound=[...new Map([...(state.inbound || []),...inbound.map(r=>({...r.message,threadMatched:r.thread_matched}))].map(m=>[m.id,m])).values()];
  }else errors.push('reply_scan_incomplete');
  const old=await dbReadKv<{drafts?:Array<{reply_to:string}>}|null>(`outreach:approved-monitor:${batch.digest}`,null,env);
  const drafts:Array<{reply_to:string;to:string;subject:string;body:string;approved:false;thread_matched:boolean}>=[];
  // Only the newest human message per recipient receives a review draft.
  const latest=[...inbound].filter(r=>!r.message.automated).sort((a,b)=>Date.parse(b.message.receivedAt)-Date.parse(a.message.receivedAt));
  const seen=new Set<string>();
  for(const r of latest){
   if(seen.has(r.original.email))continue;seen.add(r.original.email);
   const plan=planMarketingReply(r.message);if(!plan)continue;
   const subject=`Re: ${r.original.subject.replace(/^Re:\s*/i,'')}`;
   const body=plan.body+'\n'+complianceFooter({email:r.message.email,leadId:r.original.leadId,env});
   drafts.push({reply_to:r.message.id,to:r.message.email,subject,body,approved:false,thread_matched:r.thread_matched});
   state.drafts ||= [];
   if(!state.drafts.some(d=>d.replyTo===r.message.id))state.drafts.push({id:`review_${createHash('sha256').update(r.message.id).digest('hex').slice(0,24)}`,leadId:r.original.leadId,email:r.message.email,business:r.original.business,domain:r.original.domain,replyTo:r.message.id,step:0,claimedAt:checkedAt,subject,body,status:'DRAFT',providerId:null,receipt:'UNKNOWN',checkedAt:null});
  }
  const snap=(await readSnapshot(env)) || emptySnapshot();
  for(const a of attempts){
   const prior=snap.email_history.find(h=>h.provider_message_id===a.providerId);
   const replied=inbound.some(r=>r.original.providerId===a.providerId && r.thread_matched && !r.message.automated);
   snap.email_history=upsertEmailHistory(snap.email_history,{...prior,id:prior?.id || `resend:${a.providerId}`,lead_id:a.leadId,email:a.email,business_name:a.business,subject:a.subject,provider_message_id:a.providerId,status:a.receipt==='UNKNOWN'?'SENT':a.receipt,dry_run:false,accepted:'YES',delivered:a.receipt==='DELIVERED'?'YES':['BOUNCED','FAILED'].includes(a.receipt)?'NO':prior?.delivered || 'UNKNOWN',bounced:a.receipt==='BOUNCED'?'YES':prior?.bounced || 'UNKNOWN',replied:replied?'YES':prior?.replied || 'UNKNOWN',sent_at:a.claimedAt});
   snap.leads=snap.leads.map(l=>l.email?.toLowerCase()===a.email?{...l,delivered:a.receipt==='DELIVERED'?'YES':l.delivered,bounced:a.receipt==='BOUNCED'?'YES':l.bounced,replied:replied?'YES':l.replied}:l);
  }
  for(const r of inbound){if(!r.message.automated && r.thread_matched && !snap.inbox.some(m=>m.id===`graph_${r.message.id}`))snap.inbox.push({id:`graph_${r.message.id}`,from_email:r.message.email,lead_id:r.original.leadId,subject:r.message.subject,snippet:r.message.text.slice(0,1000),received_at:r.message.receivedAt,source:'unknown'});}
  snap.overview=computeOverviewFromLeads(snap.leads,snap.email_history);
  await writeSnapshot(snap,env);
  await dbWriteKv(MARKETING_STATE,state,env);
  const report={ok:errors.length===0,checked_at:checkedAt,digest:batch.digest,transmitted:0,published:0,crm_recorded:true,reply_scan_complete:inbox.ok,receipts,replies:inbound.map(r=>({original_recipient:r.original.email,thread_matched:r.thread_matched,...r.message})),drafts,previous_draft_count:old?.drafts?.length || 0,errors};
  await dbWriteKv(`outreach:approved-monitor:${batch.digest}`,report,env);
  return report;
 }finally{await releaseCrmLease(MARKETING_LEASE,lease,env);}
}
