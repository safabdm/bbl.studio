import type {
  CrmBookingItem,
  CrmCampaignSummary,
  CrmEnvelope,
  CrmInboxItem,
  CrmLead,
  CrmOverviewMetrics,
} from './crm-types';
import { LEAD_AGENT_CRM_CONTRACT } from './crm-types';
import { safetySnapshot } from './crm-safety';

export { LEAD_AGENT_CRM_CONTRACT };

function baseUrl(env: NodeJS.ProcessEnv = process.env) {
  return (env.LEAD_AGENT_CRM_BASE_URL || env.LEAD_AGENT_CRM_URL || '').replace(/\/$/, '');
}

function authHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const secret = env.LEAD_AGENT_CRM_SECRET || '';
  if (!secret) return {};
  return {
    Authorization: `Bearer ${secret}`,
    'X-BBL-CRM-Key': secret,
  };
}

async function leadAgentGet<T>(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CrmEnvelope<T>> {
  const root = baseUrl(env);
  if (!root) {
    return {
      ok: true,
      source: 'unavailable',
      message:
        'Lead agent CRM is not configured on this host (LEAD_AGENT_CRM_BASE_URL). Mac-side leads.db remains the source of truth.',
      data: emptyForPath<T>(path),
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(env.LEAD_AGENT_CRM_TIMEOUT_MS || 8000));
  try {
    const response = await fetch(`${root}${path}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...authHeaders(env),
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        source: 'unavailable',
        message: `Lead agent returned ${response.status} for ${path}.`,
        data: emptyForPath<T>(path),
      };
    }
    const json = (await response.json()) as { ok?: boolean; data?: T } & T;
    const data = (json.data !== undefined ? json.data : json) as T;
    return { ok: true, source: 'lead_agent', data };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Lead agent unreachable.';
    return {
      ok: false,
      source: 'unavailable',
      message: `Lead agent unreachable (${message}). Showing empty CRM state — no fabricated leads.`,
      data: emptyForPath<T>(path),
    };
  } finally {
    clearTimeout(timer);
  }
}

function emptyForPath<T>(path: string): T {
  if (path.includes('/overview')) {
    return {
      total_leads: 0,
      new_leads: 0,
      contacted_leads: 0,
      emails_sent: 0,
      emails_delivered: 0,
      emails_bounced: 0,
      replies: 0,
      booked: 0,
      conversion_rate: null,
      last_activity_at: null,
    } as T;
  }
  return [] as T;
}

export async function fetchOverview(env: NodeJS.ProcessEnv = process.env) {
  return leadAgentGet<CrmOverviewMetrics>(LEAD_AGENT_CRM_CONTRACT.overview.replace('GET ', ''), env);
}

export async function fetchLeads(query = '', env: NodeJS.ProcessEnv = process.env) {
  const path = `${LEAD_AGENT_CRM_CONTRACT.leads.split('?')[0]}${query ? `?${query}` : ''}`;
  return leadAgentGet<CrmLead[]>(path.replace('GET ', ''), env);
}

export async function fetchInbox(env: NodeJS.ProcessEnv = process.env) {
  return leadAgentGet<CrmInboxItem[]>(LEAD_AGENT_CRM_CONTRACT.inbox.replace('GET ', ''), env);
}

export async function fetchBookings(env: NodeJS.ProcessEnv = process.env) {
  return leadAgentGet<CrmBookingItem[]>(LEAD_AGENT_CRM_CONTRACT.bookings.replace('GET ', ''), env);
}

export async function fetchCampaigns(env: NodeJS.ProcessEnv = process.env) {
  return leadAgentGet<CrmCampaignSummary[]>(LEAD_AGENT_CRM_CONTRACT.campaigns.replace('GET ', ''), env);
}

export function crmConfigStatus(env: NodeJS.ProcessEnv = process.env) {
  return {
    lead_agent_configured: Boolean(baseUrl(env)),
    lead_agent_base_url: baseUrl(env) || null,
    resend_webhook_secret: Boolean(env.RESEND_WEBHOOK_SECRET),
    lead_agent_resend_webhook_url: env.LEAD_AGENT_RESEND_WEBHOOK_URL || null,
    contract: LEAD_AGENT_CRM_CONTRACT,
    safety: safetySnapshot(env),
    mac_side_required: [
      'leads.db + Streamlit CRM on Mac / colocated host',
      'integration_server.py exposing CRM + resend-webhook routes',
      'LEAD_AGENT_CRM_BASE_URL (+ secret) on Vercel when host is public',
      'RESEND_WEBHOOK_SECRET on website + lead agent',
      'Reply path (Resend inbound or Gmail OAuth) still scaffold-only',
      'Booking sync production host still deferred',
    ],
  };
}
