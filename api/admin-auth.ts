/**
 * Fail-closed admin auth for Vercel serverless API handlers.
 * Intentionally lives under `api/` with no import of `server/env`
 * (which uses `import.meta.url` and breaks function cold-start).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const ADMIN_COOKIE = 'bbls_admin_session';

/**
 * Documented local-only defaults from `.env.example`.
 * Hosted runtimes (Vercel / NODE_ENV=production) must never fall back to these
 * and must never accept them even if mis-copied into project env.
 */
const DEV_ADMIN_EMAIL = 'admin@bbls.studio';
const DEV_ADMIN_PASSWORD = 'S@f@1371';
const DEV_SESSION_SECRET = 'bbls-local-dev-session-secret-not-for-production';

export type AdminAuthEnv = {
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD?: string;
  ADMIN_NAME?: string;
  SESSION_SECRET?: string;
  VERCEL?: string;
  NODE_ENV?: string;
  APP_ORIGIN?: string;
};

export function isHostedRuntime(env: AdminAuthEnv = process.env): boolean {
  return Boolean(env.VERCEL) || env.NODE_ENV === 'production';
}

function trim(value: string | undefined): string {
  return (value || '').trim();
}

/** True when admin email/password/session secret are set and safe for this runtime. */
export function adminCredentialsConfigured(env: AdminAuthEnv = process.env): boolean {
  const email = trim(env.ADMIN_EMAIL).toLowerCase();
  const password = trim(env.ADMIN_PASSWORD);
  const session = trim(env.SESSION_SECRET);
  if (!email || !password || !session) return false;
  if (isHostedRuntime(env)) {
    if (password === DEV_ADMIN_PASSWORD) return false;
    if (session === DEV_SESSION_SECRET) return false;
  }
  return true;
}

export function adminEmail(env: AdminAuthEnv = process.env): string {
  const fromEnv = trim(env.ADMIN_EMAIL).toLowerCase();
  if (fromEnv) return fromEnv;
  if (isHostedRuntime(env)) return '';
  return DEV_ADMIN_EMAIL;
}

export function adminPassword(env: AdminAuthEnv = process.env): string {
  const fromEnv = trim(env.ADMIN_PASSWORD);
  if (fromEnv) {
    if (isHostedRuntime(env) && fromEnv === DEV_ADMIN_PASSWORD) return '';
    return fromEnv;
  }
  if (isHostedRuntime(env)) return '';
  return DEV_ADMIN_PASSWORD;
}

export function adminName(env: AdminAuthEnv = process.env): string {
  return trim(env.ADMIN_NAME) || 'BBL Studio';
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function matchAdmin(
  email: string | undefined,
  password: string | undefined,
  env: AdminAuthEnv = process.env,
): boolean {
  if (!adminCredentialsConfigured(env)) return false;
  const expectedEmail = adminEmail(env);
  const expectedPassword = adminPassword(env);
  if (!expectedEmail || !expectedPassword) return false;
  return (
    safeEqual((email || '').trim().toLowerCase(), expectedEmail) &&
    safeEqual(password || '', expectedPassword)
  );
}

function secret(env: AdminAuthEnv = process.env): string {
  const fromEnv = trim(env.SESSION_SECRET);
  if (fromEnv) {
    if (isHostedRuntime(env) && fromEnv === DEV_SESSION_SECRET) return '';
    return fromEnv;
  }
  if (isHostedRuntime(env)) return '';
  return DEV_SESSION_SECRET;
}

export function signAdminToken(env: AdminAuthEnv = process.env) {
  const sessionSecret = secret(env);
  if (!sessionSecret) {
    throw new Error('SESSION_SECRET is not configured for this host.');
  }
  const exp = Date.now() + 12 * 60 * 60 * 1000;
  const body = Buffer.from(JSON.stringify({ k: 'admin-v2', e: adminEmail(env), exp })).toString('base64url');
  const sig = createHmac('sha256', sessionSecret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function readAdminToken(token: string | undefined | null, env: AdminAuthEnv = process.env) {
  if (!token) return null;
  const sessionSecret = secret(env);
  if (!sessionSecret) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', sessionSecret).update(body).digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString()) as { k?: string; e?: string; exp?: number };
    if (data.k !== 'admin-v2' || typeof data.exp !== 'number' || Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

export function cookieFromHeader(header: string | undefined, name: string) {
  if (!header) return '';
  const match = header.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : '';
}

export function adminFromRequest(request: Request, env: AdminAuthEnv = process.env) {
  return readAdminToken(cookieFromHeader(request.headers.get('cookie') || '', ADMIN_COOKIE), env);
}

export function adminCookieHeader(token: string, clear = false, env: AdminAuthEnv = process.env) {
  const secure = Boolean(env.VERCEL) || (env.APP_ORIGIN || '').startsWith('https');
  const base = `${ADMIN_COOKIE}=${clear ? '' : encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`;
  const age = clear ? 'Max-Age=0' : `Max-Age=${12 * 3600}`;
  return `${base}; ${age}${secure ? '; Secure' : ''}`;
}
