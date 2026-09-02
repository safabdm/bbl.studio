import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const config = { maxDuration: 30 };

const ADMIN_COOKIE = 'bbls_admin_session';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@bbls.studio').toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'S@f@1371';
const ADMIN_NAME = process.env.ADMIN_NAME || 'BBLS Studio';
const SESSION_SECRET = process.env.SESSION_SECRET || 'bbls-local-dev-session-secret-not-for-production';

function same(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieValue(header: string | string[] | undefined, name: string) {
  const raw = Array.isArray(header) ? header.join(';') : header || '';
  const match = raw.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : '';
}

function signAdminToken() {
  const exp = Date.now() + 12 * 60 * 60 * 1000;
  const body = Buffer.from(JSON.stringify({ k: 'admin-v2', e: ADMIN_EMAIL, exp })).toString('base64url');
  const sig = createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function readAdminToken(token: string) {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  if (!same(sig, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString()) as { k?: string; exp?: number };
    if (data.k !== 'admin-v2' || typeof data.exp !== 'number' || Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  for (const [key, value] of Object.entries(extra)) res.setHeader(key, value);
  res.end(JSON.stringify(body));
}

function cookieHeader(token: string, clear = false) {
  const value = clear ? '' : encodeURIComponent(token);
  const age = clear ? 0 : 12 * 3600;
  return `${ADMIN_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${age}`;
}

function readJson(req: IncomingMessage) {
  return new Promise<Record<string, string>>((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    req.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, string>);
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function requestPath(req: IncomingMessage) {
  const raw = req.url || '/';
  try {
    return new URL(raw, 'https://bbls.studio').pathname;
  } catch {
    return raw.split('?')[0] || '/';
  }
}

function matches(path: string, suffix: string) {
  const clean = path.replace(/\/+$/, '') || '/';
  return clean === suffix || clean.endsWith(suffix) || clean.endsWith(suffix.replace(/^\/api/, ''));
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    const path = requestPath(req);
    const method = (req.method || 'GET').toUpperCase();
    const admin = Boolean(readAdminToken(cookieValue(req.headers.cookie, ADMIN_COOKIE)));

    if (matches(path, '/api/health') && method === 'GET') {
      return send(res, 200, { ok: true, stripeMode: process.env.STRIPE_SECRET_KEY ? 'test' : 'mock' });
    }

    if (matches(path, '/api/admin/login') && method === 'POST') {
      const body = await readJson(req);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!same(email, ADMIN_EMAIL) || !same(password, ADMIN_PASSWORD)) {
        return send(res, 401, { ok: false, message: 'Invalid credentials.' });
      }
      return send(res, 200, { ok: true, name: ADMIN_NAME }, { 'Set-Cookie': cookieHeader(signAdminToken()) });
    }

    if (matches(path, '/api/admin/logout') && method === 'POST') {
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader('', true) });
    }

    if (matches(path, '/api/admin/me') && method === 'GET') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      return send(res, 200, {
        ok: true,
        admin: { id: 'adm_env', email: ADMIN_EMAIL, name: ADMIN_NAME },
        emails: [],
        stripeMode: process.env.STRIPE_SECRET_KEY ? 'test' : 'mock',
      });
    }

    if (matches(path, '/api/admin/projects') && method === 'GET') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      return send(res, 200, {
        ok: true,
        projects: [
          {
            id: process.env.PORTAL_TEST_PROJECT_ID || 'prj_7mKq9pR2xW4nV8sL',
            name: 'Northshore Botanica Brand & Website Launch',
            status: 'proposal_ready',
            company_name: 'Northshore Botanica',
            contact_name: 'Elena Voss',
            email: 'elena@northshore-botanica.example',
          },
        ],
      });
    }

    return send(res, 404, { ok: false, message: 'Not found.' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Request failed.';
    return send(res, 500, { ok: false, message });
  }
}
