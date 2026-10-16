import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { UNPUBLISHED_SERVICE_PATHS } from '../lib/service-page-plan';
import {
  PRODUCTION_OUTPUT_FILES,
  resolvePublicRoute,
  type VercelConfig,
} from './public-routing';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const config = JSON.parse(readFileSync(resolve(root, 'vercel.json'), 'utf8')) as VercelConfig & {
  headers?: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
};
const files = new Set<string>(PRODUCTION_OUTPUT_FILES);

function route(pathname: string, extraFiles: string[] = []) {
  const available = new Set(files);
  for (const file of extraFiles) available.add(file);
  return resolvePublicRoute(config, pathname, available);
}

describe('public marketing routes', () => {
  it('serves the marketing homepage and booking page', () => {
    assert.deepEqual(route('/'), { status: 200, kind: 'file', file: 'index.html' });
    assert.deepEqual(route('/booking'), { status: 200, kind: 'rewrite', destination: '/book.html' });
  });

  it('permanently redirects duplicate homepage and booking URLs', () => {
    assert.deepEqual(route('/home.html'), { status: 301, kind: 'redirect', location: '/' });
    assert.deepEqual(route('/index.html'), { status: 301, kind: 'redirect', location: '/' });
    assert.deepEqual(route('/book'), { status: 301, kind: 'redirect', location: '/booking' });
    assert.deepEqual(route('/book.html'), { status: 301, kind: 'redirect', location: '/booking' });
  });

  it('returns 404 for unknown URLs and unpublished service pages', () => {
    const missing = [
      '/this-page-should-not-exist',
      '/work',
      '/about',
      '/contact',
      '/orange-county-web-design',
      '/orange-county/irvine-web-design',
      '/studio.html',
      ...UNPUBLISHED_SERVICE_PATHS,
    ];
    for (const pathname of missing) {
      assert.deepEqual(route(pathname), { status: 404, kind: 'not_found' }, pathname);
    }
  });

  it('does not send marketing URLs to the application shell', () => {
    const shell = (config.rewrites || []).filter((rewrite) => rewrite.destination === '/app.html');
    assert.deepEqual(shell.map((rewrite) => rewrite.source).sort(), [
      '/admin',
      '/admin/:path*',
      '/client',
      '/client/:path*',
      '/unsubscribe',
    ]);
    assert.equal((config.rewrites || []).some((rewrite) => rewrite.source.includes('(?!')), false);
  });
});

describe('preserved application and API routes', () => {
  it('keeps admin, client, unsubscribe, and API on their existing handlers', () => {
    assert.deepEqual(route('/admin'), { status: 200, kind: 'rewrite', destination: '/app.html' });
    assert.deepEqual(route('/admin/login'), { status: 200, kind: 'rewrite', destination: '/app.html' });
    assert.deepEqual(route('/admin/leads'), { status: 200, kind: 'rewrite', destination: '/app.html' });
    assert.deepEqual(route('/client/preview-token'), { status: 200, kind: 'rewrite', destination: '/app.html' });
    assert.deepEqual(route('/unsubscribe'), { status: 200, kind: 'rewrite', destination: '/app.html' });
    assert.deepEqual(route('/unsubscribe?email=a@bbl.studio'), { status: 200, kind: 'rewrite', destination: '/app.html' });
    assert.deepEqual(route('/api/book'), { status: 200, kind: 'rewrite', destination: '/api/[...route]' });
    assert.deepEqual(route('/api/book/slots'), { status: 200, kind: 'rewrite', destination: '/api/[...route]' });
    assert.deepEqual(route('/api/crm/sync'), { status: 200, kind: 'rewrite', destination: '/api/[...route]' });
  });

  it('still serves static assets instead of the application shell', () => {
    assert.deepEqual(route('/work/raysanip.webp', ['work/raysanip.webp']), {
      status: 200,
      kind: 'file',
      file: 'work/raysanip.webp',
    });
    assert.deepEqual(route('/sitemap.xml'), { status: 200, kind: 'file', file: 'sitemap.xml' });
  });
});

describe('indexation safeguards', () => {
  it('removes the studio preview from the deployed output', () => {
    assert.match(config.buildCommand || '', /rm -f out\/studio\.html/);
    assert.equal(files.has('studio.html'), false);
  });

  it('limits the index directive to the homepage and booking page', () => {
    const indexHeaders = (config.headers || []).filter((rule) =>
      rule.headers.some((header) => header.key === 'X-Robots-Tag' && header.value.startsWith('index')),
    );
    assert.deepEqual(indexHeaders.map((rule) => rule.source).sort(), ['/', '/booking']);
  });

  it('marks the app shell and not-found document noindex', () => {
    for (const source of ['/app.html', '/404.html', '/studio.html', '/admin', '/admin/:path*', '/client', '/client/:path*', '/api/:path*', '/unsubscribe']) {
      const rule = (config.headers || []).find((item) => item.source === source);
      assert.ok(rule, source);
      assert.equal(rule?.headers.some((header) => header.value.includes('noindex')), true, source);
    }
  });

  it('keeps the sitemap limited to the live public pages', () => {
    const xml = readFileSync(resolve(root, 'public/sitemap.xml'), 'utf8');
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
    assert.deepEqual(locs, ['https://www.bbl.studio/', 'https://www.bbl.studio/booking']);
  });

  it('uses a not-found document that is not the homepage', () => {
    const notFound = readFileSync(resolve(root, 'public/404.html'), 'utf8');
    const home = readFileSync(resolve(root, 'public/home.html'), 'utf8');
    assert.match(notFound, /<title>Page not found \| BBL Studio<\/title>/);
    assert.match(notFound, /noindex, nofollow/);
    assert.doesNotMatch(notFound, /rel="canonical"/);
    assert.match(home, /<link rel="canonical" href="https:\/\/www\.bbl\.studio\/" \/>/);
    assert.match(home, /<title>Website Design in Orange County \| BBL Studio<\/title>/);
    assert.doesNotMatch(notFound, /Website Design in Orange County/);
  });
});
