import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { authorizeCrmSync, crmSyncSecret } from './crm-sync-auth';

describe('api crm-sync-auth', () => {
  it('returns 503 when secret is unset', () => {
    const result = authorizeCrmSync({}, {});
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 503);
  });

  it('returns 401 for missing or wrong credentials when secret is set', () => {
    const env = { CRM_SYNC_SECRET: 'test-crm-sync-secret-value' };
    assert.equal(crmSyncSecret(env), 'test-crm-sync-secret-value');
    const missing = authorizeCrmSync({}, env);
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.status, 401);
    const wrong = authorizeCrmSync({ authorization: 'Bearer wrong' }, env);
    assert.equal(wrong.ok, false);
    if (!wrong.ok) assert.equal(wrong.status, 401);
  });

  it('accepts bearer and header keys', () => {
    const env = { CRM_SYNC_SECRET: 'test-crm-sync-secret-value' };
    assert.equal(authorizeCrmSync({ authorization: 'Bearer test-crm-sync-secret-value' }, env).ok, true);
    assert.equal(authorizeCrmSync({ 'x-bbl-crm-sync-key': 'test-crm-sync-secret-value' }, env).ok, true);
  });
});
