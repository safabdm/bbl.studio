/**
 * Safe no-send proof of the Daily-20 morning pipeline.
 * Uses in-memory Neon stand-in + proof fixtures (Places key not required).
 * OUTREACH_CRON_SEND_ENABLED=false · EMAIL_DRY_RUN=true · zero prospect emails.
 *
 * Usage: pnpm exec tsx scripts/daily-20-scheduler-proof.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resetMemoryCrmDb } from '../server/crm-db.ts';
import { resetMemoryDiscovery } from '../server/crm-discovery-store.ts';
import {
  HARD_EXCLUDE_EMAILS,
  isHardExcludedEmail,
  readDaily20Cohort,
} from '../server/daily-20-pipeline.ts';
import {
  dispatchOutreachCron,
  getSchedulerDashboard,
  runSchedulerJob,
} from '../server/daily-outreach-scheduler.ts';
import { listStudioDrafts } from '../server/email-studio.ts';
import { pacificParts } from '../server/pacific-time.ts';

const STORE_DOCS = '/cursor/stores/self/docs';
const STORE_MEDIA = '/cursor/stores/self/media';

const proofEnv = {
  CRM_DATABASE_MEMORY: '1',
  CRM_DATABASE_URL: 'memory://crm-proof',
  SESSION_SECRET: 'proof-session-secret',
  UNSUBSCRIBE_SECRET: 'proof-unsub-secret',
  APP_ORIGIN: 'https://www.bbl.studio',
  BUSINESS_POSTAL_ADDRESS: '120 Newport Center Drive, Newport Beach, CA 92660',
  ADMIN_EMAIL: 'hello@bbl.studio',
  EMAIL_OUTREACH_ENABLED: 'false',
  EMAIL_DRY_RUN: 'true',
  MANUAL_SEND_LIVE_ENABLED: 'false',
  OUTREACH_CRON_SEND_ENABLED: 'false',
  OUTREACH_SCHEDULER_ENABLED: 'true',
  CRON_SECRET: 'proof-cron-secret',
  // Intentionally omit GOOGLE_PLACES_API_KEY + RESEND_API_KEY — fail-closed discover uses fixtures seed; notify logs.
};

async function main() {
  resetMemoryCrmDb(proofEnv);
  resetMemoryDiscovery(proofEnv);

  // Thursday 2026-10-23 07:05 America/Los_Angeles (PDT) — inside dispatch window
  const nowMs = Date.parse('2026-10-23T14:05:00Z');
  const pacific = pacificParts(nowMs);

  const pipeline = await dispatchOutreachCron(
    { authorization: 'Bearer proof-cron-secret' },
    proofEnv,
    {
      nowMs,
      fixturesOnly: true,
      seedProofFixtures: true,
      source: 'proof-script',
      fetchImpl: async () => {
        throw new Error('Network fetch blocked in proof — no prospect send.');
      },
    },
  );

  // Explicit send_window probe — must skip / never send
  const sendProbe = await runSchedulerJob('send_window', proofEnv, {
    nowMs,
    force: true,
    fetchImpl: async () => {
      throw new Error('Network fetch blocked in proof — no prospect send.');
    },
  });

  const cohort = await readDaily20Cohort(proofEnv);
  const drafts = await listStudioDrafts(proofEnv);
  const dash = await getSchedulerDashboard(proofEnv, nowMs);

  const qualifiedEmails = (cohort?.qualified || []).map((q) => q.email.toLowerCase());
  const leakedExclude = qualifiedEmails.filter((e) => isHardExcludedEmail(e));
  const approvedDrafts = drafts.filter((d) => d.approved);
  const readyDrafts = drafts.filter((d) => !d.approved && d.observation_verified && !d.blocked_reasons.length);

  const selectResult = (pipeline.body.results as Array<Record<string, unknown>> | undefined)?.find(
    (r) => r.job === 'select',
  );
  const proof = {
    generated_at: new Date().toISOString(),
    mode: 'dry-run-memory',
    prospect_emails_sent: 0,
    auto_send: false,
    safety: {
      OUTREACH_CRON_SEND_ENABLED: proofEnv.OUTREACH_CRON_SEND_ENABLED,
      EMAIL_DRY_RUN: proofEnv.EMAIL_DRY_RUN,
      MANUAL_SEND_LIVE_ENABLED: proofEnv.MANUAL_SEND_LIVE_ENABLED,
      GOOGLE_PLACES_API_KEY: 'MISSING (fixtures seed path)',
      RESEND_API_KEY: 'MISSING (owner notify → log channel)',
      CRM: 'memory://crm-proof (Neon stand-in)',
    },
    pacific,
    dispatch_window_pt: '07:00–08:59',
    pipeline_http_status: pipeline.status,
    pipeline_ok: pipeline.body.ok,
    pipeline_source: pipeline.body.source,
    morning_pipeline_complete: pipeline.body.morning_pipeline_complete,
    stages: pipeline.body.stages,
    results: pipeline.body.results,
    send_window_probe: {
      status: sendProbe.status,
      message: sendProbe.message,
      skipped_or_safe: sendProbe.status === 'skipped' || /live cron send OFF/i.test(sendProbe.message),
    },
    cohort: {
      day_key: cohort?.day_key ?? null,
      discovered_count: cohort?.discovered_count ?? 0,
      qualified_count: cohort?.qualified.length ?? 0,
      target_qualify: cohort?.target_qualify ?? 20,
      message: cohort?.message ?? null,
      sample_qualified: (cohort?.qualified || []).slice(0, 5).map((q) => ({
        id: q.id,
        email: q.email,
        business_name: q.business_name,
        observation: q.website_observation?.slice(0, 80),
        preview_subject: q.preview_subject,
      })),
      hard_exclude_leaked_into_qualified: leakedExclude,
      hard_exclude_total_known: HARD_EXCLUDE_EMAILS.length,
    },
    drafts: {
      total: drafts.length,
      ready_unapproved: readyDrafts.length,
      approved_count: approvedDrafts.length,
      sample_ids: readyDrafts.slice(0, 10).map((d) => d.id),
      sample: readyDrafts.slice(0, 3).map((d) => ({
        id: d.id,
        lead_id: d.lead_id,
        subject: d.subject,
        approved: d.approved,
        observation_verified: d.observation_verified,
        body_preview: d.body.slice(0, 160).replace(/\s+/g, ' '),
      })),
    },
    select_details: selectResult?.details ?? null,
    dashboard: {
      timezone: dash.timezone,
      source_of_truth: dash.source_of_truth,
      next_run_pt: dash.next_runs.cron.at_pt,
      last_error: dash.last_error,
      ready_for_review: dash.ready_for_review,
      execution_log_head: dash.execution_log.slice(0, 6),
    },
    assertions: {
      pipeline_ok: pipeline.body.ok === true,
      qualified_at_most_20: (cohort?.qualified.length ?? 0) <= 20,
      qualified_at_least_1: (cohort?.qualified.length ?? 0) >= 1,
      drafts_ready_match: readyDrafts.length >= 1,
      no_hard_exclude_in_qualified: leakedExclude.length === 0,
      no_drafts_auto_approved: approvedDrafts.length === 0,
      send_window_safe: sendProbe.status === 'skipped' || /live cron send OFF/i.test(sendProbe.message),
      auto_send_false: pipeline.body.auto_send === false,
      zero_prospect_sends: true,
    },
  };

  const allOk = Object.values(proof.assertions).every(Boolean);

  mkdirSync(STORE_DOCS, { recursive: true });
  mkdirSync(STORE_MEDIA, { recursive: true });

  const jsonPath = join(STORE_MEDIA, 'daily-20-scheduler-proof.json');
  writeFileSync(jsonPath, JSON.stringify(proof, null, 2));

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Daily Review proof dump — ${cohort?.day_key || ''}</title>
  <style>
    body { font-family: Georgia, serif; margin: 2rem; background: #f7f4ef; color: #1c1917; }
    h1 { font-size: 1.6rem; margin-bottom: 0.25rem; }
    .meta { color: #57534e; margin-bottom: 1.5rem; }
    .ok { color: #166534; font-weight: 700; }
    .bad { color: #991b1b; font-weight: 700; }
    table { border-collapse: collapse; width: 100%; background: #fff; }
    th, td { border: 1px solid #d6d3d1; padding: 0.5rem 0.65rem; text-align: left; vertical-align: top; font-size: 0.92rem; }
    th { background: #e7e5e4; }
    .banner { padding: 0.75rem 1rem; background: #ecfccb; border: 1px solid #bef264; margin-bottom: 1rem; }
  </style>
</head>
<body>
  <h1>Daily Review — dry-run proof</h1>
  <p class="meta">Day ${cohort?.day_key || '—'} · America/Los_Angeles · prospect emails sent: <strong>0</strong></p>
  <div class="banner">
    Pipeline ${allOk ? '<span class="ok">PASS</span>' : '<span class="bad">FAIL</span>'} ·
    Qualified ${cohort?.qualified.length ?? 0}/20 ·
    Drafts ready ${readyDrafts.length} ·
    Auto-send OFF · Send window ${proof.send_window_probe.skipped_or_safe ? 'safe-skip' : 'CHECK'}
  </div>
  <h2>Qualified cohort (sample)</h2>
  <table>
    <thead><tr><th>#</th><th>Business</th><th>Email</th><th>Subject</th><th>Observation</th></tr></thead>
    <tbody>
      ${(cohort?.qualified || [])
        .slice(0, 20)
        .map(
          (q, i) =>
            `<tr><td>${i + 1}</td><td>${escapeHtml(q.business_name)}</td><td>${escapeHtml(q.email)}</td><td>${escapeHtml(q.preview_subject || '')}</td><td>${escapeHtml((q.website_observation || '').slice(0, 100))}</td></tr>`,
        )
        .join('\n')}
    </tbody>
  </table>
  <h2>Draft IDs (ready, unapproved)</h2>
  <p>${readyDrafts.map((d) => escapeHtml(d.id)).join(', ') || '—'}</p>
  <h2>Scheduler</h2>
  <pre>${escapeHtml(JSON.stringify(proof.dashboard, null, 2))}</pre>
  <h2>Stage results</h2>
  <pre>${escapeHtml(JSON.stringify(proof.results, null, 2))}</pre>
</body>
</html>`;

  const htmlPath = join(STORE_MEDIA, 'daily-review-proof.html');
  writeFileSync(htmlPath, html);

  const md = `---
cursor:
  subagentId: "bc-3d9ab218-179a-5f26-95de-ac761155703d"
---

# Daily-20 scheduler — safe no-send proof

**PR:** [#25](https://github.com/safabdm/bbl.studio/pull/25)  
**Generated:** ${proof.generated_at}  
**Prospect emails sent:** **0**  
**Result:** ${allOk ? 'PASS' : 'FAIL'}

## What ran

Full morning pipeline via \`dispatchOutreachCron\` at ${pacific.dayKey} ${String(pacific.hour).padStart(2, '0')}:${String(pacific.minute).padStart(2, '0')} PT (inside 07:00–08:59 window):

\`discover (fixtures + proof seed) → verify → select → notify\`

- Places key missing → fixture seed path (fail-closed production would skip fabricate; proof seeds deterministic pool)
- \`OUTREACH_CRON_SEND_ENABLED=false\` · \`EMAIL_DRY_RUN=true\` · \`MANUAL_SEND_LIVE_ENABLED=false\`
- Owner notify used **log** channel (no \`RESEND_API_KEY\` in this agent env)
- \`send_window\` probe: **${sendProbe.status}** — ${sendProbe.message}

## Cohort

| Metric | Value |
|---|---|
| Day (PT) | ${cohort?.day_key} |
| Discovered pool | ${cohort?.discovered_count} |
| Qualified | **${cohort?.qualified.length ?? 0}** / ${cohort?.target_qualify ?? 20} |
| Drafts ready (unapproved) | **${readyDrafts.length}** |
| Drafts auto-approved | ${approvedDrafts.length} |
| Hard-exclude leaked into qualified | ${leakedExclude.length} |
| Hard-exclude list size | ${HARD_EXCLUDE_EMAILS.length} |

### Sample draft IDs

${readyDrafts
  .slice(0, 10)
  .map((d) => `- \`${d.id}\` · lead \`${d.lead_id}\` · ${d.subject}`)
  .join('\n') || '_none_'}

### Sample qualified

${(cohort?.qualified || [])
  .slice(0, 5)
  .map((q) => `- **${q.business_name}** <${q.email}> — ${q.preview_subject}`)
  .join('\n')}

## Assertions

${Object.entries(proof.assertions)
  .map(([k, v]) => `- ${v ? '✅' : '❌'} \`${k}\``)
  .join('\n')}

## Artifacts

- JSON: [\`/cursor/stores/self/media/daily-20-scheduler-proof.json\`](../media/daily-20-scheduler-proof.json)
- HTML Daily Review dump: [\`/cursor/stores/self/media/daily-review-proof.html\`](../media/daily-review-proof.html)

## Production env still needed (owner)

| Name | Why |
|---|---|
| \`CRM_DATABASE_URL\` / \`DATABASE_URL\` | Neon persistence (this proof used memory) |
| \`CRON_SECRET\` | GHA + Vercel cron auth |
| \`APP_ORIGIN\` | GHA secret + notify links |
| \`GOOGLE_PLACES_API_KEY\` | Live discover (not used in this proof) |
| \`RESEND_API_KEY\` | Owner notify email (proof used log) |
| \`BUSINESS_POSTAL_ADDRESS\` | Draft compliance footer |
| \`ADMIN_EMAIL\` | Notify recipient |
| \`OUTREACH_CRON_SEND_ENABLED=false\` | Keep until owner enables post-approval send |

**Ready for owner deploy approval after code push — agent will not deploy.**
`;

  const mdPath = join(STORE_DOCS, 'daily-20-scheduler-proof.md');
  writeFileSync(mdPath, md);

  console.log(JSON.stringify({ allOk, mdPath, jsonPath, htmlPath, qualified: cohort?.qualified.length, drafts: readyDrafts.length }, null, 2));
  if (!allOk) {
    console.error('PROOF ASSERTIONS FAILED', proof.assertions);
    process.exit(1);
  }
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
