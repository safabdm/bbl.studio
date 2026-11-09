# BBL Studio growth operation — implementation and evidence

Audit date: November 9, 2026 (America/Los_Angeles). Base: `efa9bff3d562b16b794bef4e59c93e048ca4693e`.

## Current scope: agents and automation only

Owner instruction: do not change the website. All frontend changes from the initial local commit have been removed. `app/`, `public/`, styles, website copy and public page routing match the base. Growth metrics, sales review and social approval are authenticated server APIs; no new website screen is included. No deployment, email transmission or publishing is authorized by preparing this PR.

## Existing systems reused

| System | Repository capability | Observed production evidence |
| --- | --- | --- |
| CRM | Neon snapshot, leads, provider history, suppression store, webhook updates | Public readiness reports durable DB configured. Actual rows and freshness need authenticated admin access. |
| Daily-20 | Places discovery, official-site evidence, email enrichment, ranked review cohort, Email Studio | Public readiness reports Places configured, scheduler enabled, GitHub primary and Vercel backups configured. No authenticated batch result verified. |
| Approvals / sends | Email Studio, signed previews, send controls, caps, signed opt-out links | Readiness reports manual live send disabled and cron send disabled. These flags do **not** describe the separate legacy Marketing Agent. |
| Marketing Agent | Outlook scan, delivery receipts, follow-ups, bounded first-five campaign | `/api/crm/marketing/ready` reports no configuration blockers and `live_checked:false`. A scheduled GitHub run on November 9 UTC completed successfully. This establishes HTTP workflow execution, not leads, sends or delivery. |
| Booking | Existing Google calendar and booking service | Configured in Marketing readiness; no authenticated calendar read performed in this task. |
| SEO/GEO | Existing site metadata, structured data, sitemap, robots, llms.txt | Source files inspected; no Search Console or Analytics account verified. |
| Social | No server social queue found in inspected source | Connected Metricool tool returned no connected social networks (brand 7910031). Neither Instagram nor LinkedIn is verified connected. |

Read-only production probes used:

- `https://www.bbl.studio/api/crm/outreach/ready`
- `https://www.bbl.studio/api/crm/marketing/ready`
- GitHub Actions run `42575129036` (success at base SHA; no campaign receipt claim).

No authenticated production state was modified. No prospect email, social scheduling/publishing, merge or deployment was performed. Production continues running its existing code until an approved deployment; this PR cannot retroactively change its behavior.

## Implemented changes

- **Marketing becomes draft-only.** Both initial/follow-up and conversation paths persist deduplicated drafts. No Marketing tick invokes the email sender. Acceptance becomes an owner handoff, never a paid-client count. Historical provider receipts continue to be checked. Complete authorized Outlook messages are saved (bounded to 200), and full-text opt-outs join durable suppressions. The scan includes known CRM/history contacts, not only today's shortlist.
- **Existing morning automation is hardened.** A database lease coordinates GitHub and Vercel dispatches. A failed stage stops downstream preparation. Five website reads per Places response and four enrichment reads at a time replace serial network waits. Writes remain ordered. Daily-20 preserves the current day’s review cohort but excludes already-prepared drafts from being counted as new prospects on subsequent days. Existing owner-edited/approved drafts are preserved during scheduler retries. The serverless execution budget is 300 seconds; real provider throughput still needs a staging check.
- **Unified growth data API at `/api/admin/crm/growth`.** Reuses existing stores and exposes unavailable sources, timestamps, morning health, logs, verified provider acceptance, reply senders, confirmed booking snapshots, owner-evidenced sales stages, review drafts and content receipts. Provider acceptance is distinct from delivery. Missing Instagram analytics are `null`, not invented zeros. Snapshot-based metrics are labeled and may be stale/partial.
- **Sales assistance.** Authorized inbound messages are automatically turned into bounded, evidence-linked review suggestions; existing owner sales stages are preserved. Classification and response/proposal preparation are bounded drafts. Proposals require owner-supplied verified requirements; pricing, timelines and contracts remain uncommitted. The existing first-five offer is preserved as draft copy. Owner evidence is required to record a deal.
- **Social review and provider adapters.** Authenticated, same-origin owner approval binds the exact network, LinkedIn author/account, caption, rendered-media checksum, video URI and timestamp(s). Edits remove approval. Duplicate content across IDs is blocked. A lease and durable claim precede every provider mutation. An uncertain POST is never automatically retried. Instagram requires the returned username `businessbrandlab`; LinkedIn uses the exact owner-approved author (and stops if configured account changes) and current Posts API. Optional recurring publication requires a finite list of exact owner-approved ISO timestamps, including DST offsets, at least one day apart (maximum 12 occurrences). Provider receipts are retained per occurrence.
- **SEO/GEO monitor.** Fixed BBL URLs are audited for reachability, title, canonical, description, structured-data and viewport markers. Read-only Google OAuth retrieves a bounded Search Console query/page sample and a GA4 session-source/medium/landing-page report. Neither sample is mislabeled as a total or exact rank. GA4 key events reflect the site's configured events; AI-referral attribution exists only where the source is measurable. Missing permissions stay unavailable. Only safe reads/query requests use bounded backoff/retries.
- **Original motion pipeline.** `scripts/reels/render.py` renders a four-scene JSON storyboard into genuine 1080×1920, 30fps H.264 MP4, burned-in captions, SRT, caption/hashtag metadata, storyboard and decoded-video QA report. `--spec` accepts another reviewed four-scene storyboard. No video generation service is required. This agent authored the original proof; unattended AI script generation is not represented as connected.
- **Cloud verification.** PR CI runs the focused growth typecheck, all tests, synthetic no-send pipeline, Vercel build and motion render; outputs are downloadable CI artifacts. Existing marketing cloud schedule is reused for growth checks. No second lead scheduler is introduced.

## Verification

Local verification uses the supplied Node 24.22.1 runtime; the repository targets Node 22. CI explicitly uses Node 22 and pnpm 10.33.4. Dependency lockfile unchanged.

- Full local suite: **219 tests passed, 0 failed**. Command: `pnpm exec tsx --test server/*.test.ts api/*.test.ts`.
- Focused typecheck: `pnpm exec tsc --noEmit --project tsconfig.growth.json`.
- New growth modules lint: `pnpm exec oxlint server/growth.ts server/growth-monitor.ts server/growth-social.ts server/growth.test.ts `.
- No-send proof: `pnpm proof:daily-20-scheduler`. Isolated in-memory data, synthetic `.example` leads, no provider credentials, global HTTP blocked; 20 unapproved drafts from 34 fixture rows. Does not claim 20 actual businesses or any live campaign outcome.
- Both `pnpm build` (Vinext) and `pnpm exec vite build --config vite.vercel.config.ts` pass locally.
- Motion proof: 18 seconds, 540 decoded frames, 18 distinct sampled frames, 1080×1920, 30fps, intentional silent motion with burned-in captions. Original content offers general UX guidance, no fabricated case study or conversion uplift.
- Repository-wide `pnpm typecheck` and `pnpm lint` still fail. Untouched base was reproduced separately: 115 TypeScript diagnostics before generated Vinext declarations; 381 after matching generated declarations, plus widespread existing lint errors. Full typecheck also flags the new API's `process.env` arguments under that existing environment-type incompatibility. The focused growth graph passes. This is an explicit release blocker, not a clean full-check claim.

Artifacts are in ignored `outputs/growth-proof/` and `outputs/reels/`. CI regenerates them; no prospect fixture data is imported into production.

## Activation blockers and owner-controlled rollout

1. **Review the PR and resolve repository-wide type/lint failures before release.** This is a reviewable implementation, not a verified production activation.
2. **Approve deployment.** This branch has a Vercel ignored-build rule matching `codex/autonomous-growth-agency`, preventing automatic preview publication while preparing the PR. No deploy command is run. Remove/adjust the branch guard only with explicit deployment approval. Existing production cron behavior remains unchanged until deployment.
3. **Read authenticated production data.** Verify real Daily-20 rows, scheduler execution logs, last CRM snapshot, Outlook identity/read scope, provider receipts, calendar bookings and suppression freshness. Do not run any send while doing so. Readiness configuration alone is insufficient.
4. **Google monitoring.** Supply separate server-side OAuth credentials with `webmasters.readonly` and `analytics.readonly`, correct Search Console property and GA4 property, then set `GROWTH_MONITOR_ENABLED=true`. No secrets belong in Git, browser bundles or chat. Booking OAuth is not silently reused for extra scopes.
5. **Social authorization and existing queue.** Metricool currently has no connected networks. Connect Instagram/LinkedIn through the authorized provider, or configure the direct adapters' approved app tokens and author IDs. This code uses direct server APIs; a chat connector token is not a cloud credential. Audit/import existing scheduled/published items through the review queue before setting `SOCIAL_QUEUE_RECONCILED_AT` and enabling `SOCIAL_PUBLISH_ENABLED=true`. Media must be hosted on immutable HTTPS storage on an explicit `SOCIAL_MEDIA_HOSTS` allowlist. The worker streams and checks the actual MP4 checksum before creating an Instagram container; redirects are rejected, input is limited to 64 MiB, and no provider Authorization header is sent to media storage. Owner QA still verifies motion, rights, brand and captions. LinkedIn video must already be uploaded with the authorized Videos API; this implementation accepts the resulting video URN. Instagram token requires professional-account content-publish permissions. Provider acceptance testing remains blocked by account access.
6. **Approve content individually or as a finite recurring series.** API payload `post.repeatAt` contains additional ISO times with explicit offsets. All are bound into the approval digest. Rendering and adding a review item do not approve or publish it. Social reach/engagement ingestion remains unavailable; no connected-account analytics were invented.
7. **Outreach approval.** Review drafts in Daily Review / Email Studio. Marketing conversation drafts and sales suggestions are exposed by the authenticated growth API for owner handling; transferring them does not bypass the existing send restrictions. No automated pricing/contract commitment is made. Do not enable sending globally as a substitute for individual approval.

Operational failures surface through durable dashboard logs and failed GitHub jobs (repository notification settings govern owner alerts). There is no newly configured external alert webhook, backlink provider, paid rank tracker, or automatic proposal transmission. Daily discovery is bounded and evidence-filtered; if fewer than 20 genuine prospects qualify, report the shortfall rather than padding.

Provider references: [LinkedIn Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-09), [Instagram content publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing/), [Search Console API](https://developers.google.com/webmaster-tools/v1/api_reference_index), [Vercel ignored build step](https://vercel.com/docs/project-configuration/project-settings).

## GitHub access follow-up

The installed connector reports repository push permission but its Git tree write returned HTTP 403. The existing Chrome session is signed into the repository owner account. No app permissions or new credentials have been granted; use the existing authenticated GitHub UI if native Git authentication remains unavailable.

## Server API handoff (no website changes)

- `GET /api/admin/crm/growth`: existing admin session required; data sources, metrics, failures, sales review suggestions and current queues.
- `POST /api/admin/crm/growth/sales`: same-origin admin session; `email`, `stage`, `requirements`, `evidence`; proposals require verified requirements and remain drafts.
- `POST /api/admin/crm/growth/social`: same-origin admin session; `post` is saved in review. Approving requires `approval.digest` computed by `socialDigest(post)` plus an owner `qa` note. LinkedIn posts include the exact `authorUrn`. Account, media, content or schedule changes require new approval. No provider access is used while saving a review item.
- `GET /api/crm/growth/tick`: server cron bearer secret; draft-only marketing/reply checks, evidence-linked sales suggestions, optional read-only monitoring, and only previously approved social publications when explicitly enabled. Missing credentials never trigger fabricated success.

Draft preparation works with `EMAIL_DRY_RUN=true`; no live-send setting is required to enable it. Sales review suggestions do not overwrite owner-confirmed pipeline stages. Do not place API tokens, admin cookies or provider secrets into this document or PR.

Git authentication follow-up: official GitHub CLI v2.103.3 was downloaded from `cli/cli` releases and checksum-verified. Its normal device authorization is prepared for owner review; no token was requested in chat. OAuth app access and secure login storage require the owner’s final authorization.
