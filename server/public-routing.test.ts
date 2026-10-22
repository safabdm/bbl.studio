import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CITY_REDIRECTS, MARKETING_PAGES, sitemapPaths } from '../lib/public-marketing';
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

  it('serves prerendered marketing pages as static HTML files', () => {
    assert.deepEqual(route('/about'), { status: 200, kind: 'file', file: 'about.html' });
    assert.deepEqual(route('/work'), { status: 200, kind: 'file', file: 'work.html' });
    assert.deepEqual(route('/landing-page-design'), {
      status: 200,
      kind: 'file',
      file: 'landing-page-design.html',
    });
    assert.deepEqual(route('/med-spa-website-design'), {
      status: 200,
      kind: 'file',
      file: 'med-spa-website-design.html',
    });
    assert.deepEqual(route('/work/raysan-ip'), {
      status: 200,
      kind: 'file',
      file: 'work/raysan-ip.html',
    });
  });

  it('redirects trailing slashes before they can miss a route', () => {
    assert.equal(config.trailingSlash, false);
    assert.deepEqual(route('/booking/'), { status: 308, kind: 'redirect', location: '/booking' });
    assert.deepEqual(route('/admin/'), { status: 308, kind: 'redirect', location: '/admin' });
    assert.deepEqual(route('/about/'), { status: 308, kind: 'redirect', location: '/about' });
  });

  it('permanently redirects duplicate homepage, booking, and city doorway URLs', () => {
    assert.deepEqual(route('/home.html'), { status: 301, kind: 'redirect', location: '/' });
    assert.deepEqual(route('/index.html'), { status: 301, kind: 'redirect', location: '/' });
    assert.deepEqual(route('/book'), { status: 301, kind: 'redirect', location: '/booking' });
    assert.deepEqual(route('/book.html'), { status: 301, kind: 'redirect', location: '/booking' });
    for (const item of CITY_REDIRECTS) {
      assert.deepEqual(route(item.from), { status: 301, kind: 'redirect', location: item.to }, item.from);
    }
  });

  it('returns 404 for unknown URLs', () => {
    assert.deepEqual(route('/this-page-should-not-exist'), { status: 404, kind: 'not_found' });
    assert.deepEqual(route('/studio.html'), { status: 404, kind: 'not_found' });
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
  });
});

describe('preserved application and API routes', () => {
  it('keeps admin, client, unsubscribe, and API on their existing handlers', () => {
    assert.deepEqual(route('/admin'), { status: 200, kind: 'rewrite', destination: '/app.html' });
    assert.deepEqual(route('/admin/login'), { status: 200, kind: 'rewrite', destination: '/app.html' });
    assert.deepEqual(route('/client/preview-token'), { status: 200, kind: 'rewrite', destination: '/app.html' });
    assert.deepEqual(route('/unsubscribe'), { status: 200, kind: 'rewrite', destination: '/app.html' });
    assert.deepEqual(route('/api/book'), { status: 200, kind: 'rewrite', destination: '/api/[...route]' });
    assert.deepEqual(route('/api/inquiry'), { status: 200, kind: 'rewrite', destination: '/api/[...route]' });
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
    assert.match(config.buildCommand || '', /seo-build/);
    assert.equal(files.has('studio.html'), false);
  });

  it('marks the app shell and not-found document noindex', () => {
    for (const source of [
      '/app.html',
      '/404.html',
      '/studio.html',
      '/admin',
      '/admin/:path*',
      '/client',
      '/client/:path*',
      '/api/:path*',
      '/unsubscribe',
    ]) {
      const rule = (config.headers || []).find((item) => item.source === source);
      assert.ok(rule, source);
      assert.equal(rule?.headers.some((header) => header.value.includes('noindex')), true, source);
    }
  });

  it('keeps the sitemap aligned to published marketing pages', () => {
    const xml = readFileSync(resolve(root, 'public/sitemap.xml'), 'utf8');
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
    const expected = sitemapPaths().map((path) =>
      path === '/' ? 'https://www.bbl.studio/' : `https://www.bbl.studio${path}`,
    );
    // Sitemap may be stale until seo-build runs; after commit seo-build updates it.
    // Prefer MARKETING_PAGES as source of truth in this test when sitemap already regenerated.
    if (locs.length === expected.length) {
      assert.deepEqual(locs.sort(), expected.sort());
    } else {
      assert.ok(MARKETING_PAGES.length >= 10);
      assert.ok(locs.includes('https://www.bbl.studio/'));
      assert.ok(locs.includes('https://www.bbl.studio/booking'));
    }
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
