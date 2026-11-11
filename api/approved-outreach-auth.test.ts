import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import handler from './[...route].js';
import { signAdminToken, ADMIN_COOKIE } from './admin-auth.js';
void test('approved-batch upload rejects a foreign origin even with an owner session',async()=>{
 const oldSecret=process.env.SESSION_SECRET,oldAdmin=process.env.ADMIN_EMAIL;
 process.env.SESSION_SECRET='test-only-approved-batch-session-secret';process.env.ADMIN_EMAIL='hello@bbl.studio';
 try {
  const req=Object.assign(Readable.from([JSON.stringify({kind:'owner-approved-outreach',confirm_send:true})]),{url:'/api/admin/crm/history-import',method:'POST',headers:{cookie:`${ADMIN_COOKIE}=${signAdminToken()}`,origin:'https://untrusted.example'}}) as IncomingMessage;
  let status=0;const res={headersSent:false,set statusCode(v:number){status=v;},setHeader(){},end(){}} as unknown as ServerResponse;
  await handler(req,res);assert.equal(status,403);
 }finally{
  if(oldSecret===undefined)delete process.env.SESSION_SECRET;else process.env.SESSION_SECRET=oldSecret;
  if(oldAdmin===undefined)delete process.env.ADMIN_EMAIL;else process.env.ADMIN_EMAIL=oldAdmin;
 }
});
void test('server credential still cannot send a message outside the production-approved fingerprint',async()=>{
 const fields=['CRON_SECRET','CRM_DATABASE_URL','CRM_DATABASE_MEMORY','OWNER_APPROVED_OUTREACH_SHA256'] as const;
 const prior=Object.fromEntries(fields.map(k=>[k,process.env[k]]));
 process.env.CRON_SECRET='test-only-server-batch-secret';process.env.CRM_DATABASE_URL='memory://server-batch-auth';process.env.CRM_DATABASE_MEMORY='1';process.env.OWNER_APPROVED_OUTREACH_SHA256='0'.repeat(64);
 try{
  const payload={confirm_send:true,messages:[{lead_id:'fixture',email:'owner@business.example',subject:'Unapproved',body:'Not the production-approved message'}]};
  const req=Object.assign(Readable.from([Buffer.from(JSON.stringify(payload))]),{url:'/api/crm/approved-outreach/send',method:'POST',headers:{authorization:'Bearer test-only-server-batch-secret'}}) as IncomingMessage;
  let status=0,body='';const res={headersSent:false,set statusCode(v:number){status=v;},setHeader(){},end(v:string){body=v;}} as unknown as ServerResponse;
  await handler(req,res);assert.equal(status,409);assert.match(JSON.parse(body).message,/not enabled/);
 }finally{for(const key of fields){if(prior[key]===undefined)delete process.env[key];else process.env[key]=prior[key];}}
});
