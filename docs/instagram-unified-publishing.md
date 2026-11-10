# Instagram Unified Login publishing

The existing publishing worker defaulted to Instagram Login's
`graph.instagram.com`. BBL's Meta app uses Unified Login and a separate
business-owned system-user token, which requires `graph.facebook.com`.
`INSTAGRAM_LOGIN_MODE=unified` selects that fixed origin with Graph v27.0 by
default. Existing Instagram Login configurations keep their previous origin and
version. Invalid modes and versions fail closed.

## Secure configuration

Store `INSTAGRAM_ACCESS_TOKEN` only as a sensitive Production environment variable
on the existing `bbl-studio` Vercel project. Do not replace
`INSTAGRAM_READ_ACCESS_TOKEN`, reuse the booking credentials, add a browser token
to source control, or put it in a local environment file.

Non-secret configuration:

- `INSTAGRAM_LOGIN_MODE=unified`
- `INSTAGRAM_ACCOUNT_ID=17841467961734048`
- `META_GRAPH_VERSION=v27.0`

The separate Meta configuration `BBL Growth Publishing` requests only
`instagram_basic` and `instagram_content_publish`; Meta also supplies its default
`public_profile`. Limit the consent to `@businessbrandlab`. The owner approved a
system-user token without automatic expiry. Such a token can still be revoked by
Meta or the account owner. Do not add advertising, direct-message, or comment
permissions. Do not disable the existing read integration.

## No-publication verification

After an explicitly approved backend deployment, an authenticated owner may open
`GET /api/admin/crm/growth/instagram/preflight`. It makes only bounded, retryable
GET requests to the fixed Meta origin:

1. Fetch the configured account's exact `id` and `username`; require the configured
   ID and `businessbrandlab` before the next request.
2. Read `content_publishing_limit?fields=quota_usage,config`.

The result reports observed quota data and always returns `published: 0` and
`queued: 0`. A successful preflight confirms those reads, not a successful content
publication. It does not create media containers, save a queue, invoke the worker,
or touch email/website content. Provider error details and credentials are never
returned. Unauthorized requests cannot reach the provider.

Local tests inject a mock provider; they do not validate a real credential. Report
the live provider test separately from these tests and from Vercel secret storage.
Saving a Vercel environment variable does not update an already-running deployment.

## Preserve the existing Meta schedule

The owner-approved Reels at 10:00 America/Los_Angeles on 11, 13, 16 and 18 November
2026 were already uploaded and individually verified in Meta Business Suite.
Do **not** insert these four posts into `growth:social:v1` or upload them again.
Meta holds these schedules independently of the user's Mac.

Do not enable `SOCIAL_PUBLISH_ENABLED` as part of credential setup. Enabling the
worker also requires reconciling the complete existing Meta queue and assigning
trusted immutable media storage through `SOCIAL_MEDIA_HOSTS`. Every future post
must retain its exact caption/media checksum/time approval. The existing lease,
approval digest, uncertain-POST hold and durable receipt protections remain in
place. No test publication is authorized by this verification procedure.
