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


def fetch_leads(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    if not table_exists(conn, "leads"):
        # Fallback common names
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
        if not email or "@" not in email or not business:
            continue
        lead_id = d.get("id")
        status = d.get("status") or d.get("sales_status") or d.get("outreach_status")
        email_status = d.get("email_status") or d.get("delivery_status")
        accepted = tri(
            d.get("email_accepted")
            or d.get("accepted")
            or (email_status if str(email_status or "").upper() in {"SENT", "ACCEPTED"} else None),
            {"SENT", "ACCEPTED", "YES", "1", "TRUE"},
        )
        out.append(
            {
                "id": lead_id,
                "business_name": business,
                "contact_name": d.get("contact_name") or d.get("owner_name") or d.get("contact"),
                "email": email,
                "phone": d.get("phone"),
                "location": d.get("location") or d.get("city") or d.get("area"),
                "category": d.get("category") or d.get("business_type"),
                "status": status,
                "sales_status": d.get("sales_status"),
                "email_status": email_status,
                "last_contacted_at": d.get("last_contacted_at") or d.get("last_contacted"),
                "last_activity_at": d.get("last_activity_at") or d.get("updated_at"),
                "notes": d.get("notes"),
                "suppressed": bool(d.get("suppressed") or d.get("is_suppressed")),
                "unsubscribed": bool(d.get("unsubscribed") or d.get("is_unsubscribed")),
                "email_accepted": accepted,
                "delivered": tri(d.get("delivered") or d.get("email_delivered")),
                "bounced": tri(d.get("bounced") or d.get("email_bounced")),
                "replied": tri(d.get("replied") or d.get("email_replied")),
                "booked": tri(
                    d.get("booked")
                    or (str(status or "").upper() == "BOOKED")
                    or d.get("booking_status"),
                    {"BOOKED", "YES", "1", "TRUE", "CONFIRMED"},
                ),
                "booking_status": d.get("booking_status"),
                "provider_message_ids": [],
            }
        )
        # keep unused cols lint quiet
        _ = cols
    return out


def fetch_email_history(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    """Pull outreach send history including Resend message ids (the 9 cohort)."""
    candidates = [
        "email_send_history",
        "email_history",
        "outreach_sends",
        "campaign_sends",
        "email_statuses",
        "sent_emails",
    ]
    table = next((t for t in candidates if table_exists(conn, t)), None)
    if not table:
        # Try generic query against email_provider_events for message ids only
        if table_exists(conn, "email_provider_events"):
            return []
        return []

    cols = columns(conn, table)
    rows = conn.execute(f"SELECT * FROM {table} ORDER BY rowid DESC LIMIT 5000").fetchall()
    out: list[dict[str, Any]] = []
    for row in rows:
        d = dict(row)
        email = normalize_email(d.get("email") or d.get("to_email") or d.get("recipient"))
        if not email or "@" not in email:
            continue
        provider_id = (
            d.get("provider_message_id")
            or d.get("resend_id")
            or d.get("resend_message_id")
            or d.get("message_id")
            or d.get("email_id")
        )
        status = str(d.get("status") or d.get("email_status") or "").upper() or None
        dry_run = bool(d.get("dry_run"))
        accepted = "YES" if status in {"SENT", "ACCEPTED"} and not dry_run else tri(d.get("accepted"))
        if status in {"SENT", "ACCEPTED"} and dry_run:
            # Still mark accepted UNKNOWN for dry_run; keep status
            accepted = "UNKNOWN"
        if status in {"SENT", "ACCEPTED"} and not dry_run:
            accepted = "YES"
        out.append(
            {
                "id": str(d.get("id") or provider_id or f"{email}:{d.get('sent_at') or ''}"),
                "lead_id": d.get("lead_id"),
                "email": email,
                "business_name": d.get("business_name"),
                "subject": d.get("subject"),
                "campaign_name": d.get("campaign_name") or d.get("campaign") or d.get("batch"),
                "provider_message_id": str(provider_id) if provider_id else None,
                "status": status,
                "dry_run": dry_run,
                "accepted": accepted,
                "delivered": tri(d.get("delivered")),
                "bounced": tri(d.get("bounced")),
                "replied": tri(d.get("replied")),
                "sent_at": d.get("sent_at") or d.get("created_at"),
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
            if not email or "@" not in email:
                continue
            out.append(
                {
                    "id": str(d.get("id") or f"{email}:{d.get('meeting_start') or d.get('booked_at') or ''}"),
                    "email": email,
                    "name": d.get("name") or d.get("contact_name"),
                    "lead_id": d.get("lead_id"),
                    "meeting_start": d.get("meeting_start") or d.get("starts_at"),
                    "booked_at": d.get("booked_at") or d.get("created_at"),
                    "status": "confirmed" if str(d.get("status") or "confirmed").lower() in {"confirmed", "booked"} else "unknown",
                }
            )
        return out
    return []


def fetch_suppressions(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    for table in ("suppressions", "email_suppressions", "unsubscribes"):
        if not table_exists(conn, table):
            continue
        rows = conn.execute(f"SELECT * FROM {table}").fetchall()
        out: list[dict[str, Any]] = []
        for row in rows:
            d = dict(row)
            email = normalize_email(d.get("email"))
            if not email or "@" not in email:
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
    by_email = {l["email"]: l for l in leads}
    for item in history:
        lead = by_email.get(item["email"])
        if not lead:
            continue
        pid = item.get("provider_message_id")
        if pid:
            ids = lead.setdefault("provider_message_ids", [])
            if pid not in ids:
                ids.append(pid)
        if item.get("accepted") == "YES":
            lead["email_accepted"] = "YES"
        if item.get("delivered") == "YES":
            lead["delivered"] = "YES"
        if item.get("bounced") == "YES":
            lead["bounced"] = "YES"
        if item.get("replied") == "YES":
            lead["replied"] = "YES"


def build_payload(conn: sqlite3.Connection) -> dict[str, Any]:
    leads = fetch_leads(conn)
    history = fetch_email_history(conn)
    attach_provider_ids(leads, history)
    bookings = fetch_bookings(conn)
    suppressions = fetch_suppressions(conn)
    campaigns = fetch_campaigns(conn)
    for row in suppressions:
        lead = next((l for l in leads if l["email"] == row["email"]), None)
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

    print(
        "[crm-mac-sync] snapshot:",
        f"leads={len(payload['leads'])}",
        f"email_history={len(payload['email_history'])}",
        f"campaigns={len(payload['campaigns'])}",
        f"bookings={len(payload['bookings'])}",
        f"suppressions={len(payload['suppressions'])}",
    )
    live_hist = [h for h in payload["email_history"] if not h.get("dry_run") and h.get("status") in {"SENT", "ACCEPTED"}]
    print(f"[crm-mac-sync] live SENT/ACCEPTED history rows: {len(live_hist)}")

    if dry:
        out = Path(env("CRM_SYNC_DRY_RUN_PATH", "./crm-sync-payload.dry-run.json"))
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
