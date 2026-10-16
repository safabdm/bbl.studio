/**
 * Models the Vercel routing order used by this project:
 * redirects, then static files, then rewrites, otherwise 404.
 * Redirects run before the filesystem, so a public file can still 301.
 */

export type VercelRedirect = {
  source: string;
  destination: string;
  statusCode?: number;
  permanent?: boolean;
};

export type VercelRewrite = {
  source: string;
  destination: string;
};

export type VercelConfig = {
  redirects?: VercelRedirect[];
  rewrites?: VercelRewrite[];
  buildCommand?: string;
};

export type RouteDecision =
  | { status: 301 | 302 | 307 | 308; location: string; kind: 'redirect' }
  | { status: 200; kind: 'file'; file: string }
  | { status: 200; kind: 'rewrite'; destination: string }
  | { status: 404; kind: 'not_found' };

export function normalizePath(input: string): string {
  const raw = input.split('?')[0]?.split('#')[0] || '/';
  if (raw === '' || raw === '/') return '/';
  return raw.startsWith('/') ? raw : `/${raw}`;
}

export function sourceMatches(source: string, pathname: string): boolean {
  const path = normalizePath(pathname);
  if (source === '/') return path === '/';
  return sourceToRegExp(source).test(path);
}

function sourceToRegExp(source: string): RegExp {
  let expression = '^';
  const segments = source.split('/').filter((segment) => segment.length > 0);
  for (const segment of segments) {
    const splat = segment.match(/^:([A-Za-z0-9_]+)\*$/);
    const named = segment.match(/^:([A-Za-z0-9_]+)$/);
    if (splat) {
      expression += '(?:/(.*))?';
    } else if (named) {
      expression += '/([^/]+)';
    } else if (segment.startsWith('(') && segment.endsWith(')')) {
      expression += `/${segment}`;
    } else {
      expression += `/${segment.replace(/[.+?^${}()|[\]\\]/g, '\\$&')}`;
    }
  }
  expression += '$';
  return new RegExp(expression);
}

function redirectStatus(redirect: VercelRedirect): 301 | 302 | 307 | 308 {
  if (redirect.statusCode === 301 || redirect.statusCode === 302 || redirect.statusCode === 307 || redirect.statusCode === 308) {
    return redirect.statusCode;
  }
  if (redirect.permanent === false) return 307;
  return 308;
}

export function resolvePublicRoute(
  config: VercelConfig,
  pathname: string,
  files: ReadonlySet<string>,
): RouteDecision {
  const path = normalizePath(pathname);
  for (const redirect of config.redirects || []) {
    if (sourceMatches(redirect.source, path)) {
      return { status: redirectStatus(redirect), location: redirect.destination, kind: 'redirect' };
    }
  }

  const fileName = path === '/' ? 'index.html' : path.slice(1);
  if (!fileName.includes('..') && files.has(fileName)) {
    return { status: 200, kind: 'file', file: fileName };
  }

  for (const rewrite of config.rewrites || []) {
    if (sourceMatches(rewrite.source, path)) {
      return { status: 200, kind: 'rewrite', destination: rewrite.destination };
    }
  }

  return { status: 404, kind: 'not_found' };
}

/** Static files expected in the Vercel output after the production build command. */
export const PRODUCTION_OUTPUT_FILES = [
  'index.html',
  'home.html',
  'app.html',
  'book.html',
  '404.html',
  'sitemap.xml',
  'robots.txt',
  'llms.txt',
] as const;
