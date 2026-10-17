/**
 * Public-email enrichment only.
 * Never guesses local-part@domain. Tracks attempt / found / not-found rates.
 */
import type { CrmDbEnv } from './crm-db.js';
import {
  listDiscoveredLeads,
  readEnrichmentStats,
  upsertDiscoveredLead,
  writeEnrichmentStats,
} from './crm-discovery-store.js';
import { fetchWebsiteEvidence } from './crm-discovery-qualify.js';
import type { DiscoveredLead } from './crm-discovery-types.js';

export type EnrichmentRunResult = {
  ok: true;
  attempted: number;
  found_public: number;
  not_found: number;
  skipped_guess_blocked: number;
  updated_ids: string[];
  message: string;
};

/**
 * Re-scan public website for mailto / visible emails for needs_email leads.
 * Does not invent emails. Optional third-party enrichment keys are intentionally unused
 * until a vetted public-listing API is configured.
 */
export async function enrichNeedsEmailLeads(
  opts: { limit?: number; env?: CrmDbEnv; fetchImpl?: typeof fetch } = {},
): Promise<EnrichmentRunResult> {
  const env = opts.env || process.env;
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 40);
  const leads = await listDiscoveredLeads({ status: 'needs_email', limit }, env);
  const stats = await readEnrichmentStats(env);

  let attempted = 0;
  let found = 0;
  let notFound = 0;
  const skippedGuess = 0;
  const updated: string[] = [];

  for (const lead of leads) {
    if (!lead.website) {
      notFound += 1;
      attempted += 1;
      continue;
    }
    attempted += 1;
    const web = await fetchWebsiteEvidence(lead.website, { fetchImpl: opts.fetchImpl });
    const email = web.mailto_emails[0] || web.visible_emails[0] || null;
    if (!email) {
      notFound += 1;
      continue;
    }
    found += 1;
    const now = new Date().toISOString();
    const next: DiscoveredLead = {
      ...lead,
      public_email: email,
      social: { ...lead.social, ...web.social },
      status: lead.score_total >= 55 ? 'qualified' : 'discovered',
      last_verified_at: now,
      updated_at: now,
      enrichment: {
        email_source: web.mailto_emails[0] ? 'website_mailto' : 'website_text',
        email_verified_public: true,
        last_enrichment_at: now,
      },
      evidence: [
        ...lead.evidence,
        {
          field: 'contactability',
          signal: 'enrichment_public_email',
          detail: 'Public email found on website re-scan (not guessed).',
          source: web.final_url || lead.website,
        },
      ],
    };
    await upsertDiscoveredLead(next, env);
    updated.push(next.id);
  }

  const nextStats = {
    attempted: stats.attempted + attempted,
    found_public: stats.found_public + found,
    not_found: stats.not_found + notFound,
    skipped_guess_blocked: stats.skipped_guess_blocked + skippedGuess,
    last_run_at: new Date().toISOString(),
  };
  await writeEnrichmentStats(nextStats, env);

  return {
    ok: true,
    attempted,
    found_public: found,
    not_found: notFound,
    skipped_guess_blocked: skippedGuess,
    updated_ids: updated,
    message:
      attempted === 0
        ? 'No needs_email leads to enrich.'
        : `Enrichment: ${found} public emails found, ${notFound} not found (never guessed).`,
  };
}
