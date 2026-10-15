/**
 * Local Hono / Node server entry for admin auth.
 * Logic lives in `api/admin-auth.ts` so Vercel API functions never import
 * `server/env.ts` (`import.meta.url`) via this module.
 */
import { loadEnv } from './env';

loadEnv();

export {
  ADMIN_COOKIE,
  type AdminAuthEnv,
  adminCredentialsConfigured,
  adminEmail,
  adminPassword,
  adminName,
  isHostedRuntime,
  matchAdmin,
  signAdminToken,
  readAdminToken,
  cookieFromHeader,
  adminFromRequest,
  adminCookieHeader,
} from '../api/admin-auth';
