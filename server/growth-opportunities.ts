import type { GrowthMonitor } from './growth-monitor.js';

const AI_SOURCES = new Set([
  'chatgpt.com',
  'chat.openai.com',
  'perplexity.ai',
  'www.perplexity.ai',
  'copilot.microsoft.com',
  'gemini.google.com',
  'claude.ai',
]);
function aiSource(value: string) {
  try {
    return AI_SOURCES.has(
      new URL(
        value.includes('://') ? value : `https://${value}`,
      ).hostname.toLowerCase(),
    );
  } catch {
    return false;
  }
}

/** Derived only from stored provider evidence. No inferred rankings or fabricated traffic. */
export function growthOpportunities(
  monitor: GrowthMonitor | null,
  now = Date.now(),
) {
  const actions: Array<{
    priority: 'high' | 'medium';
    source: string;
    reason: string;
    action: string;
  }> = [];
  const at = Date.parse(monitor?.at || '');
  const fresh = Number.isFinite(at) && at <= now && now - at <= 48 * 3600000;
  if (!fresh)
    actions.push({
      priority: 'high',
      source: 'monitor',
      reason: 'No fresh monitoring snapshot.',
      action:
        'Check the server scheduler and provider authorization before using these results.',
    });
  for (const page of monitor?.technical || []) {
    if (page.status !== 200)
      actions.push({
        priority: 'high',
        source: page.url,
        reason: `Observed HTTP status: ${page.status ?? 'unavailable'}.`,
        action: 'Review reachability before recommending a content change.',
      });
    else
      for (const [check, passed] of Object.entries(page.checks)) {
        if (!passed)
          actions.push({
            priority: 'medium',
            source: page.url,
            reason: `The technical audit did not detect ${check}.`,
            action:
              'Verify the rendered page and prepare a specific owner-reviewed fix; this HTML check is not a ranking claim.',
          });
      }
  }
  const traffic = monitor?.traffic;
  const report = traffic?.report as
    | {
        dimensionHeaders?: Array<{ name?: string }>;
        metricHeaders?: Array<{ name?: string }>;
        rows?: Array<{
          dimensionValues?: Array<{ value?: string }>;
          metricValues?: Array<{ value?: string }>;
        }>;
        rowCount?: number;
      }
    | undefined;
  const dims = report?.dimensionHeaders?.map((h) => h.name) || [];
  const metrics = report?.metricHeaders?.map((h) => h.name) || [];
  const sourceIndex = dims.indexOf('sessionSource'),
    mediumIndex = dims.indexOf('sessionMedium'),
    sessionsIndex = metrics.indexOf('sessions');
  const rows = report?.rows || [];
  const usable =
    fresh &&
    traffic?.status === 'verified' &&
    rows.length > 0 &&
    sourceIndex >= 0 &&
    mediumIndex >= 0 &&
    sessionsIndex >= 0;
  const sum = (predicate: (source: string, medium: string) => boolean) => {
    let total = 0;
    for (const row of rows) {
      const raw = row.metricValues?.[sessionsIndex]?.value;
      const count = raw?.trim() ? Number(raw) : NaN;
      if (!Number.isFinite(count) || count < 0) return null;
      if (
        predicate(
          row.dimensionValues?.[sourceIndex]?.value || '',
          row.dimensionValues?.[mediumIndex]?.value || '',
        )
      )
        total += count;
    }
    return total;
  };
  if (traffic?.status !== 'verified')
    actions.push({
      priority: 'high',
      source: 'GA4',
      reason: 'Analytics report unavailable.',
      action:
        'Check reporting authorization and the configured property; do not infer traffic.',
    });
  else if (!rows.length)
    actions.push({
      priority: 'high',
      source: 'GA4',
      reason: 'The verified report returned no rows.',
      action:
        'Verify actual tag installation and collection separately. Do not treat an empty report as zero real-world traffic.',
    });
  if (monitor?.search.status !== 'verified')
    actions.push({
      priority: 'high',
      source: 'Search Console',
      reason: 'Search report unavailable.',
      action: 'Check property ownership and read-only authorization.',
    });
  else if (!monitor.search.rows?.length)
    actions.push({
      priority: 'medium',
      source: 'Search Console',
      reason: 'The query/page sample has no rows.',
      action:
        'Allow for Search Console reporting lag and inspect indexing before drafting keyword claims.',
    });
  return {
    snapshotAt: monitor?.at || null,
    fresh,
    actions,
    organicSessionsInSample: usable
      ? sum((_source, medium) => medium.toLowerCase() === 'organic')
      : null,
    aiReferralSessionsInSample: usable
      ? sum((source) => aiSource(source))
      : null,
    coverage: {
      returnedRows: report ? rows.length : null,
      providerRowCount: report?.rowCount ?? null,
      maximumRequestedRows: 250,
      siteWideTotal: false,
    },
    note: 'AI referrals are recognized source domains only; unattributed AI visits and AI answer visibility cannot be measured here. Samples are not site-wide totals. Changes and publishing require owner approval.',
  };
}
