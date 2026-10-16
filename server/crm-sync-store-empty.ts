import type { CrmOverviewMetrics, CrmSyncSnapshot } from './crm-types';

export function emptyOverview(): CrmOverviewMetrics {
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
  };
}

export function emptySnapshot(): CrmSyncSnapshot {
  return {
    schema_version: 1,
    last_synced_at: null,
    source_host: null,
    leads: [],
    overview: emptyOverview(),
    campaigns: [],
    email_history: [],
    inbox: [],
    bookings: [],
    suppressions: [],
  };
}
