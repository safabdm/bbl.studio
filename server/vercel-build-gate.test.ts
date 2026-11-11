import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
void test('Vercel preview guard fits the schema and never skips production main',()=>{
 const {ignoreCommand}=JSON.parse(readFileSync(new URL('../vercel.json',import.meta.url),'utf8')) as {ignoreCommand:string};
 assert.ok(ignoreCommand.length<=256,'Vercel ignoreCommand permits at most 256 characters');
 for(const [branch,status] of [['main',1],['codex/unrelated-work',1],['codex/autonomous-growth-agency',0],['codex/lead-contact-quality',0],['codex/approved-five-outreach',0],['codex/approved-five-server-dispatch',0]] as const){
  assert.equal(spawnSync('sh',['-c',ignoreCommand],{env:{...process.env,VERCEL_GIT_COMMIT_REF:branch}}).status,status,branch);
 }
});
