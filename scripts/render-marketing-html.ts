/**
 * Shared HTML shell for prerendered marketing pages (not the handcrafted home.html).
 */
import { bodyFor } from '../lib/marketing-bodies.ts';
import {
  BOOK,
  EMAIL,
  PHONE,
  SITE_URL,
  STUDIO_NAME,
  absoluteUrl,
  type MarketingPage,
} from '../lib/public-marketing.ts';
import { breadcrumbNode, faqNode, graph, serviceNode, webpageNode } from '../lib/schema.ts';
import { breadcrumbsFor, type PageSeo } from '../lib/site.ts';

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function nav() {
  const links = [
    { href: '/orange-county-web-design', label: 'Services' },
    { href: '/work', label: 'Work' },
    { href: '/about', label: 'About' },
    { href: '/contact', label: 'Contact' },
  ];
  return `<header class="top">
  <a class="brand" href="/">BBL Studio</a>
  <nav aria-label="Primary">
    ${links.map((l) => `<a href="${l.href}">${escapeHtml(l.label)}</a>`).join('')}
    <a class="cta" href="${BOOK}">Book</a>
  </nav>
</header>`;
}

function footer() {
  return `<footer>
  <p>${escapeHtml(STUDIO_NAME)}</p>
  <div class="foot-links">
    <a href="/orange-county-web-design">Services</a>
    <a href="/work">Work</a>
    <a href="/about">About</a>
    <a href="/contact">Contact</a>
    <a href="${BOOK}">Book</a>
    <a href="mailto:${EMAIL}">${EMAIL}</a>
    <a href="tel:+19495242324">${escapeHtml(PHONE)}</a>
  </div>
</footer>`;
}

function inquiryForm() {
  return `<form id="inquiry" class="inquiry" action="/api/inquiry" method="post">
  <h2 id="inquiry-title">Tell us about your project</h2>
  <p>Primary next step is still <a href="${BOOK}">booking a consultation</a>. This form sends a note to the studio inbox.</p>
  <div class="grid">
    <label>Your name<input name="name" autocomplete="name" required maxlength="100" /></label>
    <label>Email<input name="email" type="email" autocomplete="email" required maxlength="200" /></label>
    <label class="full">What do you need?
      <select name="service">
        <option>Not sure yet</option>
        <option>Landing page</option>
        <option>Business website</option>
        <option>Commercial website</option>
        <option>Med spa / salon site</option>
        <option>Redesign / UX audit</option>
      </select>
    </label>
    <label class="full">Project notes<textarea name="message" rows="5" required maxlength="2000"></textarea></label>
    <label class="hp" aria-hidden="true">Company website<input name="website" tabindex="-1" autocomplete="off" /></label>
  </div>
  <p class="form-status" role="status" hidden></p>
  <button type="submit">Send message</button>
</form>
<script>
(function(){
  var form=document.getElementById('inquiry');
  if(!form)return;
  form.addEventListener('submit',async function(event){
    event.preventDefault();
    var status=form.querySelector('.form-status');
    var btn=form.querySelector('button[type=submit]');
    if(status){status.hidden=false;status.textContent='Sending…';}
    if(btn)btn.disabled=true;
    try{
      var res=await fetch('/api/inquiry',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(form).entries()))});
      var data=await res.json();
      if(!res.ok||!data.ok){throw new Error(data.message||'Could not send.');}
      if(status)status.textContent=data.message||'Thanks — we received your note.';
      form.reset();
    }catch(err){
      if(status)status.textContent=(err&&err.message)||'Could not send. Email ${EMAIL} or book a consultation.';
    }finally{if(btn)btn.disabled=false;}
  });
})();
</script>`;
}

function jsonLdFor(page: MarketingPage) {
  const pageSeo: PageSeo = {
    path: page.path,
    title: page.title,
    description: page.description,
    h1: page.h1,
  };
  const nodes: Record<string, unknown>[] = [
    webpageNode(pageSeo),
    breadcrumbNode(breadcrumbsFor(page.path)),
  ];
  if (page.kind === 'service' || page.kind === 'buyer' || page.kind === 'geo') {
    nodes.push(serviceNode(page.h1.replace(/\.$/, ''), page.path, page.description));
  }
  if (page.faqs && page.faqs.length) {
    nodes.push(faqNode(page.faqs));
  }
  // organizationNode + websiteNode come from graph()
  return graph(nodes);
}

function css() {
  return `*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#0A0A0A;color:#E6E1D7;font-family:Manrope,system-ui,sans-serif;-webkit-font-smoothing:antialiased;line-height:1.6}
a{color:inherit}a:hover{color:#FF5A36}.skip{position:absolute;left:12px;top:-40px;background:#141414;padding:8px 12px}.skip:focus{top:12px}
.top{display:flex;justify-content:space-between;align-items:center;gap:16px;max-width:1100px;margin:0 auto;padding:22px 24px}
.brand{font-weight:700;letter-spacing:-.4px;text-decoration:none;font-size:18px}
nav{display:flex;flex-wrap:wrap;gap:16px;align-items:center;font-size:13px}
nav a{text-decoration:none;color:rgba(230,225,215,.72)}nav .cta{background:#FF5A36;color:#141414;padding:10px 16px;border-radius:12px;font-weight:600}
main{max-width:800px;margin:0 auto;padding:24px 24px 80px}
.eyebrow{color:#FF5A36;font-size:11px;letter-spacing:.12em;text-transform:uppercase}
h1{font-size:clamp(32px,6vw,48px);line-height:1.1;letter-spacing:-1.4px;font-weight:700;margin:12px 0 16px}
.lede{color:rgba(230,225,215,.78);font-size:16px}
section{margin-top:48px;padding-top:28px;border-top:1px solid rgba(230,225,215,.12)}
h2{font-size:24px;letter-spacing:-.6px;font-weight:600;margin:8px 0 12px}
p{margin:0 0 12px;color:rgba(230,225,215,.78);font-size:15px}
ul{margin:0 0 12px;padding-left:18px;color:rgba(230,225,215,.78)}li{margin:6px 0}
.links{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px}.links a{display:inline-flex;min-height:44px;align-items:center;padding:0 14px;border:1px solid rgba(230,225,215,.2);border-radius:12px;text-decoration:none;font-size:13px}
.primary{display:inline-flex;min-height:48px;align-items:center;padding:0 20px;background:#FF5A36;color:#141414;border-radius:14px;font-weight:700;text-decoration:none;margin-top:20px}
details{border-top:1px solid rgba(230,225,215,.12);padding:16px 0}summary{cursor:pointer;font-size:15px}details p{margin-top:10px}
.inquiry{margin-top:40px;padding:24px;border:1px solid rgba(230,225,215,.16);border-radius:18px;background:#141414}
.inquiry .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.inquiry label{display:grid;gap:6px;font-size:13px}.inquiry .full{grid-column:1/-1}
.inquiry input,.inquiry textarea,.inquiry select{width:100%;min-height:48px;border:1px solid rgba(230,225,215,.22);border-radius:10px;background:#101010;color:#E6E1D7;padding:10px 12px;font:inherit}
.inquiry button{margin-top:14px;min-height:48px;width:100%;border:0;border-radius:12px;background:#FF5A36;color:#141414;font-weight:700}
.hp{position:absolute;left:-9999px;opacity:0;height:1px;width:1px;overflow:hidden}
footer{max-width:1100px;margin:0 auto;padding:28px 24px 48px;border-top:1px solid rgba(230,225,215,.12);display:flex;flex-wrap:wrap;justify-content:space-between;gap:16px;font-size:12px;color:rgba(230,225,215,.65)}
.foot-links{display:flex;flex-wrap:wrap;gap:14px}footer a{color:inherit;text-decoration:none}
@media(max-width:700px){.inquiry .grid{grid-template-columns:1fr}nav{gap:10px}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}`;
}

export function renderMarketingHtml(page: MarketingPage, opts?: { gsc?: string; bing?: string; ga4?: string }) {
  const body = bodyFor(page);
  const canonical = absoluteUrl(page.path);
  const crumbs = breadcrumbsFor(page.path);
  const verification = [
    opts?.gsc ? `<meta name="google-site-verification" content="${escapeHtml(opts.gsc)}" />` : '',
    opts?.bing ? `<meta name="msvalidate.01" content="${escapeHtml(opts.bing)}" />` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const ga = opts?.ga4
    ? `<script>
window.dataLayer=window.dataLayer||[];
function gtag(){dataLayer.push(arguments);}
gtag('consent','default',{ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',analytics_storage:'denied'});
gtag('js',new Date());
gtag('config','${escapeHtml(opts.ga4)}',{anonymize_ip:true,allow_google_signals:false});
</script>
<script async src="https://www.googletagmanager.com/gtag/js?id=${escapeHtml(opts.ga4)}"></script>`
    : '';

  // Fix schema imports — organization already in graph(); avoid LocalBusiness street
  const ld = jsonLdFor(page);

  const sectionsHtml = body.sections
    .map((section) => {
      const links = section.links?.length
        ? `<div class="links">${section.links.map((l) => `<a href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a>`).join('')}</div>`
        : '';
      const bullets = section.bullets?.length
        ? `<ul>${section.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>`
        : '';
      const paras = section.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('');
      return `<section>
  ${section.eyebrow ? `<div class="eyebrow">${escapeHtml(section.eyebrow)}</div>` : ''}
  <h2>${escapeHtml(section.heading)}</h2>
  ${paras}${bullets}${links}
</section>`;
    })
    .join('\n');

  const faqHtml =
    page.faqs && page.faqs.length
      ? `<section aria-label="FAQ">
  <h2>Questions</h2>
  ${page.faqs
    .map(
      (item) => `<details><summary>${escapeHtml(item.q)}</summary><p>${escapeHtml(item.a)}</p></details>`,
    )
    .join('\n')}
</section>`
      : '';

  const showForm = page.kind === 'contact';

  return `<!doctype html>
<html lang="en-US">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${escapeHtml(page.title)}</title>
  <meta name="description" content="${escapeHtml(page.description)}" />
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1" />
  <link rel="canonical" href="${canonical}" />
  <meta property="og:site_name" content="BBL Studio" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="${canonical}" />
  <meta property="og:title" content="${escapeHtml(page.title)}" />
  <meta property="og:description" content="${escapeHtml(page.description)}" />
  <meta property="og:image" content="${SITE_URL}/og.png" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(page.title)}" />
  <meta name="twitter:description" content="${escapeHtml(page.description)}" />
  <meta name="theme-color" content="#0A0A0A" />
  ${verification}
  <link rel="icon" href="/favicon.ico?v=bbl-logo-20260924c" sizes="any" />
  <link rel="icon" href="/favicon.svg?v=bbl-logo-20260924c" type="image/svg+xml" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png?v=bbl-logo-20260924c" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <link rel="alternate" type="text/plain" title="LLM information" href="${SITE_URL}/llms.txt" />
  <script type="application/ld+json">${JSON.stringify(ld)}</script>
  <style>${css()}</style>
  ${ga}
</head>
<body>
  <a class="skip" href="#content">Skip to content</a>
  ${nav()}
  <main id="content">
    <nav class="crumbs" aria-label="Breadcrumb" style="font-size:12px;color:rgba(230,225,215,.55);margin-bottom:18px">
      ${crumbs.map((c, i) => `${i ? ' / ' : ''}<a href="${c.path === '/' ? '/' : c.path}" style="color:inherit;text-decoration:none">${escapeHtml(c.name)}</a>`).join('')}
    </nav>
    <h1>${escapeHtml(page.h1)}</h1>
    <p class="lede">${escapeHtml(body.intro)}</p>
    <a class="primary" href="${BOOK}">${escapeHtml(body.ctaLabel || 'Book a consultation')}</a>
    ${sectionsHtml}
    ${faqHtml}
    ${showForm ? inquiryForm() : ''}
  </main>
  ${footer()}
</body>
</html>`;
}
