import {dbReadKv,dbWriteKv,type CrmDbEnv} from './crm-db.js';
export const LEGACY_BASELINE_KEY='marketing:retired-legacy-source:v1';
export type LegacyBaseline={snapshot_synced_at:string;source_db_sha256:string;retired_at:string;legacy_sender_disabled:true};
export function legacyHistoryReady(at:string|null|undefined,baseline:LegacyBaseline|null,now=Date.now()) {
  const time=Date.parse(at || '');
  if (!Number.isFinite(time) || time>now) return false;
  return now-time<86400000 || Boolean(baseline?.legacy_sender_disabled===true && /^[a-f0-9]{64}$/.test(baseline.source_db_sha256) && baseline.snapshot_synced_at===at);
}
export function readLegacyBaseline(env:CrmDbEnv) {return dbReadKv<LegacyBaseline|null>(LEGACY_BASELINE_KEY,null,env);}
/** Called only by authenticated owner import after verifying retirement of the old sender. */
export async function retireLegacySource(body:Record<string,unknown>,at:string|null|undefined,env:CrmDbEnv) {
  if (!legacyHistoryReady(at,null) || body.legacy_sender_disabled!==true || body.active_legacy_processes!==0 || !/^[a-f0-9]{64}$/.test(String(body.source_db_sha256 || '')))
    throw new Error('A fresh complete import and verified retired sender are required.');
  const baseline:LegacyBaseline={snapshot_synced_at:at!,source_db_sha256:String(body.source_db_sha256),retired_at:new Date().toISOString(),legacy_sender_disabled:true};
  await dbWriteKv(LEGACY_BASELINE_KEY,baseline,env);
}
