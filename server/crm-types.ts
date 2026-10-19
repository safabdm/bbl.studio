/**
 * CRM + email marketing types and push-sync contract (Mac → website).
 *
 * Architecture: Mac worker is outbound-only. It pushes snapshots to authenticated
 * website endpoints. SQLite / the Mac are never exposed to the public internet.
 * Website dashboard reads the server-side sync cache.
 *
 * When no successful sync exists, UI must show Not connected / Sync pending —
 * never misleading zeros for unsynced data.
 */

export type TrackingTriState = 'YES' | 'NO' | 'UNKNOWN';

export type CrmConnectionStatus = 'not_connected' | 'sync_pending' | 'synced';

export type CrmLead = {
  id: number | string;
  business_name: string;
  contact_name?: string | null;
  /** Empty string when no email — lead is NOT CONTACTABLE / never auto-eligible. */
  email: string;
  phone?: string | null;
  location?: string | null;
  category?: string | null;
  status?: string | null;
  sales_status?: string | null;
  /** Use "NOT CONTACTABLE" when email is missing. */
  email_status?: string | null;
  email_outreach_status?: string | null;
  /** False when missing/invalid email — never auto-eligible for outreach. */
  contactable?: boolean;
  last_contacted_at?: string | null;
  last_activity_at?: string | null;
  notes?: string | null;
  /**
   * Genuine public-site observation used in cold email copy.
   * Required for approved outreach — never invent. Maps from Mac `outreach_observation`.
   */
  website_observation?: string | null;
  /** @deprecated Mac alias — prefer website_observation */
  outreach_observation?: string | null;
  suppressed?: boolean;
  unsubscribed?: boolean;
  /**
   * Provider accepted the message (provider_message_id + successful provider response).
   * Local SENT alone is NOT acceptance. Not delivery.
   */
  email_accepted: TrackingTriState;
  delivered: TrackingTriState;
  bounced: TrackingTriState;
  replied: TrackingTriState;
  booked: TrackingTriState;
  booking_status?: string | null;
  /** Resend / provider message ids for webhook matching. */
  provider_message_ids?: string[];
  /**
   * Per-field provenance for freshness merge (webhook vs Mac).
   * Server-only metadata; safe in snapshot JSON, never required by UI.
   */
  tracking?: Partial<
    Record<
      'email_accepted' | 'delivered' | 'bounced' | 'replied' | 'email_status',
      { source: 'mac' | 'webhook'; rank: number; at: string; event_type?: string | null }
    >
  >;
};

export type CrmOverviewMetrics = {
  total_leads: number;
  new_leads: number;
  contacted_leads: number;
  emails_sent: number;
  emails_delivered: number;
  emails_bounced: number;
  replies: number;
  booked: number;
  conversion_rate: number | null;
  last_activity_at?: string | null;
};

export type CrmCampaignSummary = {
  id: string;
  name: string;
  subject?: string | null;
  status: 'draft' | 'dry_run' | 'sent' | 'unknown';
  recipient_count: number;
  accepted?: number;
  delivered?: number;
  bounced?: number;
  replied?: number;
  booked?: number;
  created_at?: string | null;
  sent_at?: string | null;
};

export type CrmEmailHistoryItem = {
  id?: string;
  lead_id?: number | string | null;
  email: string;
  business_name?: string | null;
  subject?: string | null;
  campaign_name?: string | null;
  /** Resend email id / provider message id */
  provider_message_id?: string | null;
  status?: string | null;
  dry_run?: boolean;
  accepted: TrackingTriState;
  delivered: TrackingTriState;
  bounced: TrackingTriState;
  replied: TrackingTriState;
  sent_at?: string | null;
  tracking?: CrmLead['tracking'];
};

export type CrmInboxItem = {
  id: string;
  from_email: string;
  lead_id?: number | string | null;
  subject?: string | null;
  snippet?: string | null;
  received_at?: string | null;
  source: 'resend_inbound' | 'gmail' | 'unknown';
};

export type CrmBookingItem = {
  id: string;
  email: string;
  name?: string | null;
  lead_id?: number | string | null;
  meeting_start?: string | null;
  booked_at?: string | null;
  status: 'confirmed' | 'unknown';
};

export type CrmSuppressionItem = {
  email: string;
  lead_id?: number | string | null;
  reason?: string | null;
  created_at?: string | null;
};

export type CrmSyncSnapshot = {
  schema_version: 1;
  last_synced_at: string | null;
  source_host?: string | null;
  leads: CrmLead[];
  overview: CrmOverviewMetrics;
  campaigns: CrmCampaignSummary[];
  email_history: CrmEmailHistoryItem[];
  inbox: CrmInboxItem[];
  bookings: CrmBookingItem[];
  suppressions: CrmSuppressionItem[];
};

export type CrmSyncPayload = {
  schema_version?: 1;
  synced_at?: string;
  source_host?: string;
  mode?: 'replace' | 'merge';
  leads: CrmLead[];
  overview?: CrmOverviewMetrics;
  campaigns?: CrmCampaignSummary[];
  email_history?: CrmEmailHistoryItem[];
  inbox?: CrmInboxItem[];
  bookings?: CrmBookingItem[];
  suppressions?: CrmSuppressionItem[];
};

export type CrmSyncIngestResult =
  | {
      ok: true;
      status: number;
      message: string;
      last_synced_at: string | null;
      counts: {
        leads: number;
        email_history: number;
        campaigns: number;
        inbox: number;
        bookings: number;
        suppressions: number;
      };
    }
  | { ok: false; status: number; message: string };

/** Data provenance for admin CRM reads. */
export type CrmDataSource =
  | 'sync_snapshot'
  | 'not_connected'
  | 'sync_pending'
  | 'local_draft'
  /** @deprecated pull model retired — kept for older clients */
  | 'lead_agent'
  | 'unavailable';

export type CrmEnvelope<T> = {
  ok: boolean;
  source: CrmDataSource;
  connection: CrmConnectionStatus;
  last_synced_at?: string | null;
  message?: string;
  data: T;
  /** When false, UI must not render metric zeros as real counts. */
  metrics_trusted?: boolean;
};

/**
 * Push-sync contract (Mac → Vercel). Documented for the offline Mac worker.
 * Mac never accepts inbound public traffic for CRM.
 */
export const CRM_PUSH_SYNC_CONTRACT = {
  ingest: 'POST /api/crm/sync',
  status: 'GET /api/crm/sync/status (Bearer; optional health)',
  authHeader: 'Authorization: Bearer <CRM_SYNC_SECRET> or X-BBL-CRM-Sync-Key',
  payload: {
    schema_version: 1,
    mode: 'replace | merge',
    source_host: 'optional hostname label',
    leads: 'CrmLead[] (required array; may be empty)',
    email_history: 'CrmEmailHistoryItem[] incl. Resend message ids for the 9 cohort sends',
    campaigns: 'CrmCampaignSummary[]',
    inbox: 'CrmInboxItem[] (replies only; no auto-reply)',
    bookings: 'CrmBookingItem[]',
    suppressions: 'unsubscribe/suppression rows',
    overview: 'optional; server recomputes if omitted',
  },
  notes: [
    'Mac reads leads.db readonly and pushes JSON — never expose SQLite publicly',
    'Include ALL leads (including no-email); label NOT CONTACTABLE — never auto-eligible',
    'Accepted only with provider_message_id + successful provider response; bare SENT ≠ accepted',
    'Delivery/bounce/reply stay UNKNOWN until signed Resend webhooks',
    'Website persists snapshot cache; Vercel /tmp is ephemeral — re-push after cold start',
    'Resend webhooks land on website and update the snapshot in place',
    'Booking site→Mac reverse notify remains deferred (preferences)',
  ],
} as const;

/** @deprecated Use CRM_PUSH_SYNC_CONTRACT. Pull model is retired. */
export const LEAD_AGENT_CRM_CONTRACT = {
  ...CRM_PUSH_SYNC_CONTRACT,
  overview: 'GET /api/admin/crm/overview (admin cookie; reads sync cache)',
  leads: 'GET /api/admin/crm/leads?... (admin cookie; reads sync cache)',
  inbox: 'GET /api/admin/crm/inbox',
  bookings: 'GET /api/admin/crm/bookings',
  campaigns: 'GET /api/admin/crm/campaigns',
  resendWebhook: 'POST /api/resend-webhook',
  authHeader: CRM_PUSH_SYNC_CONTRACT.authHeader,
} as const;

export type EmailTemplate = {
  id: string;
  name: string;
  subject: string;
  body: string;
};

export type CampaignDraft = {
  id: string;
  name: string;
  subject: string;
  body: string;
  template_id?: string | null;
  recipient_ids: Array<number | string>;
  created_at: string;
  updated_at: string;
};

export type PersonalizedPreview = {
  lead_id: number | string;
  email: string;
  business_name: string;
  subject: string;
  body: string;
  /** True when policy would exclude this recipient (e.g. missing observation). */
  excluded?: boolean;
  exclude_reason?: string;
};

export type ManualSendRequest = {
  campaign_name: string;
  subject: string;
  body: string;
  recipient_ids: Array<number | string>;
  /** Must match a prior preview session token. */
  preview_token: string;
  /** Explicit UI confirm; required. */
  confirmed: boolean;
  /** Only honored when MANUAL_SEND_LIVE_ENABLED=true (default off). */
  confirm_live?: boolean;
};

export type ManualSendResult = {
  ok: boolean;
  dry_run: boolean;
  live: boolean;
  campaign_id: string;
  recipient_count: number;
  excluded_count: number;
  excluded: Array<{ id: number | string; reason: string }>;
  intended: Array<{ id: number | string; email: string; subject: string }>;
  message: string;
};
