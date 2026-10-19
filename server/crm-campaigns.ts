import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type {
  CampaignDraft,
  CrmLead,
  EmailTemplate,
  ManualSendRequest,
  ManualSendResult,
  PersonalizedPreview,
} from './crm-types.js';
import { isDryRun, type SafetyEnv } from './crm-safety.js';
import {
  dbReadKv,
  dbWriteKv,
  isDurableDbConfigured,
  requiresDurableDb,
  type CrmDbEnv,
} from './crm-db.js';
import { resolveProjectRoot } from './project-root.js';
import {
  BOOKING_CTA_URL,
  CONSULT_MINUTES,
  evaluateCopyPolicy,
  filterObservationRequired,
  personalizeLead,
  type PolicyEnv,
} from './outreach-policy.js';
import {
  createSignedPreviewToken,
  verifySignedPreviewToken,
  type PreviewTokenEnv,
} from './preview-token.js';
import { executeApprovedManualSend, type ResendSendEnv } from './resend-send.js';

function projectRoot() {
  return resolveProjectRoot(import.meta.url);
}

/** Intro / follow-up — no pricing; private quotes after consult only. */
export const DEFAULT_TEMPLATES: EmailTemplate[] = [
  {
    id: 'tpl_intro',
    name: 'Studio introduction',
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
      'Best,',
      'BBL Studio',
      'hello@bbl.studio · www.bbl.studio',
      '',
      '{{BUSINESS_POSTAL_ADDRESS}}',
      '',
      'Prefer not to receive these emails? Unsubscribe:',
      '{{signed_unsubscribe_url}}',
    ].join('\n'),
  },
  {
    id: 'tpl_followup',
    name: 'Soft follow-up',
    subject: 'Re: A quick idea for {{business_name}}',
    body: [
      'Hi {{contact_name}},',
      '',
      'Quick follow-up in case my last note got buried.',
      '',
      `If helpful, I can still walk through a complimentary ${CONSULT_MINUTES}-minute website review for {{business_name}} — including the note that {{website_observation}}.`,
      '',
      `Book here: ${BOOKING_CTA_URL}`,
      '',
      'Best,',
      'BBL Studio',
      'hello@bbl.studio',
      '',
      '{{BUSINESS_POSTAL_ADDRESS}}',
      '',
      'Unsubscribe: {{signed_unsubscribe_url}}',
    ].join('\n'),
  },
];

const DRAFTS_KV_KEY = 'campaign_drafts';
const SEND_LOG_KV_KEY = 'campaign_send_log';

export type CampaignStoreEnv = CrmDbEnv &
  SafetyEnv &
  PolicyEnv &
  PreviewTokenEnv &
  ResendSendEnv & {
    CRM_DRAFTS_PATH?: string;
    CRM_SEND_LOG_PATH?: string;
    VERCEL?: string;
  };

function draftsPath(env: CampaignStoreEnv = process.env) {
  if (env.CRM_DRAFTS_PATH) return resolve(env.CRM_DRAFTS_PATH);
  return resolve(projectRoot(), './data/crm-campaign-drafts.json');
}

function sendLogPath(env: CampaignStoreEnv = process.env) {
  if (env.CRM_SEND_LOG_PATH) return resolve(env.CRM_SEND_LOG_PATH);
  return resolve(projectRoot(), './data/crm-send-log.json');
}

function assertLocalFsAllowed(env: CampaignStoreEnv, label: string) {
  if (requiresDurableDb(env)) {
    throw new Error(
      isDurableDbConfigured(env)
        ? `${label} must use durable Postgres on serverless — refusing local filesystem write.`
        : `${label} requires CRM_DATABASE_URL on serverless. Local ./data is not writable there.`,
    );
  }
}

function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(path: string, value: unknown, env: CampaignStoreEnv = process.env) {
  assertLocalFsAllowed(env, 'Campaign local store');
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/ENOENT|EACCES|EROFS|mkdir/i.test(message)) {
      throw new Error(
        'Campaign storage is not writable on this host. Configure CRM_DATABASE_URL (Neon) for drafts.',
      );
    }
    throw err;
  }
}

export function listTemplates() {
  return DEFAULT_TEMPLATES;
}

export function personalize(template: string, lead: Partial<CrmLead>, env: PolicyEnv = process.env) {
  return personalizeLead(template, lead, env);
}

export function buildPreviews(
  leads: CrmLead[],
  recipientIds: Array<number | string>,
  subject: string,
  body: string,
  env: CampaignStoreEnv = process.env,
): PersonalizedPreview[] {
  const wanted = new Set(recipientIds.map(String));
  return leads
    .filter((lead) => wanted.has(String(lead.id)))
    .map((lead) => ({
      lead_id: lead.id,
      email: lead.email,
      business_name: lead.business_name,
      subject: personalize(subject, lead, env),
      body: personalize(body, lead, env),
      excluded: !lead.website_observation?.trim(),
      exclude_reason: !lead.website_observation?.trim() ? 'missing_website_observation' : undefined,
    }));
}

export function createPreviewToken(
  recipientIds: Array<number | string>,
  subject: string,
  body: string,
  env: CampaignStoreEnv = process.env,
) {
  return createSignedPreviewToken(recipientIds, subject, body, env);
}

export function getPreviewSession(token: string | undefined, env: CampaignStoreEnv = process.env) {
  return verifySignedPreviewToken(token, env);
}

/** Test helper — HMAC tokens are stateless; no-op retained for test imports. */
export function clearPreviewSessions() {
  /* HMAC tokens are verified statelessly; nothing to clear. */
}

export async function listDrafts(env: CampaignStoreEnv = process.env): Promise<CampaignDraft[]> {
  if (isDurableDbConfigured(env)) {
    const drafts = await dbReadKv<CampaignDraft[]>(DRAFTS_KV_KEY, [], env);
    return Array.isArray(drafts) ? drafts : [];
  }
  if (requiresDurableDb(env)) {
    return [];
  }
  return readJsonFile<CampaignDraft[]>(draftsPath(env), []);
}

export async function saveDraft(
  input: Omit<CampaignDraft, 'id' | 'created_at' | 'updated_at'> & { id?: string },
  env: CampaignStoreEnv = process.env,
): Promise<CampaignDraft> {
  const drafts = await listDrafts(env);
  const now = new Date().toISOString();
  const existing = input.id ? drafts.find((d) => d.id === input.id) : undefined;
  const draft: CampaignDraft = {
    id: existing?.id || `draft_${randomBytes(8).toString('hex')}`,
    name: input.name,
    subject: input.subject,
    body: input.body,
    template_id: input.template_id ?? null,
    recipient_ids: input.recipient_ids,
    created_at: existing?.created_at || now,
    updated_at: now,
  };
  const next = existing ? drafts.map((d) => (d.id === draft.id ? draft : d)) : [draft, ...drafts];

  if (isDurableDbConfigured(env)) {
    await dbWriteKv(DRAFTS_KV_KEY, next, env);
    return draft;
  }
  assertLocalFsAllowed(env, 'Campaign drafts');
  writeJsonFile(draftsPath(env), next, env);
  return draft;
}

async function appendSendLog(entry: Record<string, unknown>, env: CampaignStoreEnv = process.env) {
  if (isDurableDbConfigured(env)) {
    const log = await dbReadKv<Record<string, unknown>[]>(SEND_LOG_KV_KEY, [], env);
    const next = [entry, ...(Array.isArray(log) ? log : [])].slice(0, 200);
    await dbWriteKv(SEND_LOG_KV_KEY, next, env);
    return;
  }
  if (requiresDurableDb(env)) {
    return;
  }
  assertLocalFsAllowed(env, 'Campaign send log');
  const log = readJsonFile<Record<string, unknown>[]>(sendLogPath(env), []);
  log.unshift(entry);
  writeJsonFile(sendLogPath(env), log.slice(0, 200), env);
}

export async function listSendLog(env: CampaignStoreEnv = process.env): Promise<Record<string, unknown>[]> {
  if (isDurableDbConfigured(env)) {
    const log = await dbReadKv<Record<string, unknown>[]>(SEND_LOG_KV_KEY, [], env);
    return Array.isArray(log) ? log : [];
  }
  if (requiresDurableDb(env)) return [];
  return readJsonFile<Record<string, unknown>[]>(sendLogPath(env), []);
}

export function analyzeCampaignRecipients(
  leads: CrmLead[],
  recipientIds: Array<number | string>,
  subject: string,
  body: string,
  env: CampaignStoreEnv = process.env,
) {
  const policy_issues = evaluateCopyPolicy(subject, body, env);
  const { included, excluded } = filterObservationRequired(leads, recipientIds);
  return { policy_issues, observation_excluded: excluded, observation_included: included };
}

/**
 * Manual campaign send. Default path is dry-run only — no Resend call.
 * Live ESP send requires MANUAL_SEND_LIVE_ENABLED=true, EMAIL_DRY_RUN=false,
 * confirm_live ("Send for real"), HMAC preview, policy pass, server-side leads.
 */
export async function executeManualSend(
  request: ManualSendRequest,
  leads: CrmLead[],
  env: CampaignStoreEnv = process.env,
  opts?: Parameters<typeof executeApprovedManualSend>[3],
): Promise<ManualSendResult> {
  const result = await executeApprovedManualSend(request, leads, env, opts);
  await appendSendLog(
    {
      id: result.campaign_id || `camp_${randomBytes(8).toString('hex')}`,
      dry_run: result.dry_run,
      live: result.live,
      name: request.campaign_name,
      subject: request.subject,
      recipient_count: result.recipient_count,
      excluded: result.excluded,
      intended: result.intended,
      policy_issues: result.policy_issues,
      created_at: new Date().toISOString(),
      message: result.message,
    },
    env,
  );
  if (!result.ok && !result.campaign_id) {
    return result;
  }
  if (result.ok && result.dry_run && !result.message) {
    return {
      ...result,
      message: isDryRun(env)
        ? `Dry-run only: ${result.recipient_count} recipient(s) logged. No emails were sent.`
        : result.message,
    };
  }
  return result;
}

export function sendTestDryRun(to: string, subject: string, body: string) {
  return {
    ok: true,
    dry_run: true,
    to,
    subject,
    body,
    message: `Test email dry-run to ${to}. Nothing was sent.`,
  };
}
