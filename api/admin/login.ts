import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  adminCookieHeader,
  adminName,
  matchAdmin,
  signAdminToken,
} from '../../server/admin-auth.js';

export const config = { maxDuration: 30 };

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
  if (!matchAdmin(email, password)) {
    res.statusCode = 401;
    res.end(JSON.stringify({ ok: false, message: 'Invalid credentials.' }));
    return;
  }

  res.statusCode = 200;
  res.setHeader('Set-Cookie', adminCookieHeader(signAdminToken()));
  res.end(JSON.stringify({ ok: true, name: adminName() }));
}
