import {test} from 'node:test';
import assert from 'node:assert/strict';
import {legacyHistoryReady,retireLegacySource,readLegacyBaseline} from './marketing-legacy-baseline.js';
const now=Date.parse('2026-11-05T22:00:00Z'),at='2026-11-01T22:00:00Z';
test('stale history needs a matching retired-source baseline, never an invented fresh timestamp',()=>{
  const baseline={snapshot_synced_at:at,source_db_sha256:'a'.repeat(64),retired_at:'2026-11-01T22:01:00Z',legacy_sender_disabled:true as const};
  assert.equal(legacyHistoryReady(at,null,now),false);
  assert.equal(legacyHistoryReady(at,baseline,now),true);
  assert.equal(legacyHistoryReady('2026-11-02T22:00:00Z',baseline,now),false);
  assert.equal(legacyHistoryReady('2026-11-06T22:00:00Z',baseline,now),false);
});
test('retirement rejects an active sender and stores source fingerprint after fresh import',async()=>{
  const env={CRM_DATABASE_MEMORY:'1',CRM_DATABASE_URL:'memory://legacy-test'};
  const body={source_db_sha256:'b'.repeat(64),legacy_sender_disabled:true,active_legacy_processes:0};
  await assert.rejects(retireLegacySource({...body,active_legacy_processes:1},new Date().toISOString(),env));
  await retireLegacySource(body,new Date().toISOString(),env);
  assert.equal((await readLegacyBaseline(env))?.source_db_sha256,body.source_db_sha256);
});
