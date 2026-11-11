# Exact approved batch delivery and reply monitoring

`POST /api/crm/approved-outreach/monitor` requires the existing CRON credential and reads only the configured Production five-message manifest. It verifies the actual BBL mailbox/provider identity, retrieves delivery receipts and a complete mailbox scan, and updates CRM history and campaign state. It cannot send email or publish content. Receipt errors and incomplete mailbox scans return a partial/failing report rather than false delivery or zero-reply claims.

A reply must postdate the original send. Matching subject and sender, or an explicit reply header, identify a matching thread; unrelated messages remain visibly marked candidates. Automated replies are excluded from human reply counts and response drafting. Opt-outs and failed delivery suppress future outreach. Quoted unsubscribe footers do not count as an opt-out. Proposed responses are unapproved drafts; customer text cannot authorize commitments or execute actions.

Manual workflow input `monitor_approved_batch=true` must be used with `execute_approved_batch=false`. These jobs are mutually exclusive, and monitoring skips the general growth/social worker. No publishing or sender flags are enabled. Provide a short-lived public X.509 encryption certificate in `report_certificate`; keep its private key local. Only hashed recipient identifiers, receipt statuses, counts and provider IDs reach logs. Full private reply text and drafts are encrypted with CMS AES-256/RSA-OAEP before upload as the one-day `private-approved-five-monitor` artifact. Do not upload the private key or plaintext report.

Download and decrypt the artifact locally, verify the five provider IDs against the original accepted-send report, and review any response draft before requesting owner approval. A provider acceptance is not proof of inbox delivery, and delivery is not proof of reading. No automatic re-send occurs.

Tests cover delivery persistence, zero transmission, quoted-footer handling, opt-outs, automatic/unrelated/old messages, draft deduplication, incomplete scans, provider errors, and identity mismatch. Public website pages, assets and copy are unaffected.
