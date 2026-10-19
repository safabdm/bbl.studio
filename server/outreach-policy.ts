/**
 * Approved outreach policy — cold/follow-up copy rules, CAN-SPAM helpers,
 * and recipient exclusion for missing website observations.
 *
 * Pricing stays private: never put dollar amounts or package prices in
 * cold/follow-up emails. Quotes are custom and owner-approved only.
 */
import { createHmac } from 'node:crypto';
import type { CrmLead } from './crm-types.js';

export const BOOKING_CTA_URL = 'https://www.bbl.studio/book';
export const CONSULT_MINUTES = 15;

/** Placeholders allowed in campaign subject/body. */
export const ALLOWED_PLACEHOLDERS = [
  'contact_name',
  'business_name',
  'email',
  'location',
  'category',
  'website_observation',
  'signed_unsubscribe_url',
  'BUSINESS_POSTAL_ADDRESS',
] as const;

export type PolicyIssue = {
  code:
    | 'pricing_forbidden'
    | 'missing_website_observation_placeholder'
    | 'unknown_placeholder'
    | 'missing_booking_cta'
    | 'missing_postal_address'
    | 'missing_unsubscribe'
    | 'empty_copy';
  message: string;
  severity: 'block' | 'warn';
};

export type PolicyEnv = {
  BUSINESS_POSTAL_ADDRESS?: string;
  APP_ORIGIN?: string;
  UNSUBSCRIBE_SECRET?: string;
  UNSUBSCRIBE_BASE_URL?: string;
};

const PRICE_RE =
  /(?:\$\s?\d[\d,]*(?:\.\d{2})?|\bfrom\s+\$|\bpricing\b|\bpriced?\b|\bpackage\s+(?:from|starts)|starts?\s+at\s+\$|\b\d[\d,]*\s*(?:usd|dollars)\b)/i;

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export function businessPostalAddress(env: PolicyEnv = process.env): string {
  return String(env.BUSINESS_POSTAL_ADDRESS || '').trim();
}

export function containsPricing(text: string): boolean {
  return PRICE_RE.test(text || '');
}

export function extractPlaceholders(text: string): string[] {
  const found = new Set<string>();
  const re = new RegExp(PLACEHOLDER_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(text || '')) !== null) {
    found.add(match[1]!);
  }
  return [...found];
}

/**
 * Normalize website_observation for template fill: trim + strip trailing period(s)
 * so copy like `noticed {{website_observation}}.` never becomes `noticed foo..`.
 */
export function normalizeWebsiteObservation(raw: string | null | undefined): string {
  return String(raw || '')
    .trim()
    .replace(/\.+\s*$/, '')
    .trim();
}

export function leadWebsiteObservation(lead: Partial<CrmLead> | null | undefined): string {
  if (!lead) return '';
  return normalizeWebsiteObservation(
    lead.website_observation ||
      (lead as { outreach_observation?: string }).outreach_observation ||
      '',
  );
}

export function hasWebsiteObservation(lead: Partial<CrmLead> | null | undefined): boolean {
  return leadWebsiteObservation(lead).length > 0;
}

/**
 * Evaluate composition against outreach policy.
 * Missing {{website_observation}} is a hard block for cold/follow-up templates.
 */
export function evaluateCopyPolicy(subject: string, body: string, env: PolicyEnv = process.env): PolicyIssue[] {
  const issues: PolicyIssue[] = [];
  const combined = `${subject || ''}\n${body || ''}`;
  if (!String(subject || '').trim() || !String(body || '').trim()) {
    issues.push({
      code: 'empty_copy',
      message: 'Subject and body are required.',
      severity: 'block',
    });
  }
  if (containsPricing(combined)) {
    issues.push({
      code: 'pricing_forbidden',
      message:
        'Cold/follow-up emails must not include prices or package amounts. Use a private custom quote after the consult.',
      severity: 'block',
    });
  }
  const placeholders = extractPlaceholders(combined);
  const allowed = new Set<string>(ALLOWED_PLACEHOLDERS);
  for (const key of placeholders) {
    if (!allowed.has(key)) {
      issues.push({
        code: 'unknown_placeholder',
        message: `Unknown placeholder {{${key}}}.`,
        severity: 'block',
      });
    }
  }
  if (!placeholders.includes('website_observation') && !/\{\{\s*website_observation\s*\}\}/.test(combined)) {
    issues.push({
      code: 'missing_website_observation_placeholder',
      message: 'Include {{website_observation}} so each email cites a real site note, or exclude leads without one.',
      severity: 'block',
    });
  }
  if (!combined.includes(BOOKING_CTA_URL) && !/\{\{\s*booking_url\s*\}\}/i.test(combined)) {
    issues.push({
      code: 'missing_booking_cta',
      message: `CTA should include ${BOOKING_CTA_URL} for a complimentary ${CONSULT_MINUTES}-minute consult.`,
      severity: 'warn',
    });
  }
  if (!businessPostalAddress(env) && !placeholders.includes('BUSINESS_POSTAL_ADDRESS')) {
    issues.push({
      code: 'missing_postal_address',
      message: 'Set BUSINESS_POSTAL_ADDRESS (env) before live send for CAN-SPAM footer.',
      severity: 'warn',
    });
  }
  if (!placeholders.includes('signed_unsubscribe_url') && !/unsubscribe/i.test(body || '')) {
    issues.push({
      code: 'missing_unsubscribe',
      message: 'Include an unsubscribe link ({{signed_unsubscribe_url}} or compliance footer).',
      severity: 'warn',
    });
  }
  return issues;
}

export function policyBlocksSend(issues: PolicyIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'block');
}

export type Exclusion = { id: number | string; reason: string; email?: string };

/**
 * Exclude leads that lack a genuine website_observation (never invent one).
 */
export function filterObservationRequired(
  leads: CrmLead[],
  selectedIds: Array<number | string>,
): { included: CrmLead[]; excluded: Exclusion[] } {
  const wanted = new Set(selectedIds.map(String));
  const included: CrmLead[] = [];
  const excluded: Exclusion[] = [];
  for (const lead of leads) {
    if (!wanted.has(String(lead.id))) continue;
    if (!hasWebsiteObservation(lead)) {
      excluded.push({
        id: lead.id,
        email: lead.email || undefined,
        reason: 'missing_website_observation',
      });
      continue;
    }
    included.push(lead);
  }
  return { included, excluded };
}

export function makeUnsubscribeToken(
  email: string,
  leadId: number | string,
  secret: string,
): string {
  const msg = `${leadId}:${String(email).trim().toLowerCase()}`;
  return createHmac('sha256', secret).update(msg).digest('hex').slice(0, 32);
}

export function buildUnsubscribeUrl(
  email: string,
  leadId: number | string,
  env: PolicyEnv = process.env,
): string {
  const secret = String(env.UNSUBSCRIBE_SECRET || '').trim();
  const origin = String(env.UNSUBSCRIBE_BASE_URL || env.APP_ORIGIN || 'https://www.bbl.studio')
    .trim()
    .replace(/\/$/, '');
  if (!secret || !email) {
    return `${origin}/unsubscribe`;
  }
  const token = makeUnsubscribeToken(email, leadId, secret);
  const params = new URLSearchParams({
    email: String(email).trim().toLowerCase(),
    lead_id: String(leadId),
    token,
  });
  return `${origin}/unsubscribe?${params.toString()}`;
}

export function complianceFooter(opts: {
  email: string;
  leadId: number | string;
  env?: PolicyEnv;
}): string {
  const env = opts.env || process.env;
  const postal =
    businessPostalAddress(env) || '[BUSINESS_POSTAL_ADDRESS — set env before live send]';
  const unsub = buildUnsubscribeUrl(opts.email, opts.leadId, env);
  return [
    '',
    'BBL Studio',
    'hello@bbl.studio · www.bbl.studio',
    postal,
    '',
    `Prefer not to receive these emails? Unsubscribe: ${unsub}`,
  ].join('\n');
}

/** Headers for List-Unsubscribe / List-Unsubscribe-Post (one-click). */
export function listUnsubscribeHeaders(unsubscribeUrl: string): Record<string, string> {
  const url = String(unsubscribeUrl || '').trim();
  if (!url || url.includes('[') || url.endsWith('/unsubscribe')) {
    return {};
  }
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

export function appendComplianceIfNeeded(
  body: string,
  lead: Partial<CrmLead>,
  env: PolicyEnv = process.env,
): string {
  const text = String(body || '');
  if (/unsubscribe/i.test(text) && /bbl\.studio/i.test(text)) {
    // Still ensure postal placeholder resolves via personalize; do not double-append.
    if (businessPostalAddress(env) || /\{\{\s*BUSINESS_POSTAL_ADDRESS\s*\}\}/.test(text)) {
      return text;
    }
  }
  return `${text.trimEnd()}\n${complianceFooter({
    email: String(lead.email || ''),
    leadId: lead.id ?? 0,
    env,
  })}`;
}

/** Fill template placeholders. Never invent website_observation. */
export function personalizeLead(
  template: string,
  lead: Partial<CrmLead>,
  env: PolicyEnv = process.env,
): string {
  const contact = lead.contact_name?.trim() || 'there';
  const business = lead.business_name?.trim() || 'your studio';
  const observation = leadWebsiteObservation(lead);
  const postal = businessPostalAddress(env) || '[BUSINESS_POSTAL_ADDRESS — set env before live send]';
  const unsub =
    lead.email && lead.id != null
      ? buildUnsubscribeUrl(String(lead.email), lead.id, env)
      : `${String(env.APP_ORIGIN || 'https://www.bbl.studio').replace(/\/$/, '')}/unsubscribe`;
  return template
    .replaceAll('{{contact_name}}', contact)
    .replaceAll('{{business_name}}', business)
    .replaceAll('{{email}}', lead.email || '')
    .replaceAll('{{location}}', lead.location || '')
    .replaceAll('{{category}}', lead.category || '')
    .replaceAll('{{website_observation}}', observation)
    .replaceAll('{{signed_unsubscribe_url}}', unsub)
    .replaceAll('{{BUSINESS_POSTAL_ADDRESS}}', postal);
}
