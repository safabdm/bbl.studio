import { useEffect } from 'react';
import { pageByPath, SITE_URL } from '@/lib/site';

export function PageSeo({
  path,
  jsonLd,
}: {
  path: string;
  jsonLd?: Record<string, unknown>;
}) {
  const page = pageByPath(path);
  useEffect(() => {
    if (!page) return;
    document.title = page.title;
    const setMeta = (selector: string, content: string, attr = 'content') => {
      const node = document.querySelector(selector);
      if (node) node.setAttribute(attr, content);
    };
    setMeta('meta[name="description"]', page.description);
    setMeta('meta[property="og:title"]', page.title);
    setMeta('meta[property="og:description"]', page.description);
    setMeta('meta[property="og:url"]', `${SITE_URL}${page.path}`);
    setMeta('meta[name="twitter:title"]', page.title);
    setMeta('meta[name="twitter:description"]', page.description);
    const canonical = document.querySelector('link[rel="canonical"]');
    if (canonical) canonical.setAttribute('href', `${SITE_URL}${page.path === '/' ? '/' : page.path}`);
    let script = document.getElementById('page-jsonld');
    if (jsonLd) {
      if (!script) {
        script = document.createElement('script');
        script.id = 'page-jsonld';
        script.setAttribute('type', 'application/ld+json');
        document.head.appendChild(script);
      }
      script.textContent = JSON.stringify(jsonLd);
    }
  }, [path, page, jsonLd]);
  return null;
}
