#!/usr/bin/env python3
"""
BBL Studio — Mac CRM push sync (outbound only).

Reads local leads.db in READ-ONLY mode and POSTs a JSON snapshot to the
website CRM ingest endpoint. Never sends email. Never starts campaigns.
Never exposes SQLite to the public internet.

Usage (on Mac, when worker is online):

  export CRM_SYNC_SECRET='…'          # same value as Vercel
  export CRM_SYNC_URL='https://www.bbl.studio/api/crm/sync'
  export LEADS_DB='/path/to/leads.db' # default: ./leads.db
  python3 scripts/crm-mac-sync/push_crm_sync.py

Optional:
  CRM_SYNC_MODE=replace|merge   (default replace)
  CRM_SYNC_DRY_RUN=1            print payload, do not POST
  SOURCE_HOST=macbook-safa

Safety: this script has no Resend / SMTP / send path.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def open_readonly(db_path: Path) -> sqlite3.Connection:
    if not db_path.exists():
        raise SystemExit(f"leads.db not found: {db_path}")
    uri = f"file:{db_path.resolve()}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
        (name,),
    ).fetchone()
    return bool(row)


def columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {str(r["name"]) for r in conn.execute(f"PRAGMA table_info({table})")}


def tri(value: Any, yes_values: set[str] | None = None) -> str:
    if value is None or value == "":
        return "UNKNOWN"
    s = str(value).strip().upper()
    if s in {"YES", "NO", "UNKNOWN"}:
        return s
    yes_values = yes_values or {"1", "TRUE", "YES", "Y"}
    if s in yes_values:
        return "YES"
    if s in {"0", "FALSE", "NO", "N"}:
        return "NO"
    return "UNKNOWN"


def normalize_email(value: Any) -> str:
    return str(value or "").strip().lower()


def has_valid_email(email: str) -> bool:
    return bool(email) and "@" in email


def is_truthy_int(value: Any) -> bool:
    if value is None or value is False:
        return False
    if value is True:
        return True
    s = str(value).strip().lower()
    return s in {"1", "true", "yes", "on"}


_HTTP_200_RE = re.compile(r"(?:http\s*=\s*200|\bstatus(?:Code)?\s*[:=]\s*200\b)", re.I)


def provider_accepted(provider_message_id: Any, detail: Any, provider: Any = None) -> bool:
    """Accepted only with provider_message_id + successful provider response evidence."""
    pmid = str(provider_message_id or "").strip()
    if not pmid:
        return False
    detail_s = str(detail or "")
    if _HTTP_200_RE.search(detail_s):
        return True
    # Some older rows store only "sent via Resend" without http=200 — those stay UNKNOWN.
    _ = provider
    return False


def fetch_leads(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    if not table_exists(conn, "leads"):
        for candidate in ("lead", "contacts"):
            if table_exists(conn, candidate):
                return _fetch_leads_from(conn, candidate)
        return []
    return _fetch_leads_from(conn, "leads")


def _fetch_leads_from(conn: sqlite3.Connection, table: str) -> list[dict[str, Any]]:
    cols = columns(conn, table)
    rows = conn.execute(f"SELECT * FROM {table}").fetchall()
    out: list[dict[str, Any]] = []
    for row in rows:
        d = dict(row)
        email = normalize_email(d.get("email") or d.get("contact_email"))
        business = str(d.get("business_name") or d.get("business") or d.get("name") or "").strip()
        if not business:
            continue
        lead_id = d.get("id")
        contactable = has_valid_email(email)
        status = d.get("status") or d.get("sales_status") or d.get("outreach_status")
        email_status = d.get("email_status") or d.get("delivery_status") or d.get("email_delivery_status")
        outreach_status = str(d.get("email_outreach_status") or "").strip()

        if not contactable:
            # Include no-email leads; never auto-eligible for outreach.
            email = ""
            email_status = "NOT CONTACTABLE"
            if not outreach_status or outreach_status.upper() in {"NEW", "NOT_READY", ""}:
                outreach_status = "NOT_CONTACTABLE"

        # Never invent acceptance from local SENT alone — history attach decides.
        accepted = "UNKNOWN"
        delivered = tri(d.get("delivered") or d.get("email_delivered"))
        if delivered == "UNKNOWN":
            delivered = tri(
                d.get("email_delivery_status") if str(d.get("email_delivery_status") or "").upper() in {"YES", "NO", "DELIVERED"} else None,
                {"DELIVERED", "YES"},
            )
        bounced = tri(d.get("bounced") or d.get("email_bounced"))
        replied = tri(d.get("replied") or d.get("email_replied") or d.get("email_reply_status"), {"REPLIED", "YES"})

        out.append(
            {
                "id": lead_id,
                "business_name": business,
                "contact_name": d.get("contact_name")
                or d.get("contact_first_name")
                or d.get("owner_name")
                or d.get("contact"),
                "email": email,
                "phone": d.get("phone"),
                "location": d.get("location") or d.get("city") or d.get("area") or d.get("address"),
                "category": d.get("category") or d.get("business_type"),
                "status": status,
                "sales_status": d.get("sales_status"),
                "email_status": email_status,
                "email_outreach_status": outreach_status or None,
                "contactable": contactable,
                "last_contacted_at": d.get("last_contacted_at")
                or d.get("last_contacted")
                or d.get("last_email_sent_at")
                or None,
                "last_activity_at": d.get("last_activity_at")
                or d.get("email_last_activity_at")
                or d.get("updated_at")
                or None,
                "notes": d.get("notes") or d.get("review_notes"),
                # Genuine public-site note for cold email — never invent on the website.
                "website_observation": (
                    d.get("website_observation")
                    or d.get("outreach_observation")
                    or None
                ),
                "outreach_observation": (
                    d.get("outreach_observation")
                    or d.get("website_observation")
                    or None
                ),
                "suppressed": bool(d.get("suppressed") or d.get("is_suppressed") or d.get("opted_out")),
                "unsubscribed": bool(d.get("unsubscribed") or d.get("is_unsubscribed") or d.get("opted_out")),
                "email_accepted": accepted,
                "delivered": delivered if delivered in {"YES", "NO", "UNKNOWN"} else "UNKNOWN",
                "bounced": bounced,
                "replied": replied,
                "booked": tri(
                    d.get("booked")
                    or (str(status or "").upper() == "BOOKED")
                    or (str(d.get("sales_status") or "").upper() == "BOOKED")
                    or d.get("booking_status")
                    or d.get("booked_at"),
                    {"BOOKED", "YES", "1", "TRUE", "CONFIRMED"},
                ),
                "booking_status": d.get("booking_status"),
                "provider_message_ids": [],
            }
        )
        _ = cols
    return out


def fetch_email_history(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    """Pull outreach send history including Resend message ids (actual table: email_outreach_history)."""
    candidates = [
        "email_outreach_history",
        "email_send_history",
        "email_history",
        "outreach_sends",
        "campaign_sends",
        "email_statuses",
        "sent_emails",
    ]
    table = next((t for t in candidates if table_exists(conn, t)), None)
    if not table:
        return []

    cols = columns(conn, table)
    rows = conn.execute(f"SELECT * FROM {table} ORDER BY rowid DESC LIMIT 5000").fetchall()
    out: list[dict[str, Any]] = []
    seen_keys: set[str] = set()

    for row in rows:
        d = dict(row)
        email = normalize_email(d.get("email") or d.get("to_email") or d.get("recipient"))
        # History may exist for contactable leads only; skip blank emails.
        if not has_valid_email(email):
            continue

        provider_id_raw = (
            d.get("provider_message_id")
            or d.get("resend_id")
            or d.get("resend_message_id")
            or d.get("message_id")
            or d.get("email_id")
        )
        provider_id = str(provider_id_raw).strip() if provider_id_raw else ""
        if provider_id == "":
            provider_id = None

        status = str(d.get("status") or d.get("email_status") or "").upper() or None
        dry_run = is_truthy_int(d.get("dry_run"))
        # Preserve dry_run; DRY_RUN_SENT is never an actual send.
        if status == "DRY_RUN_SENT":
            dry_run = True

        detail = d.get("detail") or d.get("provider_response") or d.get("response") or ""
        accepted = "UNKNOWN"
        if (
            not dry_run
            and status in {"SENT", "ACCEPTED"}
            and provider_accepted(provider_id, detail, d.get("provider"))
        ):
            accepted = "YES"
        # Local SENT alone (no provider_message_id + http=200) stays UNKNOWN.

        row_id = d.get("id")
        sent_at = d.get("sent_at") or d.get("created_at")
        # Idempotent key: prefer stable DB id, else provider id, else composite.
        if row_id is not None and str(row_id).strip() != "":
            hist_id = f"eoh:{row_id}"
        elif provider_id:
            hist_id = f"pmid:{provider_id}"
        else:
            hist_id = f"{email}:{d.get('campaign_id') or ''}:{sent_at or ''}:{status or ''}"

        if hist_id in seen_keys:
            continue
        seen_keys.add(hist_id)

        out.append(
            {
                "id": hist_id,
                "lead_id": d.get("lead_id"),
                "email": email,
                "business_name": d.get("business_name"),
                "subject": d.get("subject"),
                "campaign_name": d.get("campaign_name")
                or d.get("campaign")
                or d.get("campaign_id")
                or d.get("batch"),
                "provider_message_id": provider_id,
                "status": status,
                "dry_run": dry_run,
                "accepted": accepted,
                "delivered": "UNKNOWN",  # delivery only from signed webhooks
                "bounced": "UNKNOWN",
                "replied": "UNKNOWN",
                "sent_at": sent_at,
            }
        )
        _ = cols
    return out


def fetch_bookings(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    for table in ("booking_events", "bookings", "consultations"):
        if not table_exists(conn, table):
            continue
        rows = conn.execute(f"SELECT * FROM {table} ORDER BY rowid DESC LIMIT 1000").fetchall()
        out: list[dict[str, Any]] = []
        for row in rows:
            d = dict(row)
            email = normalize_email(d.get("email") or d.get("lead_email"))
            if not has_valid_email(email):
                continue
            out.append(
                {
                    "id": str(d.get("id") or f"{email}:{d.get('meeting_start') or d.get('booked_at') or ''}"),
                    "email": email,
                    "name": d.get("name") or d.get("contact_name"),
                    "lead_id": d.get("lead_id"),
                    "meeting_start": d.get("meeting_start") or d.get("starts_at"),
                    "booked_at": d.get("booked_at") or d.get("created_at"),
                    "status": "confirmed"
                    if str(d.get("status") or "confirmed").lower() in {"confirmed", "booked"}
                    else "unknown",
                }
            )
        return out
    return []


def fetch_suppressions(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    for table in ("email_suppressions", "suppressions", "unsubscribes"):
        if not table_exists(conn, table):
            continue
        rows = conn.execute(f"SELECT * FROM {table}").fetchall()
        out: list[dict[str, Any]] = []
        for row in rows:
            d = dict(row)
            email = normalize_email(d.get("email"))
            if not has_valid_email(email):
                continue
            out.append(
                {
                    "email": email,
                    "lead_id": d.get("lead_id"),
                    "reason": d.get("reason"),
                    "created_at": d.get("created_at"),
                }
            )
        return out
    return []


def fetch_campaigns(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    for table in ("campaigns", "email_campaigns"):
        if not table_exists(conn, table):
            continue
        rows = conn.execute(f"SELECT * FROM {table} ORDER BY rowid DESC LIMIT 200").fetchall()
        out: list[dict[str, Any]] = []
        for row in rows:
            d = dict(row)
            cid = d.get("id")
            if cid is None:
                continue
            status = str(d.get("status") or "unknown").lower()
            if status not in {"draft", "dry_run", "sent"}:
                status = "unknown"
            out.append(
                {
                    "id": str(cid),
                    "name": d.get("name") or str(cid),
                    "subject": d.get("subject"),
                    "status": status,
                    "recipient_count": int(d.get("recipient_count") or d.get("recipients") or 0),
                    "accepted": d.get("accepted"),
                    "delivered": d.get("delivered"),
                    "bounced": d.get("bounced"),
                    "replied": d.get("replied"),
                    "booked": d.get("booked"),
                    "created_at": d.get("created_at"),
                    "sent_at": d.get("sent_at"),
                }
            )
        return out
    return []


def attach_provider_ids(leads: list[dict[str, Any]], history: list[dict[str, Any]]) -> None:
    by_email = {l["email"]: l for l in leads if has_valid_email(l.get("email") or "")}
    for item in history:
        lead = by_email.get(item["email"])
        if not lead:
            continue
        pid = item.get("provider_message_id")
        if pid:
            ids = lead.setdefault("provider_message_ids", [])
            if pid not in ids:
                ids.append(pid)
        # Only promote acceptance from verified provider acceptance — never dry_run / bare SENT.
        if item.get("accepted") == "YES" and not item.get("dry_run"):
            lead["email_accepted"] = "YES"
        # Delivery / bounce / reply stay UNKNOWN unless already YES from lead columns
        # (website webhooks are SoT for those fields after sync).


def build_payload(conn: sqlite3.Connection) -> dict[str, Any]:
    leads = fetch_leads(conn)
    history = fetch_email_history(conn)
    attach_provider_ids(leads, history)
    bookings = fetch_bookings(conn)
    suppressions = fetch_suppressions(conn)
    campaigns = fetch_campaigns(conn)
    for row in suppressions:
        lead = next((l for l in leads if l.get("email") and l["email"] == row["email"]), None)
        if lead:
            lead["suppressed"] = True
            if "unsub" in str(row.get("reason") or "").lower():
                lead["unsubscribed"] = True

    return {
        "schema_version": 1,
        "mode": env("CRM_SYNC_MODE", "replace") or "replace",
        "synced_at": utc_now(),
        "source_host": env("SOURCE_HOST") or os.uname().nodename,
        "leads": leads,
        "email_history": history,
        "campaigns": campaigns,
        "inbox": [],  # replies preferred via Resend inbound on website; Mac may fill later
        "bookings": bookings,
        "suppressions": suppressions,
    }


def accounting_summary(payload: dict[str, Any]) -> dict[str, int]:
    leads = payload.get("leads") or []
    history = payload.get("email_history") or []
    with_email = sum(1 for l in leads if has_valid_email(l.get("email") or ""))
    without_email = len(leads) - with_email
    not_contactable = sum(
        1
        for l in leads
        if not l.get("contactable", has_valid_email(l.get("email") or ""))
        or str(l.get("email_status") or "").upper() == "NOT CONTACTABLE"
    )
    dry_run_rows = sum(1 for h in history if h.get("dry_run"))
    live_sent = sum(
        1 for h in history if (not h.get("dry_run")) and str(h.get("status") or "").upper() == "SENT"
    )
    accepted_yes = sum(1 for h in history if h.get("accepted") == "YES" and not h.get("dry_run"))
    accepted_unknown_live_sent = sum(
        1
        for h in history
        if (not h.get("dry_run"))
        and str(h.get("status") or "").upper() == "SENT"
        and h.get("accepted") != "YES"
    )
    return {
        "leads": len(leads),
        "with_email": with_email,
        "without_email": without_email,
        "not_contactable": not_contactable,
        "email_history": len(history),
        "dry_run_history": dry_run_rows,
        "live_sent_history": live_sent,
        "accepted_yes": accepted_yes,
        "live_sent_accepted_unknown": accepted_unknown_live_sent,
    }


def post_payload(url: str, secret: str, payload: dict[str, Any]) -> dict[str, Any]:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {secret}",
            "X-BBL-CRM-Sync-Key": secret,
            "User-Agent": "bbl-crm-mac-sync/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = resp.read().decode("utf-8")
            return {"status": resp.status, "body": json.loads(body) if body else {}}
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(body)
        except json.JSONDecodeError:
            parsed = {"raw": body}
        return {"status": err.code, "body": parsed}


def main() -> int:
    db_path = Path(env("LEADS_DB", "./leads.db"))
    secret = env("CRM_SYNC_SECRET") or env("LEAD_AGENT_CRM_SECRET")
    url = env("CRM_SYNC_URL", "https://www.bbl.studio/api/crm/sync")
    dry = env("CRM_SYNC_DRY_RUN") in {"1", "true", "yes", "on"}

    if not secret and not dry:
        print("CRM_SYNC_SECRET is required (or set CRM_SYNC_DRY_RUN=1).", file=sys.stderr)
        return 2

    print(f"[crm-mac-sync] opening readonly {db_path}")
    conn = open_readonly(db_path)
    try:
        payload = build_payload(conn)
    finally:
        conn.close()

    summary = accounting_summary(payload)
    print(
        "[crm-mac-sync] snapshot:",
        f"leads={summary['leads']}",
        f"with_email={summary['with_email']}",
        f"without_email={summary['without_email']}",
        f"not_contactable={summary['not_contactable']}",
        f"email_history={summary['email_history']}",
        f"campaigns={len(payload['campaigns'])}",
        f"bookings={len(payload['bookings'])}",
        f"suppressions={len(payload['suppressions'])}",
    )
    print(
        "[crm-mac-sync] accounting:",
        f"dry_run_history={summary['dry_run_history']}",
        f"live_sent={summary['live_sent_history']}",
        f"accepted_yes={summary['accepted_yes']}",
        f"live_sent_accepted_unknown={summary['live_sent_accepted_unknown']}",
        "(delivery/bounce/reply default UNKNOWN)",
    )

    if dry:
        out = Path(env("CRM_SYNC_DRY_RUN_PATH", "./crm-sync-payload.dry-run.json"))
        # Scrub PII from console; full payload file is local-only for inspection.
        out.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        print(f"[crm-mac-sync] dry-run wrote {out} — no POST")
        return 0

    print(f"[crm-mac-sync] POST {url}")
    result = post_payload(url, secret, payload)
    print(json.dumps(result, indent=2))
    if result.get("status") != 200 or not (result.get("body") or {}).get("ok"):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
