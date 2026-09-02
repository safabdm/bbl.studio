import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

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

function signAdminToken() {
  const exp = Date.now() + 12 * 60 * 60 * 1000;
  const body = Buffer.from(JSON.stringify({ k: 'admin-v2', e: ADMIN_EMAIL, exp })).toString('base64url');
  const sig = createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
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

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  if ((req.method || '').toUpperCase() !== 'POST') {
    res.statusCode = 405;
    res.end(JSON.stringify({ ok: false, message: 'Use POST to sign in.' }));
    return;
  }

  const body = await readJson(req);
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!same(email, ADMIN_EMAIL) || !same(password, ADMIN_PASSWORD)) {
    res.statusCode = 401;
    res.end(JSON.stringify({ ok: false, message: 'Invalid credentials.' }));
    return;
  }

  res.statusCode = 200;
  res.setHeader(
    'Set-Cookie',
    `${ADMIN_COOKIE}=${encodeURIComponent(signAdminToken())}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${12 * 3600}`,
  );
  res.end(JSON.stringify({ ok: true, name: ADMIN_NAME }));
}
