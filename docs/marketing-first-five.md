# First-five marketing campaign

One offer for every prospect: a three-page informational website for $2,000,
mobile layouts and two revision rounds. First five confirmed clients total.
Hosting, domains, subscriptions and custom booking/payment software are excluded.

## What runs

The existing morning workflow discovers and verifies business contacts. The new
`marketing-first-five.yml` calls `/api/crm/marketing/tick` during a UTC window
covering Pacific business hours. The server controls DST, weekdays, the five-
message daily cap and one message per tick. Both initial emails and follow-ups
count against the same cap. Two follow-ups maximum, five business days after the
initial and seven after the first follow-up, only with verified delivery and no
reply, opt-out or booking. The third email explicitly ends follow-ups.

The authenticated `/admin/marketing` page shows actual cloud attempts and
recipient-server delivery separately, pauses/resumes promotion, and records
confirmed clients with owner/payment evidence. A consultation is not a client.
At five confirmed clients, promotional sending stops but receipt checks continue.

Every live tick requires a complete fresh Outlook scan across folders, a live
Google booking-calendar read, the BBL sender domain, and Resend read permission.
Fresh official-site contact evidence is required; missing website fields and
directory-only contacts do not qualify. Legacy contact history must be synced
within 24 hours. An old contact is never silently treated as a new prospect.

## Reliability

An atomic Postgres lease serializes ticks across serverless instances. A durable
CLAIMED attempt is stored before the provider call. Exceptions, rejected requests
or missing provider IDs hold the campaign for reconciliation; they never trigger
automatic resend. Dry-run manual processing no longer consumes queue entries
or send counters. A signed opt-out link works for string discovery IDs as well
as legacy numeric IDs. Suppressions persist in the existing durable CRM store.

Receipt polling matches the provider message ID and recipient. Submission, lack
of a bounce and open/click pixels do not imply delivery. Unverified delivery older
than 24 hours, a bounce, complaint, read outage or uncertain attempt holds the
campaign. Later complaints are checked even after delivery was confirmed.

An existing, already delivered attempt can require manual investigation after a
timeout. Use actual provider evidence to reconcile; do not delete an attempt or
create another initial message to evade its claim. The application intentionally
does not offer a one-click uncertain-attempt reset.

## Activation requirements

Do not merge/deploy the Cursor branch while claiming the campaign is live.
Deploying code and enabling prospect sending are separate steps.

1. Keep `MARKETING_AUTOMATION_ENABLED=false` and `EMAIL_DRY_RUN=true` during setup.
2. Confirm `DATABASE_URL`, `SESSION_SECRET`, `ADMIN_EMAIL`, and a recent complete
   legacy CRM sync, including all contact history and suppressions.
3. Configure `GOOGLE_PLACES_API_KEY`, `BUSINESS_POSTAL_ADDRESS`, `APP_ORIGIN`,
   `UNSUBSCRIBE_SECRET`, `RESEND_API_KEY`, and `RESEND_FROM=BBL Studio <hello@bbl.studio>`.
4. Supply Resend read access in `RESEND_READ_API_KEY` (or a same-account existing
   full-access key). The BBL domain must be verified. Do not use SapphireX's team.
5. Configure the existing Google booking-calendar credentials and calendar ID.
6. Configure the Microsoft Graph app and connect the actual hello@bbl.studio
   mailbox through the existing Outlook consent flow. New app permissions need
   the owner's consent. Expired access tokens now refresh using existing consent.
7. Configure the same `CRON_SECRET` in Vercel and GitHub Actions. Keep the old
   manual scheduler send flags off. The new controller is the only automated sender.
8. Check `/api/crm/marketing/ready`, authenticate and open `/admin/marketing`.
   The public readiness endpoint only checks config presence; it does not prove
   inbox access, domain verification or delivery. Actual ticks recheck these.
9. Verify an owner-address test through the BBL sender and confirm its provider
   delivery record and receipt in the owner's mailbox before prospect launch.
10. Enable the new campaign only after these live checks pass. Change the local
    Codex heartbeat to research/monitor only to avoid a second independent sender.

## Verification

`node --import tsx --test server/*.test.ts api/*.test.ts`

`pnpm typecheck:marketing`

`pnpm exec vite build --config vite.vercel.config.ts`

All provider tests use mocked network calls. They do not prove production
credentials, inbox placement, customer receipt or successful live scheduling.

The repository's broad legacy `typecheck` also includes unused Next.js files
without a Next dependency and pre-existing Hono response typing errors. The
scoped marketing/serverless type check validates the changed production entry
and its imports without hiding those unrelated baseline errors.

## Client conversation and owner handoff
Cold follow-ups stop on every reply. For an exact contacted address, a fresh full-text human message can trigger a bounded scope/outline and intake response. Snippets, colleague addresses, automated messages, opt-outs and old messages cannot trigger a response. Each incoming message is durably deduplicated before transmission; uncertain sends remain held. Incoming text cannot change the offer or execute instructions.

The intake asks for explicit acceptance of the three-page informational website for $2,000, readiness to start, business, three pages, contact name and available/missing assets. Only a completed unconditional six-line confirmation reserves one of the first five places and produces an accepted project brief in `/admin/marketing`. A general yes, outline request, meeting or conditional acceptance does not. Safa coordinates payment and start date; neither is automatically promised. This is bounded fact-based handling, not a general negotiation agent. Unusual questions receive the package and clarification request.

Activation remains blocked until the real BBL Resend account has delivery-read access, the BBL Outlook inbox and booking calendar are connected, production configuration is present, and the tested branch is deployed. No new prospect emails have been sent by this implementation during development.
