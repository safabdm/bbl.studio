import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  adminCredentialsConfigured,
  adminEmail,
  adminPassword,
  isHostedRuntime,
  matchAdmin,
  readAdminToken,
  signAdminToken,
} from './admin-auth';

const DEV_EMAIL = 'admin@bbls.studio';
const DEV_PASSWORD = 'S@f@1371';
const DEV_SESSION = 'bbls-local-dev-session-secret-not-for-production';

describe('api admin auth production safety', () => {
  it('treats Vercel as hosted', () => {
    assert.equal(isHostedRuntime({ VERCEL: '1' }), true);
    assert.equal(isHostedRuntime({ NODE_ENV: 'production' }), true);
    assert.equal(isHostedRuntime({}), false);
  });

  it('allows documented local defaults only off hosted runtimes', () => {
    const local = {};
    assert.equal(adminEmail(local), DEV_EMAIL);
    assert.equal(adminPassword(local), DEV_PASSWORD);
    assert.equal(
      matchAdmin(DEV_EMAIL, DEV_PASSWORD, {
        ADMIN_EMAIL: DEV_EMAIL,
        ADMIN_PASSWORD: DEV_PASSWORD,
        SESSION_SECRET: DEV_SESSION,
      }),
      true,
    );
  });

  it('never falls back to example defaults on Vercel when env is unset', () => {
    const hosted = { VERCEL: '1' };
    assert.equal(adminEmail(hosted), '');
    assert.equal(adminPassword(hosted), '');
    assert.equal(adminCredentialsConfigured(hosted), false);
    assert.equal(matchAdmin(DEV_EMAIL, DEV_PASSWORD, hosted), false);
  });

  it('rejects example default password/session even if set on Vercel', () => {
    const misconfigured = {
      VERCEL: '1',
      ADMIN_EMAIL: DEV_EMAIL,
      ADMIN_PASSWORD: DEV_PASSWORD,
      SESSION_SECRET: DEV_SESSION,
    };
    assert.equal(adminCredentialsConfigured(misconfigured), false);
    assert.equal(matchAdmin(DEV_EMAIL, DEV_PASSWORD, misconfigured), false);
    assert.equal(adminPassword(misconfigured), '');
  });

  it('accepts unique hosted credentials', () => {
    const hosted = {
      VERCEL: '1',
      ADMIN_EMAIL: 'owner@bbl.studio',
      ADMIN_PASSWORD: 'unique-production-password-not-example',
      SESSION_SECRET: 'unique-production-session-secret-hex',
    };
    assert.equal(adminCredentialsConfigured(hosted), true);
    assert.equal(matchAdmin('owner@bbl.studio', 'unique-production-password-not-example', hosted), true);
    assert.equal(matchAdmin(DEV_EMAIL, DEV_PASSWORD, hosted), false);
    const token = signAdminToken(hosted);
    assert.ok(readAdminToken(token, hosted));
    assert.equal(readAdminToken(token, { ...hosted, SESSION_SECRET: 'other-secret' }), null);
  });

  it('missing config fails closed without throwing on match/read', () => {
    const hosted = { VERCEL: '1' };
    assert.equal(matchAdmin('anyone@example.com', 'nope', hosted), false);
    assert.equal(readAdminToken('not.a.token', hosted), null);
  });
});
