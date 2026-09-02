import { createHmac, timingSafeEqual } from 'node:crypto';
import { loadEnv } from './env';

loadEnv();

export const ADMIN_COOKIE = 'bbls_admin_session';

export function adminEmail() {
  return (process.env.ADMIN_EMAIL || 'admin@bbls.studio').toLowerCase();
}

export function adminPassword() {
  return process.env.ADMIN_PASSWORD || 'S@f@1371';
}

export function adminName() {
  return process.env.ADMIN_NAME || 'BBLS Studio';
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function matchAdmin(email: string | undefined, password: string | undefined) {
  return safeEqual((email || '').trim().toLowerCase(), adminEmail()) && safeEqual(password || '', adminPassword());
}

function secret() {
  return process.env.SESSION_SECRET || 'bbls-local-dev-session-secret-not-for-production';
}

export function signAdminToken() {
  const exp = Date.now() + 12 * 60 * 60 * 1000;
  const body = Buffer.from(JSON.stringify({ k: 'admin-v2', e: adminEmail(), exp })).toString('base64url');
  const sig = createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function readAdminToken(token: string | undefined | null) {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret()).update(body).digest('base64url');
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

export function adminFromRequest(request: Request) {
  return readAdminToken(cookieFromHeader(request.headers.get('cookie') || '', ADMIN_COOKIE));
}

export function adminCookieHeader(token: string, clear = false) {
  const secure = Boolean(process.env.VERCEL) || (process.env.APP_ORIGIN || '').startsWith('https');
  const base = `${ADMIN_COOKIE}=${clear ? '' : encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`;
  const age = clear ? 'Max-Age=0' : `Max-Age=${12 * 3600}`;
  return `${base}; ${age}${secure ? '; Secure' : ''}`;
}

export function vercelSampleProjects() {
  return [
    {
      id: process.env.PORTAL_TEST_PROJECT_ID || 'prj_7mKq9pR2xW4nV8sL',
      name: 'Northshore Botanica Brand & Website Launch',
      status: 'proposal_ready',
      company_name: 'Northshore Botanica',
      contact_name: 'Elena Voss',
      email: 'elena@northshore-botanica.example',
    },
  ];
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'X-Robots-Tag': 'noindex, nofollow',
      ...headers,
    },
  });
}
