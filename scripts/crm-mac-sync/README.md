# Mac CRM push sync

Outbound-only sync from local `leads.db` → BBL Studio website CRM cache.

## Rules

- Mac reads SQLite **readonly** (`mode=ro`)
- Mac **POSTs** to `https://www.bbl.studio/api/crm/sync`
- Never expose SQLite or Mac ports to the public internet
- **No email send** — this package has zero Resend/SMTP code
- Keep outreach flags off on both sides

## Setup

1. Set Vercel durable DB + the same sync secret on Mac:

```bash
# Vercel: CRM_DATABASE_URL=<Neon pooled URL>  (required — /tmp CRM storage is disabled)
export CRM_SYNC_SECRET='long-random-secret'
# Vercel project env: CRM_SYNC_SECRET=<same>
```

2. Point at your local DB and website:

```bash
export LEADS_DB='/Users/…/bbl_studio_agent/leads.db'
export CRM_SYNC_URL='https://www.bbl.studio/api/crm/sync'
```

3. Dry-run (no network):

```bash
CRM_SYNC_DRY_RUN=1 python3 push_crm_sync.py
```

4. Push:

```bash
python3 push_crm_sync.py
```

## Suggested schedule

Neon persists snapshots across deploys. Still re-push every 15–60 minutes with `launchd` or cron when the Mac is awake so CRM stays current.

## Auth

```
Authorization: Bearer <CRM_SYNC_SECRET>
# or
X-BBL-CRM-Sync-Key: <CRM_SYNC_SECRET>
```

## What gets synced

| Slice | Source |
|---|---|
| leads | **all** `leads` rows (no-email → `NOT CONTACTABLE`, never outreach-eligible) |
| email_history | `email_outreach_history` (actual schema) + fallbacks; Resend ids when present |
| campaigns | optional campaigns tables |
| bookings | `booking_events` / bookings if present |
| suppressions | `email_suppressions` / unsub tables |
| inbox | empty by default; website prefers Resend inbound webhooks |

### Acceptance / tracking rules

- **Accepted = YES** only when `dry_run=0`, status SENT/ACCEPTED, `provider_message_id` present, and provider success evidence (`http=200` in `detail`)
- Local SENT alone → **UNKNOWN** (not provider acceptance)
- Delivery / bounce / reply → **UNKNOWN** until signed Resend webhooks on the website
- Dry-run / `DRY_RUN_SENT` rows are preserved but **never** counted as actual sends
- History ids are stable (`eoh:<id>`) so repeat syncs are idempotent

## Safety confirmation

```
EMAIL SEND: never
CAMPAIGN START: never
LIVE OUTREACH: never
DB MODE: readonly
DIRECTION: Mac → website only
```
