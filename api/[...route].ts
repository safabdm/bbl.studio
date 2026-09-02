import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import Stripe from 'stripe';

export const config = { maxDuration: 30 };

const ADMIN_COOKIE = 'bbls_admin_session';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@bbls.studio').toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'S@f@1371';
const ADMIN_NAME = process.env.ADMIN_NAME || 'BBLS Studio';
const SESSION_SECRET = process.env.SESSION_SECRET || 'bbls-local-dev-session-secret-not-for-production';
const PROJECT_PACKAGES = {
  pkg_landing: { name: 'Simple Landing Page', depositCents: 60000 },
  pkg_business: { name: 'Business Website', depositCents: 110000 },
  pkg_commercial: { name: 'Commercial Website', depositCents: 170000 },
} as const;

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

    if (matches(path, '/api/start-project/checkout') && method === 'POST') {
      const body = await readJson(req);
      const offerId = String(body.offerId || '') as keyof typeof PROJECT_PACKAGES;
      const selected = PROJECT_PACKAGES[offerId];
      const required = ['name', 'email', 'phone', 'businessName', 'pageCount', 'launchDate', 'goal', 'depositConsent'];
      if (String(body.website || '')) return send(res, 400, { ok: false, message: 'Request could not be submitted.' });
      if (!selected || required.some((key) => !String(body[key] || '').trim())) return send(res, 400, { ok: false, message: 'Please complete every required field.' });
      const email = String(body.email).trim().toLowerCase();
      if (!/^\S+@\S+\.\S+$/.test(email)) return send(res, 400, { ok: false, message: 'Please enter a valid email address.' });
      const key = process.env.STRIPE_SECRET_KEY || '';
      if (!key.startsWith('sk_')) return send(res, 503, { ok: false, message: 'Secure deposit checkout is being connected. Please call BBLS to start your project.' });
      const stripe = new Stripe(key);
      const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'bbls.studio').split(',')[0].trim();
      const trustedHost = host === 'bbls.studio' || host.endsWith('.chatgpt.site') || host.startsWith('127.0.0.1:') || host.startsWith('localhost:');
      const origin = trustedHost ? `${proto === 'http' ? 'http' : 'https'}://${host}` : 'https://bbls.studio';
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer_email: email,
        line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: selected.depositCents, product_data: { name: `BBLS 20% Project Deposit: ${selected.name}` } } }],
        metadata: {
          offer_id: offerId,
          contact_name: String(body.name).slice(0, 120),
          phone: String(body.phone).slice(0, 60),
          business_name: String(body.businessName).slice(0, 120),
          page_count: String(body.pageCount).slice(0, 30),
          target_launch: String(body.launchDate).slice(0, 30),
          project_goal: String(body.goal).slice(0, 450),
        },
        success_url: `${origin}/?deposit=success#start-project`,
        cancel_url: `${origin}/?deposit=cancelled#start-project`,
      });
      if (!session.url) return send(res, 500, { ok: false, message: 'Secure checkout could not be opened. Please call BBLS.' });
      return send(res, 200, { ok: true, url: session.url });
    }

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
