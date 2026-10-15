/**
 * Apply verified Resend webhook events onto the CRM sync snapshot.
 * No auto-replies. Delivery truth only from signed events.
 */
import type { CrmEmailHistoryItem, CrmInboxItem, TrackingTriState } from './crm-types';
import {
  applyTrackingToLead,
  computeOverviewFromLeads,
  emptySnapshot,
  readSnapshot,
  upsertEmailHistory,
  writeSnapshot,
  type CrmSyncStoreEnv,
} from './crm-sync-store';

export type ResendEventMap = {
  email_accepted?: TrackingTriState;
  delivered?: TrackingTriState;
  bounced?: TrackingTriState;
  replied?: TrackingTriState;
  email_status?: string;
  inbox?: boolean;
};

/** Map Resend event types → CRM tracking fields. */
export function mapResendEventType(type: string | null | undefined): ResendEventMap | null {
  switch (String(type || '')) {
    case 'email.sent':
      return { email_accepted: 'YES', email_status: 'ACCEPTED' };
    case 'email.delivered':
      return { email_accepted: 'YES', delivered: 'YES', email_status: 'DELIVERED' };
    case 'email.bounced':
      return { bounced: 'YES', email_status: 'BOUNCED' };
    case 'email.failed':
    case 'email.suppressed':
      return { email_status: 'FAILED' };
    case 'email.complained':
      return { email_status: 'COMPLAINED' };
    case 'email.delivery_delayed':
      return { email_status: 'DELAYED' };
    case 'email.received':
      return { replied: 'YES', email_status: 'REPLIED', inbox: true };
    default:
      return null;
  }
}

export function extractResendRecipients(data: Record<string, unknown> | undefined): string[] {
  if (!data) return [];
  const out: string[] = [];
  const to = data.to;
  if (typeof to === 'string' && to.includes('@')) out.push(to.trim().toLowerCase());
  if (Array.isArray(to)) {
    for (const item of to) {
      if (typeof item === 'string' && item.includes('@')) out.push(item.trim().toLowerCase());
      else if (item && typeof item === 'object' && 'email' in item) {
        const email = String((item as { email?: string }).email || '')
          .trim()
          .toLowerCase();
        if (email.includes('@')) out.push(email);
      }
    }
  }
  const from = data.from;
  if (typeof from === 'string' && from.includes('@')) {
    // For inbound replies, From is the lead.
    out.push(from.trim().toLowerCase());
  }
  return [...new Set(out)];
}

export function applyResendEventToSnapshot(
  body: string,
  env: CrmSyncStoreEnv = process.env,
): { applied: boolean; matched_leads: number; type: string | null } {
  let json: { type?: string; data?: Record<string, unknown>; created_at?: string };
  try {
    json = JSON.parse(body) as typeof json;
  } catch {
    return { applied: false, matched_leads: 0, type: null };
  }

  const type = json.type || null;
  const mapped = mapResendEventType(type);
  if (!mapped) return { applied: false, matched_leads: 0, type };

  const data = json.data || {};
  const emailId = String(data.email_id || data.id || '').trim() || null;
  const recipients = extractResendRecipients(data);
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const snapshot = readSnapshot(env) || emptySnapshot();
  // Only mutate when we already have a sync (or create a minimal shell if webhook arrives first).
  let matched = 0;
  const leads = snapshot.leads.map((lead) => {
    const byId = emailId && lead.provider_message_ids?.includes(emailId);
    const byEmail = recipients.includes(lead.email);
    // Inbound: match From email; outbound: prefer message id then recipient.
    if (!byId && !byEmail) return lead;
    matched += 1;
    return applyTrackingToLead(lead, {
      email_accepted: mapped.email_accepted,
      delivered: mapped.delivered,
      bounced: mapped.bounced,
      replied: mapped.replied,
      email_status: mapped.email_status,
      last_activity_at: now,
      provider_message_id: emailId || undefined,
    });
  });

  let email_history = snapshot.email_history;
  if (emailId || recipients[0]) {
    const existing = email_history.find(
      (row) =>
        (emailId && row.provider_message_id === emailId) ||
        (!emailId && recipients[0] && row.email === recipients[0]),
    );
    const item: CrmEmailHistoryItem = {
      id: existing?.id || emailId || `evt_${now}`,
      lead_id: existing?.lead_id ?? null,
      email: existing?.email || recipients[0] || '',
      business_name: existing?.business_name ?? null,
      subject: existing?.subject ?? (typeof data.subject === 'string' ? data.subject : null),
      campaign_name: existing?.campaign_name ?? null,
      provider_message_id: emailId || existing?.provider_message_id || null,
      status: mapped.email_status || existing?.status || null,
      dry_run: existing?.dry_run ?? false,
      accepted: mapped.email_accepted || existing?.accepted || 'UNKNOWN',
      delivered: mapped.delivered || existing?.delivered || 'UNKNOWN',
      bounced: mapped.bounced || existing?.bounced || 'UNKNOWN',
      replied: mapped.replied || existing?.replied || 'UNKNOWN',
      sent_at: existing?.sent_at ?? null,
    };
    if (item.email.includes('@')) {
      email_history = upsertEmailHistory(email_history, item);
    }
  }

  let inbox = snapshot.inbox;
  if (mapped.inbox) {
    const from =
      typeof data.from === 'string'
        ? data.from.trim().toLowerCase()
        : recipients[0] || '';
    if (from.includes('@')) {
      const entry: CrmInboxItem = {
        id: String(data.email_id || `reply_${from}_${now}`),
        from_email: from,
        lead_id: leads.find((l) => l.email === from)?.id ?? null,
        subject: typeof data.subject === 'string' ? data.subject : null,
        snippet: typeof data.text === 'string' ? data.text.slice(0, 280) : null,
        received_at: typeof json.created_at === 'string' ? json.created_at : now,
        source: 'resend_inbound',
      };
      if (!inbox.some((item) => item.id === entry.id)) {
        inbox = [entry, ...inbox].slice(0, 1000);
      }
    }
  }

  // Mark suppressions for bounce/complaint when we know the email.
  let suppressions = snapshot.suppressions;
  if (mapped.email_status === 'BOUNCED' || mapped.email_status === 'COMPLAINED') {
    for (const email of recipients) {
      if (!suppressions.some((s) => s.email === email)) {
        suppressions = [
          { email, reason: mapped.email_status.toLowerCase(), created_at: now },
          ...suppressions,
        ];
      }
      const lead = leads.find((l) => l.email === email);
      if (lead) lead.suppressed = true;
    }
  }

  writeSnapshot(
    {
      ...snapshot,
      schema_version: 1,
      // Preserve last_synced_at; webhook updates do not count as Mac sync.
      last_synced_at: snapshot.last_synced_at,
      leads,
      email_history,
      inbox,
      suppressions,
      overview: computeOverviewFromLeads(leads, email_history),
    },
    env,
  );

  return { applied: true, matched_leads: matched, type };
}
