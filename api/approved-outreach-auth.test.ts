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
