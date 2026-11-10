# Approval-only outreach and organic opportunities

The existing authenticated growth response now includes `opportunities`, derived
from the stored Google/technical snapshot without making more provider requests.
It reports evidence-linked technical actions, missing or empty reports, snapshot
freshness, and organic/recognizable AI-referral sessions within the returned GA4
sample. Empty, missing, malformed or stale attribution remains unknown, not a
site-wide zero. AI answer visibility and unattributed referrals are not measured.

Monitoring retries incomplete Google reads after an hour instead of caching the
failure for a whole day. Invalid or future snapshot timestamps trigger a fresh
read. Both Search Console and GA4 must succeed before the worker labels the
combined Google stage verified. No website edits are applied by these actions.

New Email Studio drafts use industry-neutral BBL service language and offer a
reply-based improvement outline before an optional consultation. They still
require a verified observation, suppression checks, compliance footer and owner
approval. Existing drafts and approvals are not rewritten automatically; use the
existing regeneration/review flow when appropriate. Regeneration clears approval.

The separate legacy first-five campaign still contains its older $2,000 offer.
That offer must be explicitly reconciled with the owner before approving those
drafts. This change does not enable sending, create a new scheduler, change
credentials, or deploy automatically. The cloud growth tick prepares drafts and
provider checks; it does not invoke a prospect sender.

Validation: existing backend/API suite plus attribution, empty/stale evidence
and partial-Google retry regressions. These tests use synthetic providers and
do not prove inbox placement, prospect interest or a daily live lead quota.
