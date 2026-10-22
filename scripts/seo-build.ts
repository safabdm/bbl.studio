/**
 * Post-vite SEO build: prerender marketing HTML, sitemap, privacy leak check.
 * Run after `vite build --config vite.vercel.config.ts`.
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CITY_REDIRECTS, MARKETING_PAGES, absoluteUrl } from '../lib/public-marketing.ts';
import { renderMarketingHtml } from './render-marketing-html.ts';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outDir = resolve(root, 'out');

const LEAK_PATTERNS = [/safabdm/i, /badamchi/i, /github\.com/i];

function walkFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkFiles(full, acc);
    else acc.push(full);
  }
  return acc;
}

function assertNoLeakage() {
  const hits: string[] = [];
  const allowedGithubInPortal = /https:\/\/github\.com\/ungap\/url-search-params/g;
  for (const file of walkFiles(outDir)) {
    // Skip binary-ish by extension
    if (/\.(png|jpe?g|webp|gif|ico|woff2?|ttf|eot|mp4|webm|pdf)$/i.test(file)) continue;
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const rel = relative(outDir, file);
    if (/safabdm/i.test(text) || /badamchi/i.test(text)) {
      hits.push(`${rel} matches owner/personal identity string`);
      continue;
    }
    if (/github\.com/i.test(text)) {
      // react-router ships a polyfill hint URL inside the admin portal chunk only.
      const scrubbed = text.replace(allowedGithubInPortal, '');
      if (/github\.com/i.test(scrubbed)) {
        hits.push(`${rel} matches github.com`);
      } else if (!/portal-.*\.js$/i.test(rel)) {
        hits.push(`${rel} matches github.com (polyfill URL only allowed in portal chunk)`);
      }
    }
  }
  if (hits.length) {
    console.error('SEO privacy leak check failed:\n' + hits.slice(0, 40).join('\n'));
    process.exit(1);
  }
  console.log('Privacy leak check passed (safabdm / badamchi absent; github.com absent from public artifacts).');
}

function writeSitemap() {
  const lastmod = new Date().toISOString().slice(0, 10);
  const urls = MARKETING_PAGES.map((page) => {
    const loc = absoluteUrl(page.path);
    const priority = page.path === '/' ? '1.0' : page.path === '/booking' ? '0.9' : '0.8';
    return `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>${priority}</priority>\n  </url>`;
  });
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
  writeFileSync(join(outDir, 'sitemap.xml'), xml, 'utf8');
  // Keep public/ in sync for local routing tests / non-build deploys
  writeFileSync(join(root, 'public/sitemap.xml'), xml, 'utf8');
  console.log(`Sitemap written (${MARKETING_PAGES.length} URLs).`);
}

function prerenderPages() {
  const gsc = (process.env.GSC_VERIFICATION || '').trim();
  const bing = (process.env.BING_VERIFICATION || '').trim();
  const ga4 = (process.env.GA4_MEASUREMENT_ID || '').trim();
  const opts = {
    gsc: gsc || undefined,
    bing: bing || undefined,
    ga4: ga4 || undefined,
  };

  for (const page of MARKETING_PAGES) {
    if (page.kind === 'home' || page.kind === 'booking') continue; // handcrafted public/home.html + book.html
    const html = renderMarketingHtml(page, opts);
    const target = join(outDir, page.file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, html, 'utf8');
    // Also write under public/ so future builds and file-based routing stay aligned
    const publicTarget = join(root, 'public', page.file);
    mkdirSync(dirname(publicTarget), { recursive: true });
    writeFileSync(publicTarget, html, 'utf8');
    if (!html.includes(page.title) || !html.includes('<h1>') || !html.includes(page.h1)) {
      console.error(`Prerender validation failed for ${page.path}`);
      process.exit(1);
    }
  }
  console.log(`Prerendered ${MARKETING_PAGES.filter((p) => p.kind !== 'home' && p.kind !== 'booking').length} marketing pages.`);
  console.log(`City redirects configured in vercel.json (${CITY_REDIRECTS.length}).`);
}

function rejectSourceMaps() {
  const maps = walkFiles(outDir).filter((f) => f.endsWith('.map'));
  if (maps.length) {
    console.error('Source maps found in out/ (production maps must be disabled):\n' + maps.map((m) => relative(outDir, m)).join('\n'));
    process.exit(1);
  }
}

function injectAnalyticsTags() {
  const gsc = (process.env.GSC_VERIFICATION || '').trim();
  const bing = (process.env.BING_VERIFICATION || '').trim();
  const ga4 = (process.env.GA4_MEASUREMENT_ID || '').trim();
  const tags: string[] = [];
  if (gsc) tags.push(`<meta name="google-site-verification" content="${gsc.replace(/"/g, '')}" />`);
  if (bing) tags.push(`<meta name="msvalidate.01" content="${bing.replace(/"/g, '')}" />`);
  if (ga4) {
    tags.push(`<script async src="https://www.googletagmanager.com/gtag/js?id=${ga4.replace(/"/g, '')}"></script>`);
    tags.push(`<script>
window.dataLayer=window.dataLayer||[];
function gtag(){dataLayer.push(arguments);}
gtag('consent','default',{ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',analytics_storage:'denied'});
gtag('js',new Date());
gtag('config','${ga4.replace(/"/g, '')}',{anonymize_ip:true,allow_google_signals:false});
window.gtag=gtag;
</script>`);
  }
  if (!tags.length) {
    console.log('No GSC/Bing/GA4 env set — verification and analytics tags omitted.');
    return;
  }
  const snippet = `${tags.join('\n')}\n`;
  for (const name of ['index.html', 'home.html', 'book.html']) {
    const file = join(outDir, name);
    if (!existsSync(file)) continue;
    let html = readFileSync(file, 'utf8');
    if (html.includes('google-site-verification') || html.includes('gtag/js?id=')) continue;
    html = html.replace('</head>', `${snippet}</head>`);
    writeFileSync(file, html, 'utf8');
  }
  console.log('Injected analytics/verification tags into home + booking HTML.');
}

/**
 * Vite builds the SPA shell from index.html (marketing-oriented meta).
 * That file is copied to app.html for /admin, /client, /unsubscribe.
 * Vercel already sends X-Robots-Tag: noindex on those routes; harden the
 * document meta so the shell never claims the homepage canonical/index.
 */
function hardenAppShell() {
  const file = join(outDir, 'app.html');
  if (!existsSync(file)) {
    console.error('out/app.html missing — expected after vite build copy');
    process.exit(1);
  }
  let html = readFileSync(file, 'utf8');
  html = html.replace(
    /<meta\s+name="robots"[^>]*>/i,
    '<meta name="robots" content="noindex, nofollow" />',
  );
  html = html.replace(
    /<meta\s+name="googlebot"[^>]*>/i,
    '<meta name="googlebot" content="noindex, nofollow" />',
  );
  if (!/name="robots"/i.test(html)) {
    html = html.replace('</head>', '<meta name="robots" content="noindex, nofollow" />\n</head>');
  }
  html = html.replace(/<link\s+rel="canonical"[^>]*>\s*/i, '');
  html = html.replace(/<title>[^<]*<\/title>/i, '<title>BBL Studio</title>');
  if (!/name="robots" content="noindex/i.test(html)) {
    console.error('Failed to set noindex on out/app.html');
    process.exit(1);
  }
  writeFileSync(file, html, 'utf8');
  console.log('Hardened out/app.html (noindex, no homepage canonical).');
}

function main() {
  if (!existsSync(outDir)) {
    console.error('out/ missing — run vite build first');
    process.exit(1);
  }
  prerenderPages();
  writeSitemap();
  injectAnalyticsTags();
  hardenAppShell();
  rejectSourceMaps();
  assertNoLeakage();
}

main();
