import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { request as httpRequest, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { createGunzip, createBrotliDecompress, createInflate } from 'node:zlib';

const MAX_BYTES = 250_000;
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(address) === 6) {
    // Only global unicast; reject local, mapped, transition and documentation ranges.
    const lower = address.toLowerCase();
    const first = Number.parseInt(lower.split(':')[0]!, 16);
    const second = Number.parseInt(lower.split(':')[1] || '0',16);
    return (
      first >= 0x2000 &&
      first <= 0x3fff &&
      first !== 0x2002 &&
      !(first === 0x2001 && [0,2,0x10,0x20,0xdb8].includes(second))
    );
  }
  return false;
}

export function publicWebsiteUrl(value: string | URL): URL {
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80')) ||
    (!host.includes('.') && !isIP(host)) ||
    /(^|\.)(localhost|local|internal|home|lan|test|invalid)$/.test(host) ||
    (isIP(host) && !isPublicAddress(host))
  )
    throw new Error('Only public HTTP(S) websites are allowed.');
  return url;
}

type Resolver = (hostname: string) => Promise<LookupAddress[]>;
export function publicLookup(
  resolve: Resolver = (hostname) =>
    dnsLookup(hostname, { all: true, order: 'verbatim' }),
): NonNullable<RequestOptions['lookup']> {
  return (hostname, options, callback) => {
    void resolve(hostname)
      .then((addresses) => {
        if (
          !addresses.length ||
          addresses.some((a) => !isPublicAddress(a.address))
        )
          throw new Error('Website DNS resolves to a non-public address.');
        // Supply the vetted IP(s) to the socket itself: no second DNS lookup/rebinding window.
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0]!.address, addresses[0]!.family);
      })
      .catch(() =>
        callback(new Error('Public website DNS verification failed.'), '', 0),
      );
  };
}

type Page = {
  status: number;
  headers: Headers;
  body: Uint8Array;
  location?: string;
};
type Transport = (url: URL, signal: AbortSignal) => Promise<Page>;
const readPublicPage: Transport = (url, signal) =>
  new Promise((resolve, reject) => {
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = request(
      url,
      {
        method: 'GET',
        agent: false,
        lookup: publicLookup(),
        signal,
        headers: {
          'User-Agent':
            'BBLStudioDiscoveryBot/1.0 (+https://www.bbl.studio; public evidence only)',
          Accept: 'text/html,application/xhtml+xml',
        },
      },
      (response) => {
        const status = response.statusCode || 502;
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value))
            value.forEach((v) => headers.append(name, v));
          else if (value !== undefined) headers.set(name, value);
        }
        if (
          [301, 302, 303, 307, 308].includes(status) &&
          response.headers.location
        ) {
          resolve({
            status,
            headers,
            body: new Uint8Array(),
            location: response.headers.location,
          });
          response.destroy();
          return;
        }
        let encodedBytes = 0;
        response.on('data', (chunk: Buffer) => {
          encodedBytes += chunk.length;
          if (encodedBytes > MAX_BYTES)
            response.destroy(
              new Error('Public website exceeds evidence size limit.'),
            );
        });
        const encoding = String(
          response.headers['content-encoding'] || '',
        ).toLowerCase();
        const decoder =
          encoding === 'gzip'
            ? createGunzip()
            : encoding === 'br'
              ? createBrotliDecompress()
              : encoding === 'deflate'
                ? createInflate()
                : null;
        const stream = decoder ? response.pipe(decoder) : response;
        response.on('error', (error) => {
          decoder?.destroy(error);
          reject(error);
        });
        void (async () => {
          const chunks: Buffer[] = [];
          let length = 0;
          try {
            for await (const chunk of stream) {
              const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              length += data.length;
              if (length > MAX_BYTES)
                throw new Error('Public website exceeds evidence size limit.');
              chunks.push(data);
            }
            headers.delete('content-encoding');
            headers.delete('content-length');
            resolve({ status, headers, body: Buffer.concat(chunks) });
          } catch (error) {
            response.destroy();
            decoder?.destroy();
            reject(error);
          }
        })();
      },
    );
    req.on('error', reject);
    req.setTimeout(8000, () =>
      req.destroy(new Error('Public website timed out.')),
    );
    req.end();
  });

/** Bounded evidence reads only. Never forwards credentials, cookies or caller headers. */
export async function fetchPublicWebsite(
  input: string | URL,
  init: RequestInit = {},
  transport: Transport = readPublicPage,
): Promise<Response> {
  if (init.method && init.method !== 'GET')
    throw new Error('Website evidence is read-only.');
  const timeout = AbortSignal.timeout(8000);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeout])
    : timeout;
  let url = publicWebsiteUrl(input);
  for (let hop = 0; hop <= 5; hop++) {
    const page = await transport(url, signal);
    if (page.location) {
      if (hop === 5) throw new Error('Too many website redirects.');
      url = publicWebsiteUrl(new URL(page.location, url));
      continue;
    }
    const response = new Response(
      [204, 205, 304].includes(page.status) ? null : Buffer.from(page.body),
      { status: page.status, headers: page.headers },
    );
    Object.defineProperty(response, 'url', { value: url.href });
    return response;
  }
  throw new Error('Website evidence unavailable.');
}
