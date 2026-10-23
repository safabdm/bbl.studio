/**
 * Email Studio — draft from template + verified website_observation.
 * Unique per lead; editable; regenerate; approve individually/bulk.
 * Signature + compliance footer required. No prices. Block approve without observation.
 */
import { randomUUID } from 'node:crypto';
import { dbReadKv, dbWriteKv, type CrmDbEnv } from './crm-db.js';
import {
  BOOKING_CTA_URL,
  CONSULT_MINUTES,
  appendComplianceIfNeeded,
  containsPricing,
  evaluateCopyPolicy,
  hasWebsiteObservation,
  leadWebsiteObservation,
  personalizeLead,
  policyBlocksSend,
  type PolicyEnv,
} from './outreach-policy.js';
import type { CrmLead } from './crm-types.js';
import type { LeadQueueItem } from './lead-queue.js';

export const EMAIL_STUDIO_KV = 'outreach:email_studio_drafts';

/** Exact owner signature (before postal + opt-out). */
export const OWNER_SIGNATURE = ['Safa', 'Founder, BBL Studio', 'hello@bbl.studio · www.bbl.studio'].join(
  '\n',
);

export const EMAIL_STUDIO_TEMPLATE = {
  id: 'studio_intro',
  name: 'Outreach Studio intro',
  subject: 'A quick idea for {{business_name}}',
  body: [
    'Hi {{contact_name}},',
    '',
    'I was looking at {{business_name}} and noticed {{website_observation}}.',
    '',
    'BBL Studio builds websites for Orange County beauty and wellness brands that make a stronger first impression and make booking feel effortless.',
    '',
    `I have a few specific ideas for {{business_name}} — happy to share them in a complimentary ${CONSULT_MINUTES}-minute website review.`,
    '',
    'Book a time here:',
    BOOKING_CTA_URL,
    '',
    OWNER_SIGNATURE,
    '',
    '{{BUSINESS_POSTAL_ADDRESS}}',
    '',
    'Prefer not to receive these emails? Unsubscribe:',
    '{{signed_unsubscribe_url}}',
  ].join('\n'),
};

export type EmailStudioDraft = {
  id: string;
  lead_id: string;
  email: string;
  business_name: string;
  subject: string;
  body: string;
  template_id: string;
  observation_verified: boolean;
  observation: string;
  approved: boolean;
  blocked_reasons: string[];
  created_at: string;
  updated_at: string;
};

export type EmailStudioEnv = CrmDbEnv & PolicyEnv;

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function toCrmLead(item: LeadQueueItem | (Partial<CrmLead> & { id: string | number; email?: string })): CrmLead {
  return {
    id: 'crm_lead_id' in item && item.crm_lead_id != null ? item.crm_lead_id : item.id,
    business_name: String(item.business_name || 'your studio'),
    contact_name: 'contact_name' in item ? item.contact_name : null,
    email: String(item.email || ''),
    location: 'location' in item ? item.location : null,
    category: 'category' in item ? item.category : null,
    website_observation: leadWebsiteObservation(item as Partial<CrmLead>) ||
      ('website_observation' in item ? String(item.website_observation || '') : ''),
    email_accepted: 'UNKNOWN',
    delivered: 'UNKNOWN',
    bounced: 'UNKNOWN',
    replied: 'UNKNOWN',
    booked: 'NO',
  };
}

export function observationGate(lead: Partial<CrmLead> | LeadQueueItem): {
  ok: boolean;
  observation: string;
  reason: string | null;
} {
  const observation = leadWebsiteObservation(lead as Partial<CrmLead>);
  if (!observation) {
    return {
      ok: false,
      observation: '',
      reason: 'Missing verified website_observation — approve blocked until a real site note exists.',
    };
  }
  return { ok: true, observation, reason: null };
}

export function draftBlocks(subject: string, body: string, lead: Partial<CrmLead>, env: PolicyEnv = process.env): string[] {
  const reasons: string[] = [];
  if (!hasWebsiteObservation(lead)) {
    reasons.push('missing_website_observation');
  }
  if (containsPricing(`${subject}\n${body}`)) {
    reasons.push('pricing_forbidden');
  }
  // Personalized drafts already inlined {{website_observation}} — do not re-require the placeholder.
  const issues = evaluateCopyPolicy(subject, body, env).filter((issue) => {
    if (issue.code === 'missing_website_observation_placeholder' && hasWebsiteObservation(lead)) {
      return false;
    }
    return true;
  });
  for (const issue of issues) {
    if (issue.severity === 'block') reasons.push(issue.code);
  }
  if (!body.includes(BOOKING_CTA_URL) && !body.includes('www.bbl.studio/book')) {
    reasons.push('missing_booking_cta');
  }
  if (!body.includes('Safa') || !body.includes('Founder, BBL Studio')) {
    reasons.push('missing_owner_signature');
  }
  return [...new Set(reasons)];
}

export function renderStudioDraft(
  lead: LeadQueueItem | CrmLead,
  opts: { subject?: string; body?: string; template_id?: string } = {},
  env: EmailStudioEnv = process.env,
): EmailStudioDraft {
  const crm = toCrmLead(lead as LeadQueueItem);
  const gate = observationGate(crm);
  const templateSubject = opts.subject ?? EMAIL_STUDIO_TEMPLATE.subject;
  const templateBody = opts.body ?? EMAIL_STUDIO_TEMPLATE.body;
  let subject = personalizeLead(templateSubject, crm, env);
  let body = personalizeLead(templateBody, crm, env);
  body = appendComplianceIfNeeded(body, crm, env);

  // Ensure exact signature block is present after personalize
  if (!body.includes(OWNER_SIGNATURE)) {
    body = `${body.trimEnd()}\n\n${OWNER_SIGNATURE}`;
  }

  const blocked = draftBlocks(subject, body, crm, env);
  if (!gate.ok && !blocked.includes('missing_website_observation')) {
    blocked.push('missing_website_observation');
  }

  const now = nowIso();
  const leadId = String('id' in lead ? lead.id : crm.id);
  return {
    id: `draft_${leadId}`,
    lead_id: leadId,
    email: crm.email,
    business_name: crm.business_name,
    subject,
    body,
    template_id: opts.template_id || EMAIL_STUDIO_TEMPLATE.id,
    observation_verified: gate.ok,
    observation: gate.observation,
    approved: false,
    blocked_reasons: blocked,
    created_at: now,
    updated_at: now,
  };
}

export async function listStudioDrafts(env: EmailStudioEnv = process.env): Promise<EmailStudioDraft[]> {
  const raw = await dbReadKv<EmailStudioDraft[]>(EMAIL_STUDIO_KV, [], env);
  return Array.isArray(raw) ? raw : [];
}

export async function saveStudioDraft(
  draft: EmailStudioDraft,
  env: EmailStudioEnv = process.env,
): Promise<EmailStudioDraft> {
  const all = await listStudioDrafts(env);
  const next = all.filter((d) => d.lead_id !== draft.lead_id);
  const saved = { ...draft, updated_at: nowIso() };
  next.unshift(saved);
  await dbWriteKv(EMAIL_STUDIO_KV, next.slice(0, 500), env);
  return saved;
}

export async function upsertStudioDraftFromLead(
  lead: LeadQueueItem | CrmLead,
  opts: { subject?: string; body?: string; regenerate?: boolean } = {},
  env: EmailStudioEnv = process.env,
): Promise<EmailStudioDraft> {
  const existing = (await listStudioDrafts(env)).find((d) => d.lead_id === String(lead.id));
  if (existing && !opts.regenerate && opts.subject === undefined && opts.body === undefined) {
    return existing;
  }
  const base = renderStudioDraft(
    lead,
    {
      subject: opts.subject ?? (opts.regenerate || !existing ? undefined : existing.subject),
      body: opts.body ?? (opts.regenerate || !existing ? undefined : existing.body),
    },
    env,
  );
  // If editing personalized copy, use provided subject/body as final (re-check gates)
  if (opts.subject !== undefined || opts.body !== undefined) {
    const crm = toCrmLead(lead as LeadQueueItem);
    const subject = opts.subject !== undefined ? opts.subject : base.subject;
    const body = opts.body !== undefined ? opts.body : base.body;
    base.subject = subject;
    base.body = body;
    base.blocked_reasons = draftBlocks(subject, body, crm, env);
    base.observation_verified = hasWebsiteObservation(crm);
    base.observation = leadWebsiteObservation(crm);
    if (existing) {
      base.id = existing.id;
      base.created_at = existing.created_at;
      base.approved = false;
    }
  } else if (existing && !opts.regenerate) {
    base.id = existing.id;
    base.created_at = existing.created_at;
  } else {
    base.id = existing?.id || `draft_${randomUUID().slice(0, 12)}`;
  }
  return saveStudioDraft(base, env);
}

export async function approveStudioDrafts(
  leadIds: string[],
  env: EmailStudioEnv = process.env,
): Promise<{ approved: EmailStudioDraft[]; blocked: Array<{ lead_id: string; reasons: string[] }> }> {
  const all = await listStudioDrafts(env);
  const wanted = new Set(leadIds.map(String));
  const approved: EmailStudioDraft[] = [];
  const blocked: Array<{ lead_id: string; reasons: string[] }> = [];
  const next: EmailStudioDraft[] = [];

  for (const draft of all) {
    if (!wanted.has(draft.lead_id)) {
      next.push(draft);
      continue;
    }
    const reasons = draft.blocked_reasons.length
      ? draft.blocked_reasons
      : draftBlocks(draft.subject, draft.body, {
          id: draft.lead_id,
          email: draft.email,
          business_name: draft.business_name,
          website_observation: draft.observation,
          email_accepted: 'UNKNOWN',
          delivered: 'UNKNOWN',
          bounced: 'UNKNOWN',
          replied: 'UNKNOWN',
          booked: 'NO',
        }, env);
    if (reasons.length || !draft.observation_verified) {
      blocked.push({
        lead_id: draft.lead_id,
        reasons: reasons.length ? reasons : ['missing_website_observation'],
      });
      next.push({ ...draft, approved: false, blocked_reasons: reasons });
      continue;
    }
    // policyBlocksSend on personalized copy — ignore observation placeholder when verified
    const issues = evaluateCopyPolicy(draft.subject, draft.body, env).filter((issue) => {
      if (issue.code === 'missing_website_observation_placeholder' && draft.observation_verified) {
        return false;
      }
      return true;
    });
    if (policyBlocksSend(issues)) {
      const codes = issues.filter((i) => i.severity === 'block').map((i) => i.code);
      blocked.push({ lead_id: draft.lead_id, reasons: codes });
      next.push({ ...draft, approved: false, blocked_reasons: codes });
      continue;
    }
    const ok = { ...draft, approved: true, updated_at: nowIso(), blocked_reasons: [] };
    approved.push(ok);
    next.push(ok);
  }

  await dbWriteKv(EMAIL_STUDIO_KV, next, env);
  return { approved, blocked };
}

export function signatureAndFooterPresent(body: string): boolean {
  return (
    body.includes('Safa') &&
    body.includes('Founder, BBL Studio') &&
    /hello@bbl\.studio/i.test(body) &&
    /unsubscribe/i.test(body)
  );
}
