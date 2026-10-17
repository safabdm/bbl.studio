/**
 * Evidence-only qualification scoring.
 * Scores only from observable Places fields + public website HTML.
 * Never invents businesses, emails, or activity.
 */
import { createHash } from 'node:crypto';
import type { PlacesCandidate } from './crm-discovery-places.js';
import type {
  DiscoveredLead,
  DiscoveryEvidenceItem,
  DiscoveryScoreBreakdown,
} from './crm-discovery-types.js';
import {
  DISCOVERY_QUALIFIED_THRESHOLD,
  DISCOVERY_SCORE_WEIGHTS,
} from './crm-discovery-types.js';

export type WebsiteEvidence = {
  fetched: boolean;
  final_url: string | null;
  status: number | null;
  has_viewport: boolean;
  has_booking: boolean;
  has_instagram: boolean;
  has_facebook: boolean;
  has_linkedin: boolean;
  mailto_emails: string[];
  visible_emails: string[];
  tel_phones: string[];
  title: string | null;
  looks_template: boolean;
  looks_outdated: boolean;
  has_https: boolean;
  error: string | null;
  social: DiscoveredLead['social'];
};

const BOOKING_HINTS =
  /calendly|acuityscheduling|square\.site|booksy|vagaro|mindbody|fresha|setmore|appointlet|book\-now|booknow|schedule\.|reservations?/i;
const TEMPLATE_HINTS =
  /wix\.com|squarespace\.com|godaddy\.com\/websites|weebly\.com|jimdo\.com|wordpress\.com\/\$|created with|free website|coming soon|under construction|lorem ipsum/i;
const OUTDATED_HINTS = /copyright\s*(©)?\s*(20(0|1)\d)|best viewed in internet explorer|flash player/i;
const EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi;
const BLOCKED_EMAIL_HOSTS = /example\.com|domain\.com|email\.com|sentry\.io|wixpress\.com|googleapis\.com|schema\.org/i;

function clamp(n: number, max: number) {
  return Math.max(0, Math.min(max, Math.round(n)));
}

function extractEmails(html: string): string[] {
  const found = html.match(EMAIL_RE) || [];
  const unique = new Set<string>();
  for (const raw of found) {
    const email = raw.toLowerCase();
    if (BLOCKED_EMAIL_HOSTS.test(email)) continue;
    if (email.endsWith('.png') || email.endsWith('.jpg') || email.endsWith('.svg')) continue;
    unique.add(email);
  }
  return [...unique].slice(0, 5);
}

function extractMailto(html: string): string[] {
  const out = new Set<string>();
  const re = /mailto:([^"'?\s>]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const email = decodeURIComponent(m[1] || '')
      .split('?')[0]
      .trim()
      .toLowerCase();
    if (email.includes('@') && !BLOCKED_EMAIL_HOSTS.test(email)) out.add(email);
  }
  return [...out];
}

function extractSocial(html: string): DiscoveredLead['social'] {
  const instagram = html.match(/https?:\/\/(?:www\.)?instagram\.com\/[A-Za-z0-9._%-]+/i)?.[0] || null;
  const facebook = html.match(/https?:\/\/(?:www\.)?(?:facebook|fb)\.com\/[A-Za-z0-9._%-/]+/i)?.[0] || null;
  const linkedin = html.match(/https?:\/\/(?:www\.)?linkedin\.com\/(?:company|in)\/[A-Za-z0-9._%-/]+/i)?.[0] || null;
  return { instagram, facebook, linkedin, other: [] };
}

export async function fetchWebsiteEvidence(
  website: string | null,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<WebsiteEvidence> {
  const empty: WebsiteEvidence = {
    fetched: false,
    final_url: null,
    status: null,
    has_viewport: false,
    has_booking: false,
    has_instagram: false,
    has_facebook: false,
    has_linkedin: false,
    mailto_emails: [],
    visible_emails: [],
    tel_phones: [],
    title: null,
    looks_template: false,
    looks_outdated: false,
    has_https: false,
    error: null,
    social: {},
  };
  if (!website) {
    empty.error = 'No website URI from Places.';
    return empty;
  }

  let url = website.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  empty.has_https = url.startsWith('https://');

  const fetchImpl = opts.fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'BBLStudioDiscoveryBot/1.0 (+https://www.bbl.studio; public evidence only)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    const html = (await res.text()).slice(0, 250_000);
    const social = extractSocial(html);
    const mailto = extractMailto(html);
    const visible = extractEmails(html).filter((e) => !mailto.includes(e));
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    return {
      fetched: true,
      final_url: res.url || url,
      status: res.status,
      has_viewport: /name=["']viewport["']/i.test(html),
      has_booking: BOOKING_HINTS.test(html),
      has_instagram: Boolean(social.instagram),
      has_facebook: Boolean(social.facebook),
      has_linkedin: Boolean(social.linkedin),
      mailto_emails: mailto,
      visible_emails: visible,
      tel_phones: [...html.matchAll(/tel:([^"'?\s>]+)/gi)].map((m) => decodeURIComponent(m[1] || '')).slice(0, 3),
      title: titleMatch?.[1]?.trim() || null,
      looks_template: TEMPLATE_HINTS.test(html) || TEMPLATE_HINTS.test(url),
      looks_outdated: OUTDATED_HINTS.test(html),
      has_https: (res.url || url).startsWith('https://'),
      error: res.ok ? null : `HTTP ${res.status}`,
      social,
    };
  } catch (err) {
    empty.error = err instanceof Error ? err.message : String(err);
    return empty;
  } finally {
    clearTimeout(timer);
  }
}

function paymentCapacitySignals(candidate: PlacesCandidate): string[] {
  const signals: string[] = [];
  const blob = `${candidate.category || ''} ${candidate.types.join(' ')} ${candidate.business_name}`.toLowerCase();
  if (/spa|med_spa|beauty_salon|hair_care|skin|wellness|plastic|dermat|cosmetic/.test(blob)) {
    signals.push('Category suggests discretionary / premium spend (spa/beauty/wellness).');
  }
  if (/lawyer|attorney|dentist|orthodont|chiropract|finance|wealth|real_estate|architect/.test(blob)) {
    signals.push('Professional services category — payment capacity signal.');
  }
  if ((candidate.user_rating_count || 0) >= 50) {
    signals.push(`Established review volume (${candidate.user_rating_count} ratings from Places).`);
  }
  if ((candidate.rating || 0) >= 4.3 && (candidate.user_rating_count || 0) >= 20) {
    signals.push(`Strong Places rating ${candidate.rating} (${candidate.user_rating_count} reviews).`);
  }
  return signals;
}

export function scoreCandidate(
  candidate: PlacesCandidate,
  web: WebsiteEvidence,
): {
  scores: DiscoveryScoreBreakdown;
  score_total: number;
  evidence: DiscoveryEvidenceItem[];
  problems: string[];
  fit_summary: string;
  service_opportunity: string;
  payment_capacity_signals: string[];
  weak_website_signals: string[];
  public_email: string | null;
  email_source: DiscoveredLead['enrichment']['email_source'];
} {
  const evidence: DiscoveryEvidenceItem[] = [];
  const problems: string[] = [];
  const weak: string[] = [];
  const W = DISCOVERY_SCORE_WEIGHTS;

  // Website (25): existence + fetchability + not broken
  let websiteScore = 0;
  if (!candidate.website) {
    problems.push('No website listed on Places.');
    weak.push('Missing website URI.');
    evidence.push({
      field: 'website',
      signal: 'missing_website',
      detail: 'Places returned no websiteUri.',
      source: 'places.websiteUri',
    });
  } else if (!web.fetched) {
    websiteScore = clamp(W.website * 0.35, W.website);
    problems.push(`Website listed but not fetchable: ${web.error || 'unknown'}.`);
    weak.push('Website fetch failed.');
    evidence.push({
      field: 'website',
      signal: 'website_unreachable',
      detail: web.error || 'fetch failed',
      source: candidate.website,
    });
  } else if (web.error) {
    websiteScore = clamp(W.website * 0.45, W.website);
    problems.push(`Website returned ${web.error}.`);
    weak.push(web.error);
    evidence.push({
      field: 'website',
      signal: 'website_http_error',
      detail: web.error,
      source: web.final_url || candidate.website,
    });
  } else {
    websiteScore = clamp(W.website * 0.7, W.website);
    evidence.push({
      field: 'website',
      signal: 'website_ok',
      detail: `Fetched ${web.final_url} (${web.status}).`,
      source: web.final_url || candidate.website,
    });
    if (web.looks_template) {
      websiteScore = clamp(websiteScore - 6, W.website);
      weak.push('Template / builder footprint detected.');
      evidence.push({
        field: 'website',
        signal: 'template_footprint',
        detail: 'HTML or host matches common template builders.',
        source: web.final_url || candidate.website,
      });
    }
    if (web.looks_outdated) {
      websiteScore = clamp(websiteScore - 5, W.website);
      weak.push('Outdated copyright / legacy markup signals.');
      evidence.push({
        field: 'website',
        signal: 'outdated_markup',
        detail: 'Matched outdated copyright or legacy browser hints.',
        source: web.final_url || candidate.website,
      });
    }
    if (!web.has_https) {
      websiteScore = clamp(websiteScore - 4, W.website);
      weak.push('Not served over HTTPS.');
    } else {
      websiteScore = clamp(websiteScore + 3, W.website);
    }
  }

  // Mobile (20)
  let mobileScore = 0;
  if (web.fetched && web.has_viewport) {
    mobileScore = clamp(W.mobile * 0.85, W.mobile);
    evidence.push({
      field: 'mobile',
      signal: 'viewport_meta',
      detail: 'Found name=viewport meta tag.',
      source: web.final_url || 'website',
    });
  } else if (candidate.website) {
    mobileScore = clamp(W.mobile * 0.2, W.mobile);
    problems.push('No mobile viewport meta observed.');
    weak.push('Missing viewport — likely weak mobile experience.');
    evidence.push({
      field: 'mobile',
      signal: 'no_viewport',
      detail: 'No viewport meta in fetched HTML (or site not fetched).',
      source: web.final_url || candidate.website,
    });
  } else {
    evidence.push({
      field: 'mobile',
      signal: 'unscored_no_site',
      detail: 'Cannot score mobile without a website.',
      source: 'places',
    });
  }

  // Brand (15): Places reputation + social presence
  let brandScore = 0;
  if ((candidate.rating || 0) >= 4.0) {
    brandScore += 6;
    evidence.push({
      field: 'brand',
      signal: 'places_rating',
      detail: `Places rating ${candidate.rating} (${candidate.user_rating_count || 0} reviews).`,
      source: 'places.rating',
    });
  }
  if ((candidate.user_rating_count || 0) >= 25) brandScore += 4;
  if (web.has_instagram || web.has_facebook) {
    brandScore += 4;
    evidence.push({
      field: 'brand',
      signal: 'social_presence',
      detail: `Social links observed (ig=${Boolean(web.has_instagram)}, fb=${Boolean(web.has_facebook)}).`,
      source: web.final_url || 'website',
    });
  }
  brandScore = clamp(brandScore, W.brand);

  // Booking (15): lower score when booking is missing = opportunity; but we score presence of booking tooling
  let bookingScore = 0;
  if (web.has_booking) {
    bookingScore = clamp(W.booking * 0.9, W.booking);
    evidence.push({
      field: 'booking',
      signal: 'booking_widget',
      detail: 'Booking / scheduling vendor fingerprint found in HTML.',
      source: web.final_url || 'website',
    });
  } else if (web.fetched) {
    bookingScore = clamp(W.booking * 0.25, W.booking);
    problems.push('No online booking widget detected.');
    evidence.push({
      field: 'booking',
      signal: 'no_booking',
      detail: 'No Calendly/Acuity/Fresha/etc fingerprint in HTML.',
      source: web.final_url || 'website',
    });
  }

  // Fit (15): category + geo + payment capacity + weak site opportunity
  let fitScore = 0;
  const payment = paymentCapacitySignals(candidate);
  const blob = `${candidate.category || ''} ${candidate.types.join(' ')}`.toLowerCase();
  if (/spa|salon|beauty|wellness|boutique|store|lawyer|dentist|real_estate|finance/.test(blob)) {
    fitScore += 8;
    evidence.push({
      field: 'fit',
      signal: 'category_fit',
      detail: `Category/types match target verticals: ${candidate.category || candidate.types[0] || 'n/a'}.`,
      source: 'places.types',
    });
  }
  if (payment.length) fitScore += 4;
  if (weak.length && payment.length) {
    fitScore += 3;
    evidence.push({
      field: 'fit',
      signal: 'capacity_plus_weak_site',
      detail: 'Payment-capacity signals with weak website — priority opportunity.',
      source: 'composite',
    });
  }
  fitScore = clamp(fitScore, W.fit);

  // Contactability (10): public email / phone only — never guessed
  let contactScore = 0;
  const publicEmail = web.mailto_emails[0] || web.visible_emails[0] || null;
  let emailSource: DiscoveredLead['enrichment']['email_source'] = 'none';
  if (web.mailto_emails[0]) emailSource = 'website_mailto';
  else if (web.visible_emails[0]) emailSource = 'website_text';

  if (publicEmail) {
    contactScore += 7;
    evidence.push({
      field: 'contactability',
      signal: 'public_email',
      detail: `Public email observed via ${emailSource}.`,
      source: web.final_url || 'website',
    });
  } else {
    problems.push('No public email found (not guessed).');
    evidence.push({
      field: 'contactability',
      signal: 'no_public_email',
      detail: 'No mailto or visible public email on fetched pages.',
      source: web.final_url || candidate.website || 'places',
    });
  }
  if (candidate.phone || web.tel_phones.length) {
    contactScore += 3;
    evidence.push({
      field: 'contactability',
      signal: 'phone',
      detail: candidate.phone ? 'Places phone present.' : 'tel: link on website.',
      source: candidate.phone ? 'places.phone' : web.final_url || 'website',
    });
  }
  contactScore = clamp(contactScore, W.contactability);

  const scores: DiscoveryScoreBreakdown = {
    website: websiteScore,
    mobile: mobileScore,
    brand: brandScore,
    booking: bookingScore,
    fit: fitScore,
    contactability: contactScore,
  };
  const score_total =
    scores.website + scores.mobile + scores.brand + scores.booking + scores.fit + scores.contactability;

  const fit_summary = payment.length && weak.length
    ? `${candidate.business_name}: capacity signals with website gaps — strong BBL fit.`
    : `${candidate.business_name}: scored from Places + public site evidence only.`;

  const service_opportunity = !candidate.website
    ? 'Net-new website + brand system.'
    : weak.length
      ? 'Website refresh / conversion-focused rebuild; optional booking UX.'
      : web.has_booking
        ? 'Brand polish + performance / SEO uplift.'
        : 'Add booking UX + clearer conversion path.';

  return {
    scores,
    score_total,
    evidence,
    problems,
    fit_summary,
    service_opportunity,
    payment_capacity_signals: payment,
    weak_website_signals: weak,
    public_email: publicEmail,
    email_source: emailSource,
  };
}

export function leadIdForPlace(placeId: string): string {
  const hash = createHash('sha256').update(placeId).digest('hex').slice(0, 16);
  return `disc_${hash}`;
}

export function buildDiscoveredLead(
  candidate: PlacesCandidate,
  web: WebsiteEvidence,
  now = new Date().toISOString(),
): DiscoveredLead {
  const scored = scoreCandidate(candidate, web);
  const status: DiscoveredLead['status'] = !scored.public_email
    ? scored.score_total >= DISCOVERY_QUALIFIED_THRESHOLD - 10
      ? 'needs_email'
      : 'discovered'
    : scored.score_total >= DISCOVERY_QUALIFIED_THRESHOLD
      ? 'qualified'
      : 'discovered';

  return {
    id: leadIdForPlace(candidate.place_id),
    place_id: candidate.place_id,
    business_name: candidate.business_name,
    website: candidate.website,
    city: candidate.city,
    category: candidate.category,
    public_email: scored.public_email,
    phone: candidate.phone,
    social: web.social || {},
    source_url: candidate.source_url || candidate.maps_uri,
    last_verified_at: now,
    status,
    score_total: scored.score_total,
    scores: scored.scores,
    evidence: scored.evidence,
    fit_summary: scored.fit_summary,
    problems: scored.problems,
    service_opportunity: scored.service_opportunity,
    payment_capacity_signals: scored.payment_capacity_signals,
    weak_website_signals: scored.weak_website_signals,
    enrichment: {
      email_source: scored.email_source,
      email_verified_public: Boolean(scored.public_email),
      last_enrichment_at: scored.public_email ? now : null,
    },
    created_at: now,
    updated_at: now,
  };
}
