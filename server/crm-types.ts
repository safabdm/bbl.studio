/**
 * CRM + email marketing API contract (website ↔ lead agent).
 *
 * Lead agent (Mac / colocated with leads.db) should expose these under
 * LEAD_AGENT_CRM_BASE_URL (e.g. https://leads.bbl.studio) with the same
 * HMAC / shared-secret auth as booking sync when public.
 *
 * Website never invents production lead rows. When the lead agent is
 * unreachable, responses use source: "unavailable" and empty arrays.
 */

export type TrackingTriState = 'YES' | 'NO' | 'UNKNOWN';

export type CrmLead = {
  id: number | string;
  business_name: string;
  contact_name?: string | null;
  email: string;
  phone?: string | null;
  location?: string | null;
  category?: string | null;
  status?: string | null;
  sales_status?: string | null;
  email_status?: string | null;
  last_contacted_at?: string | null;
  last_activity_at?: string | null;
  notes?: string | null;
  suppressed?: boolean;
  unsubscribed?: boolean;
  /** Provider accepted the message (email.sent). Not delivery. */
  email_accepted: TrackingTriState;
  delivered: TrackingTriState;
  bounced: TrackingTriState;
  replied: TrackingTriState;
  booked: TrackingTriState;
  booking_status?: string | null;
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

export type CrmDataSource = 'lead_agent' | 'unavailable' | 'local_draft';

export type CrmEnvelope<T> = {
  ok: boolean;
  source: CrmDataSource;
  message?: string;
  data: T;
};

/** Lead-agent HTTP contract (document for Mac agent). */
export const LEAD_AGENT_CRM_CONTRACT = {
  overview: 'GET /integrations/crm/overview',
  leads: 'GET /integrations/crm/leads?status=&category=&location=&email_status=&booked=',
  leadPatch: 'PATCH /integrations/crm/leads/:id',
  inbox: 'GET /integrations/crm/inbox',
  bookings: 'GET /integrations/crm/bookings',
  campaigns: 'GET /integrations/crm/campaigns',
  campaignMetrics: 'GET /integrations/crm/campaigns/:id/metrics',
  resendWebhook: 'POST /integrations/resend-webhook',
  authHeader: 'X-BBL-CRM-Key or Authorization: Bearer <LEAD_AGENT_CRM_SECRET>',
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
