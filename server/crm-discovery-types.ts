/**
 * Website-side lead discovery + qualification types.
 * Discovery prepares opportunities for owner approval — never auto-sends email.
 */

export type DiscoveryLeadStatus =
  | 'discovered'
  | 'qualified'
  | 'needs_email'
  | 'rejected'
  | 'approved_for_outreach'
  | 'suppressed';

export type DiscoveryScoreBreakdown = {
  website: number;
  mobile: number;
  brand: number;
  booking: number;
  fit: number;
  contactability: number;
};

export type DiscoveryEvidenceItem = {
  field: keyof DiscoveryScoreBreakdown | 'general';
  signal: string;
  detail: string;
  /** Observable source: places field, fetched URL, or HTML snippet location. */
  source: string;
};

export type DiscoveredLead = {
  id: string;
  place_id: string;
  business_name: string;
  website: string | null;
  city: string | null;
  category: string | null;
  public_email: string | null;
  phone: string | null;
  social: {
    instagram?: string | null;
    facebook?: string | null;
    linkedin?: string | null;
    other?: string[];
  };
  source_url: string | null;
  last_verified_at: string;
  status: DiscoveryLeadStatus;
  score_total: number;
  scores: DiscoveryScoreBreakdown;
  evidence: DiscoveryEvidenceItem[];
  fit_summary: string;
  problems: string[];
  service_opportunity: string;
  payment_capacity_signals: string[];
  weak_website_signals: string[];
  enrichment: {
    email_source: 'places' | 'website_mailto' | 'website_text' | 'none';
    email_verified_public: boolean;
    last_enrichment_at: string | null;
  };
  created_at: string;
  updated_at: string;
};

export type DiscoveryRunStatus = 'running' | 'completed' | 'failed' | 'skipped' | 'paused';

export type DiscoveryRunLog = {
  id: string;
  status: DiscoveryRunStatus;
  trigger: 'cron' | 'manual' | 'test';
  started_at: string;
  finished_at: string | null;
  cities_attempted: string[];
  queries_attempted: string[];
  discovered: number;
  upserted: number;
  skipped_dupes: number;
  qualified: number;
  errors: string[];
  message: string;
  /** True when Places key missing / discovery disabled — no fake rows. */
  fail_closed: boolean;
  idempotency_key: string;
};

export type DiscoveryAutomationState = {
  paused: boolean;
  paused_at: string | null;
  paused_reason: string | null;
  last_run_id: string | null;
  last_run_at: string | null;
  last_success_at: string | null;
  total_discovered: number;
  total_qualified: number;
  total_needs_email: number;
  places_configured: boolean;
  cron_enabled: boolean;
  updated_at: string;
};

export type DiscoveryEnrichmentStats = {
  attempted: number;
  found_public: number;
  not_found: number;
  skipped_guess_blocked: number;
  last_run_at: string | null;
};

export const DISCOVERY_SCORE_WEIGHTS = {
  website: 25,
  mobile: 20,
  brand: 15,
  booking: 15,
  fit: 15,
  contactability: 10,
} as const;

/** Orange County first, then LA / SD expansion. */
export const DISCOVERY_PRIORITY_CITIES = [
  'Irvine, CA',
  'Newport Beach, CA',
  'Costa Mesa, CA',
  'Huntington Beach, CA',
  'Laguna Beach, CA',
  'Anaheim, CA',
  'Orange, CA',
  'Santa Ana, CA',
  'Fullerton, CA',
  'Tustin, CA',
  'Los Angeles, CA',
  'Santa Monica, CA',
  'Pasadena, CA',
  'San Diego, CA',
  'La Jolla, CA',
] as const;

export const DISCOVERY_CATEGORY_QUERIES = [
  'med spa',
  'medical spa',
  'beauty salon',
  'hair salon',
  'wellness spa',
  'boutique',
  'luxury boutique',
  'professional services',
] as const;

/** Minimum total score to mark as qualified for owner review. */
export const DISCOVERY_QUALIFIED_THRESHOLD = 55;

export const DISCOVERY_KV_AUTOMATION = 'discovery:automation';
export const DISCOVERY_KV_ENRICHMENT = 'discovery:enrichment_stats';
