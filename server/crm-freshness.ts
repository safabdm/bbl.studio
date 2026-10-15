/**
 * Freshness / event-versioning rules for CRM tracking fields.
 *
 * CRITICAL: Resend webhook updates must not be overwritten by older Mac sync
 * payloads. Merge by rank + source + timestamp.
 *
 * Rank (higher wins; never regress a field to a weaker state):
 *   0  UNKNOWN / empty / NO (for delivery-ish fields treat NO like unknown unless explicit)
 *   1  ACCEPTED / SENT (provider accepted — not delivered)
 *   2  DELAYED / FAILED
 *   3  DELIVERED / BOUNCED / COMPLAINED / REPLIED
 *
 * Source on equal rank:
 *   webhook > mac  (webhook wins ties)
 *
 * Timestamp: when rank and source-priority tie, newer `at` wins.
 */
import type { CrmEmailHistoryItem, CrmLead, TrackingTriState } from './crm-types';

export type TrackingSource = 'mac' | 'webhook';

export type TrackingFieldKey =
  | 'email_accepted'
  | 'delivered'
  | 'bounced'
  | 'replied'
  | 'email_status';

export type TrackingProvenance = {
  source: TrackingSource;
  rank: number;
  at: string;
  event_type?: string | null;
};

export type LeadTrackingMeta = Partial<Record<TrackingFieldKey, TrackingProvenance>>;

export type CrmLeadWithMeta = CrmLead & { tracking?: LeadTrackingMeta };
export type CrmEmailHistoryWithMeta = CrmEmailHistoryItem & { tracking?: LeadTrackingMeta };

const SOURCE_PRIORITY: Record<TrackingSource, number> = {
  mac: 1,
  webhook: 2,
};

export function trackingRankFromStatus(status: string | null | undefined): number {
  const s = String(status || '').toUpperCase();
  if (!s || s === 'UNKNOWN') return 0;
  if (s === 'SENT' || s === 'ACCEPTED') return 1;
  if (s === 'DELAYED' || s === 'FAILED') return 2;
  if (s === 'DELIVERED' || s === 'BOUNCED' || s === 'COMPLAINED' || s === 'REPLIED') return 3;
  return 0;
}

export function trackingRankFromTri(value: TrackingTriState | null | undefined, field: TrackingFieldKey): number {
  if (value === 'YES') {
    if (field === 'email_accepted') return 1;
    return 3; // delivered / bounced / replied YES
  }
  return 0;
}

export function provenanceFor(
  source: TrackingSource,
  rank: number,
  at: string,
  event_type?: string | null,
): TrackingProvenance {
  return { source, rank, at, event_type: event_type || null };
}

/** True when incoming should replace existing for this field. */
export function shouldAcceptIncoming(
  existing: TrackingProvenance | undefined,
  incoming: TrackingProvenance,
): boolean {
  if (!existing) return incoming.rank > 0 || incoming.source === 'webhook';
  if (incoming.rank > existing.rank) return true;
  if (incoming.rank < existing.rank) return false;
  // Equal rank: webhook beats mac; then newer timestamp.
  const srcDiff = SOURCE_PRIORITY[incoming.source] - SOURCE_PRIORITY[existing.source];
  if (srcDiff > 0) return true;
  if (srcDiff < 0) return false;
  const inTs = Date.parse(incoming.at);
  const exTs = Date.parse(existing.at);
  if (Number.isFinite(inTs) && Number.isFinite(exTs)) return inTs >= exTs;
  return false;
}

function isoNow(at?: string) {
  return at || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Merge Mac (or webhook) tracking onto an existing lead without regressing
 * stronger webhook-confirmed states.
 */
export function mergeLeadFreshness(
  existing: CrmLeadWithMeta | null | undefined,
  incoming: CrmLeadWithMeta,
  source: TrackingSource,
  at?: string,
  event_type?: string | null,
): CrmLeadWithMeta {
  const when = isoNow(at);
  const base: CrmLeadWithMeta = existing
    ? {
        ...existing,
        ...incoming,
        // Preserve stronger tracking unless merge says otherwise (set below).
        email_accepted: existing.email_accepted,
        delivered: existing.delivered,
        bounced: existing.bounced,
        replied: existing.replied,
        email_status: existing.email_status,
        provider_message_ids: [
          ...new Set([...(existing.provider_message_ids || []), ...(incoming.provider_message_ids || [])]),
        ],
        suppressed: Boolean(existing.suppressed || incoming.suppressed),
        unsubscribed: Boolean(existing.unsubscribed || incoming.unsubscribed),
        tracking: { ...(existing.tracking || {}) },
      }
    : {
        ...incoming,
        tracking: { ...(incoming.tracking || {}) },
      };

  if (!existing) {
    // First write: stamp provenance for non-unknown fields.
    return stampIncomingTracking(base, incoming, source, when, event_type);
  }

  const fields: Array<{ key: TrackingFieldKey; value: TrackingTriState | string | null | undefined; rank: number }> = [
    {
      key: 'email_accepted',
      value: incoming.email_accepted,
      rank: trackingRankFromTri(incoming.email_accepted, 'email_accepted'),
    },
    {
      key: 'delivered',
      value: incoming.delivered,
      rank: trackingRankFromTri(incoming.delivered, 'delivered'),
    },
    {
      key: 'bounced',
      value: incoming.bounced,
      rank: trackingRankFromTri(incoming.bounced, 'bounced'),
    },
    {
      key: 'replied',
      value: incoming.replied,
      rank: trackingRankFromTri(incoming.replied, 'replied'),
    },
    {
      key: 'email_status',
      value: incoming.email_status ?? null,
      rank: trackingRankFromStatus(incoming.email_status),
    },
  ];

  const tracking: LeadTrackingMeta = { ...(base.tracking || {}) };

  for (const field of fields) {
    // Skip empty/unknown Mac updates — never wipe webhook YES with UNKNOWN.
    if (source === 'mac' && (field.value == null || field.value === '' || field.value === 'UNKNOWN')) {
      continue;
    }
    const incomingProv = provenanceFor(source, field.rank, when, event_type);
    const existingProv =
      tracking[field.key] ||
      (existing
        ? provenanceFor(
            'mac',
            field.key === 'email_status'
              ? trackingRankFromStatus(existing.email_status)
              : trackingRankFromTri(existing[field.key] as TrackingTriState, field.key),
            existing.last_activity_at || when,
          )
        : undefined);

    if (!shouldAcceptIncoming(existingProv, incomingProv)) continue;

    tracking[field.key] = incomingProv;
    if (field.key === 'email_status') {
      base.email_status = field.value == null ? base.email_status : String(field.value);
    } else {
      (base as Record<string, unknown>)[field.key] = field.value;
    }
  }

  // Non-tracking Mac fields always refresh from Mac when present.
  if (source === 'mac') {
    base.business_name = incoming.business_name || base.business_name;
    base.contact_name = incoming.contact_name ?? base.contact_name;
    base.email = incoming.email || base.email;
    base.phone = incoming.phone ?? base.phone;
    base.location = incoming.location ?? base.location;
    base.category = incoming.category ?? base.category;
    base.status = incoming.status ?? base.status;
    base.sales_status = incoming.sales_status ?? base.sales_status;
    base.last_contacted_at = incoming.last_contacted_at ?? base.last_contacted_at;
    base.notes = incoming.notes ?? base.notes;
    base.booked = incoming.booked !== 'UNKNOWN' ? incoming.booked : base.booked;
    base.booking_status = incoming.booking_status ?? base.booking_status;
    if (incoming.last_activity_at) {
      const prev = Date.parse(base.last_activity_at || '');
      const next = Date.parse(incoming.last_activity_at);
      if (!Number.isFinite(prev) || (Number.isFinite(next) && next >= prev)) {
        base.last_activity_at = incoming.last_activity_at;
      }
    }
  } else if (incoming.last_activity_at) {
    base.last_activity_at = incoming.last_activity_at;
  }

  base.tracking = tracking;
  return base;
}

function stampIncomingTracking(
  base: CrmLeadWithMeta,
  incoming: CrmLeadWithMeta,
  source: TrackingSource,
  when: string,
  event_type?: string | null,
): CrmLeadWithMeta {
  const tracking: LeadTrackingMeta = { ...(incoming.tracking || {}) };
  const stamp = (key: TrackingFieldKey, rank: number) => {
    if (rank <= 0 && source === 'mac') return;
    tracking[key] = provenanceFor(source, rank, when, event_type);
  };
  stamp('email_accepted', trackingRankFromTri(incoming.email_accepted, 'email_accepted'));
  stamp('delivered', trackingRankFromTri(incoming.delivered, 'delivered'));
  stamp('bounced', trackingRankFromTri(incoming.bounced, 'bounced'));
  stamp('replied', trackingRankFromTri(incoming.replied, 'replied'));
  stamp('email_status', trackingRankFromStatus(incoming.email_status));
  return { ...base, ...incoming, tracking };
}

export function mergeEmailHistoryFreshness(
  existing: CrmEmailHistoryWithMeta | null | undefined,
  incoming: CrmEmailHistoryWithMeta,
  source: TrackingSource,
  at?: string,
  event_type?: string | null,
): CrmEmailHistoryWithMeta {
  const when = isoNow(at);
  if (!existing) {
    const tracking: LeadTrackingMeta = {};
    if (incoming.accepted === 'YES') tracking.email_accepted = provenanceFor(source, 1, when, event_type);
    if (incoming.delivered === 'YES') tracking.delivered = provenanceFor(source, 3, when, event_type);
    if (incoming.bounced === 'YES') tracking.bounced = provenanceFor(source, 3, when, event_type);
    if (incoming.replied === 'YES') tracking.replied = provenanceFor(source, 3, when, event_type);
    if (incoming.status) tracking.email_status = provenanceFor(source, trackingRankFromStatus(incoming.status), when, event_type);
    return { ...incoming, tracking };
  }

  const asLead: CrmLeadWithMeta = {
    id: existing.lead_id || existing.email,
    business_name: existing.business_name || existing.email,
    email: existing.email,
    email_accepted: existing.accepted,
    delivered: existing.delivered,
    bounced: existing.bounced,
    replied: existing.replied,
    booked: 'UNKNOWN',
    email_status: existing.status,
    tracking: existing.tracking,
  };
  const incomingLead: CrmLeadWithMeta = {
    id: incoming.lead_id || incoming.email,
    business_name: incoming.business_name || incoming.email,
    email: incoming.email,
    email_accepted: incoming.accepted,
    delivered: incoming.delivered,
    bounced: incoming.bounced,
    replied: incoming.replied,
    booked: 'UNKNOWN',
    email_status: incoming.status,
  };
  const merged = mergeLeadFreshness(asLead, incomingLead, source, when, event_type);
  return {
    ...existing,
    ...incoming,
    accepted: merged.email_accepted,
    delivered: merged.delivered,
    bounced: merged.bounced,
    replied: merged.replied,
    status: merged.email_status || incoming.status || existing.status,
    provider_message_id: incoming.provider_message_id || existing.provider_message_id,
    tracking: merged.tracking,
  };
}

/**
 * Apply Mac lead list onto existing leads with per-lead freshness merge.
 * `mode=replace` replaces membership from Mac, but preserves webhook tracking
 * on overlapping ids/emails. Leads only on website (webhook-created shells) are
 * kept if they have webhook tracking and Mac omitted them? For replace: Mac is
 * SoT for membership — drop website-only unless they have webhook inbox-only.
 * Spec: Mac leads.db is historical SoT for push → replace membership from Mac,
 * merge tracking on overlap.
 */
export function mergeMacLeadsIntoExisting(
  existing: CrmLeadWithMeta[],
  incoming: CrmLeadWithMeta[],
  at?: string,
): CrmLeadWithMeta[] {
  const when = isoNow(at);
  const byId = new Map(existing.map((l) => [String(l.id), l]));
  const byEmail = new Map(existing.map((l) => [l.email, l]));
  return incoming.map((lead) => {
    const prev = byId.get(String(lead.id)) || byEmail.get(lead.email);
    return mergeLeadFreshness(prev, lead, 'mac', when);
  });
}

export function mergeMacEmailHistory(
  existing: CrmEmailHistoryWithMeta[],
  incoming: CrmEmailHistoryWithMeta[],
  at?: string,
): CrmEmailHistoryWithMeta[] {
  const when = isoNow(at);
  const keyOf = (row: CrmEmailHistoryWithMeta) =>
    row.provider_message_id || `${row.lead_id}:${row.email}:${row.sent_at || ''}`;
  const map = new Map(existing.map((row) => [keyOf(row), row]));
  for (const row of incoming) {
    const key = keyOf(row);
    map.set(key, mergeEmailHistoryFreshness(map.get(key), row, 'mac', when));
  }
  // Keep webhook-only history rows that Mac didn't resend (e.g. inbound).
  return [...map.values()];
}
