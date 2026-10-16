import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  adminCredentialsConfigured,
  isHostedRuntime,
  matchAdmin,
} from './admin-auth';

const DEV_EMAIL = 'hello@bbl.studio';
const DEV_PASSWORD = 'S@f@1371';
const DEV_SESSION = 'bbls-local-dev-session-secret-not-for-production';

describe('server admin-auth re-export', () => {
  it('re-exports fail-closed hosted helpers', () => {
    assert.equal(isHostedRuntime({ VERCEL: '1' }), true);
    assert.equal(
      adminCredentialsConfigured({
        VERCEL: '1',
        ADMIN_EMAIL: DEV_EMAIL,
        ADMIN_PASSWORD: DEV_PASSWORD,
        SESSION_SECRET: DEV_SESSION,
      }),
      false,
    );
    assert.equal(matchAdmin(DEV_EMAIL, DEV_PASSWORD, { VERCEL: '1' }), false);
  });
});
