import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPublicAddress,
  publicWebsiteUrl,
  publicLookup,
  fetchPublicWebsite,
} from './public-website-fetch.js';

void test('prospect website URLs reject local, encoded IP, credential, port and protocol targets', async () => {
  for (const url of [
    'http://127.0.0.1',
    'http://2130706433',
    'http://0x7f000001',
    'http://169.254.169.254/latest/meta-data',
    'https://[::1]',
    'http://[::ffff:127.0.0.1]',
    'https://localhost',
    'http://service.internal',
    'http://10.1.2.3',
    'https://owner:secret@example.com',
    'https://example.com:8443',
    'file:///etc/passwd',
  ]) {
    let calls = 0;
    await assert.rejects(
      fetchPublicWebsite(url, {}, async () => {
        calls++;
        throw Error('Transport must not run');
      }),
    );
    assert.equal(calls, 0, url);
  }
  assert.equal(
    publicWebsiteUrl('https://example.com/contact').hostname,
    'example.com',
  );
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2001:4860:4860::8888'), true);
  for (const ip of [
    '100.64.1.2',
    '198.18.0.1',
    '192.0.2.1',
    'fc00::1',
    'fe80::1',
    '2002:7f00:1::1',
    '2001:db8::1',
  ])
    assert.equal(isPublicAddress(ip), false, ip);
});
void test('socket lookup pins vetted public addresses and rejects mixed public/private DNS', async () => {
  let lookups = 0;
  const lookup = publicLookup(async () => {
    lookups++;
    return [{ address: '8.8.8.8', family: 4 }];
  });
  await new Promise<void>((resolve, reject) =>
    lookup('example.com', { all: true }, (error, address) => {
      if (error) {
        reject(error);
        return;
      }
      assert.deepEqual(address, [{ address: '8.8.8.8', family: 4 }]);
      resolve();
    }),
  );
  assert.equal(lookups, 1);
  const mixed = publicLookup(async () => [
    { address: '8.8.8.8', family: 4 },
    { address: '10.0.0.1', family: 4 },
  ]);
  await new Promise<void>((resolve) =>
    mixed('example.com', { all: true }, (error) => {
      assert.ok(error);
      resolve();
    }),
  );
});
void test('redirects are revalidated before the next socket is opened', async () => {
  let calls = 0;
  await assert.rejects(
    fetchPublicWebsite('https://example.com', {}, async () => {
      calls++;
      return {
        status: 302,
        headers: new Headers(),
        body: new Uint8Array(),
        location: 'http://169.254.169.254/',
      };
    }),
    /public/,
  );
  assert.equal(calls, 1);
  const response = await fetchPublicWebsite(
    'https://example.com',
    {},
    async (url) =>
      url.pathname === '/'
        ? {
            status: 302,
            headers: new Headers(),
            body: new Uint8Array(),
            location: '/contact',
          }
        : {
            status: 200,
            headers: new Headers(),
            body: new TextEncoder().encode('Public contact page'),
          },
  );
  assert.equal(response.url, 'https://example.com/contact');
  assert.equal(await response.text(), 'Public contact page');
});
void test('website evidence rejects mutations and redirect loops', async () => {
  await assert.rejects(
    fetchPublicWebsite('https://example.com', { method: 'POST' }),
    /read-only/,
  );
  let calls = 0;
  await assert.rejects(
    fetchPublicWebsite('https://example.com', {}, async () => {
      calls++;
      return {
        status: 302,
        headers: new Headers(),
        body: new Uint8Array(),
        location: '/loop',
      };
    }),
    /redirects/,
  );
  assert.equal(calls, 6);
});
