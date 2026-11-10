import { dbReadKv, dbWriteKv, type CrmDbEnv } from './crm-db.js';

export type MonitorEnv = CrmDbEnv & {
  GSC_SITE_URL?: string;
  GROWTH_GOOGLE_CLIENT_ID?: string;
  GROWTH_GOOGLE_CLIENT_SECRET?: string;
  GROWTH_GOOGLE_REFRESH_TOKEN?: string;
  GA4_PROPERTY_ID?: string;
};
export type GrowthMonitor = {
  at: string;
  technical: Array<{
    url: string;
    status: number | null;
    checks: Record<string, boolean>;
    error?: string;
  }>;
  search: {
    status: 'verified' | 'unavailable';
    startDate?: string;
    endDate?: string;
    rows?: unknown[];
    error?: string;
  };
  traffic: {
    status: 'verified' | 'unavailable';
    report?: unknown;
    error?: string;
  };
};
export const MONITOR_KEY = 'growth:monitor:v1';
export const readGrowthMonitor = (env: MonitorEnv) =>
  dbReadKv<GrowthMonitor | null>(MONITOR_KEY, null, env);

/** Retries only safe reads/query POSTs; never publishing or email sends. */
export async function readWithRetry(
  url: string,
  init: RequestInit,
  io: typeof fetch = fetch,
) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await io(url, {
        ...init,
        signal: AbortSignal.timeout(8000),
      });
      if (attempt < 2 && (response.status === 429 || response.status >= 500)) {
        const delay = Math.min(
          2000,
          Math.max(
            100,
            Number(response.headers.get('retry-after') || 0) * 1000 ||
              250 * 2 ** attempt,
          ),
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      return response;
    } catch (error) {
      if (attempt >= 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
}

export async function runGrowthMonitor(
  env: MonitorEnv,
  io: typeof fetch = fetch,
  now = Date.now(),
) {
  const technical = await Promise.all(
    ['/', '/booking', '/robots.txt', '/sitemap.xml', '/llms.txt'].map(
      async (path) => {
        const url = `https://www.bbl.studio${path}`;
        try {
          const response = await readWithRetry(url, { redirect: 'error' }, io);
          const text = (await response.text()).slice(0, 500000);
          const html = path === '/' || path === '/booking';
          return {
            url,
            status: response.status,
            checks: {
              reachable: response.ok,
              ...(html
                ? {
                    title: /<title>[^<]+<\/title>/i.test(text),
                    canonical: /rel=["']canonical["']/i.test(text),
                    description: /name=["']description["']/i.test(text),
                    structured_data: /application\/ld\+json/i.test(text),
                    viewport: /name=["']viewport["']/i.test(text),
                  }
                : { nonempty: text.trim().length > 0 }),
            },
          };
        } catch {
          return {
            url,
            status: null,
            checks: { reachable: false },
            error: 'Fetch failed; no technical claim inferred.',
          };
        }
      },
    ),
  );
  const result: GrowthMonitor = {
    at: new Date(now).toISOString(),
    technical,
    search: {
      status: 'unavailable',
      error: 'Search Console OAuth not connected.',
    },
    traffic: {
      status: 'unavailable',
      error: 'GA4 OAuth/property not connected.',
    },
  };
  if (
    env.GROWTH_GOOGLE_CLIENT_ID &&
    env.GROWTH_GOOGLE_CLIENT_SECRET &&
    env.GROWTH_GOOGLE_REFRESH_TOKEN
  ) {
    try {
      const auth = await readWithRetry(
        'https://oauth2.googleapis.com/token',
        {
          method: 'POST',
          body: new URLSearchParams({
            client_id: env.GROWTH_GOOGLE_CLIENT_ID,
            client_secret: env.GROWTH_GOOGLE_CLIENT_SECRET,
            refresh_token: env.GROWTH_GOOGLE_REFRESH_TOKEN,
            grant_type: 'refresh_token',
          }),
        },
        io,
      );
      const data = (await auth.json()) as { access_token?: string };
      if (!auth.ok || !data.access_token) throw new Error('OAuth unavailable');
      const headers = {
        Authorization: `Bearer ${data.access_token}`,
        'Content-Type': 'application/json',
      };
      // Complete historical days only; Search Console data may lag several days.
      const endDate = new Date(now - 3 * 86400000).toISOString().slice(0, 10);
      const startDate = new Date(now - 30 * 86400000)
        .toISOString()
        .slice(0, 10);
      try {
        const response = await readWithRetry(
          `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(env.GSC_SITE_URL || 'sc-domain:bbl.studio')}/searchAnalytics/query`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              startDate,
              endDate,
              dimensions: ['query', 'page'],
              rowLimit: 250,
            }),
          },
          io,
        );
        if (!response.ok) throw new Error('Search read denied');
        const report = (await response.json()) as { rows?: unknown[] };
        result.search = {
          status: 'verified',
          startDate,
          endDate,
          rows: report.rows || [],
        };
      } catch {
        result.search.error =
          'Search Console read failed; check property permission/scopes.';
      }
      if (env.GA4_PROPERTY_ID && /^\d+$/.test(env.GA4_PROPERTY_ID)) {
        try {
          const response = await readWithRetry(
            `https://analyticsdata.googleapis.com/v1beta/properties/${env.GA4_PROPERTY_ID}:runReport`,
            {
              method: 'POST',
              headers,
              body: JSON.stringify({
                dateRanges: [{ startDate, endDate }],
                dimensions: [
                  { name: 'sessionSource' },
                  { name: 'sessionMedium' },
                  { name: 'landingPagePlusQueryString' },
                ],
                metrics: [{ name: 'sessions' }, { name: 'keyEvents' }],
                limit: 250,
              }),
            },
            io,
          );
          if (!response.ok) throw new Error('Analytics read denied');
          result.traffic = {
            status: 'verified',
            report: await response.json(),
          };
        } catch {
          result.traffic.error =
            'GA4 read failed; check Analytics permission/scopes.';
        }
      }
    } catch {
      result.search.error = result.traffic.error =
        'Google OAuth refresh failed; reconnect monitoring scopes.';
    }
  }
  await dbWriteKv(MONITOR_KEY, result, env);
  return result;
}
