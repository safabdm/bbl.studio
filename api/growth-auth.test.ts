import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import handler from './[...route].js';

for (const [url, method] of [
  ['/api/admin/crm/growth', 'GET'],
  ['/api/admin/crm/growth/readiness', 'GET'],
  ['/api/admin/crm/growth/sales', 'POST'],
  ['/api/admin/crm/growth/social', 'POST'],
  ['/api/crm/growth/tick', 'GET'],
]) {
  void test(`unauthorized ${method} ${url} never loads or mutates growth state`, async () => {
    const req = Object.assign(Readable.from([]), {
      url,
      method,
      headers: {},
    }) as IncomingMessage;
    let status = 0;
    let body = '';
    const res = {
      headersSent: false,
      set statusCode(value: number) {
        status = value;
      },
      setHeader() {},
      end(value: string) {
        body = value;
      },
    } as unknown as ServerResponse;
    await handler(req, res);
    assert.equal(status, 401);
    assert.equal(JSON.parse(body).ok, false);
  });
}
