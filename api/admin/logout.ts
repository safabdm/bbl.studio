import type { IncomingMessage, ServerResponse } from 'node:http';

export default function handler(_req: IncomingMessage, res: ServerResponse) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Set-Cookie', 'bbls_admin_session=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0');
  res.end(JSON.stringify({ ok: true }));
}
