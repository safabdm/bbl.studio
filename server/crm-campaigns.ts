import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CampaignDraft,
  CrmLead,
  EmailTemplate,
  ManualSendRequest,
  ManualSendResult,
  PersonalizedPreview,
} from './crm-types';
import {
  filterSendableRecipients,
  isDryRun,
  maySendLive,
  validateManualSendGate,
} from './crm-safety';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_TEMPLATES: EmailTemplate[] = [
  {
    id: 'tpl_intro',
    name: 'Studio introduction',
    subject: '{{business_name}} × BBL Studio',
    body: [
      'Hello {{contact_name}},',
      '',
      'I came across {{business_name}} and wanted to introduce BBL Studio — a boutique brand and website studio helping independent salons and beauty brands look as refined online as they do in person.',
      '',
      'If a clearer site or booking path would help, I would love to share a short overview.',
      '',
      'Safa',
      'BBL Studio',
      'hello@bbl.studio',
      'https://www.bbl.studio',
    ].join('\n'),
  },
  {
    id: 'tpl_followup',
    name: 'Soft follow-up',
    subject: 'Quick note for {{business_name}}',
    body: [
      'Hello {{contact_name}},',
      '',
      'Following up in case my earlier note about {{business_name}} was easy to miss.',
      '',
      'Happy to share a brief look at how BBL Studio approaches salon websites — no pressure either way.',
      '',
      'Safa',
      'BBL Studio',
      'hello@bbl.studio',
    ].join('\n'),
  },
];

const previewSessions = new Map<string, { recipient_ids: string[]; created_at: number; subject: string; body: string }>();
const PREVIEW_TTL_MS = 2 * 60 * 60 * 1000;

function draftsPath(env: NodeJS.ProcessEnv = process.env) {
  return resolve(root, env.CRM_DRAFTS_PATH || './data/crm-campaign-drafts.json');
}

function sendLogPath(env: NodeJS.ProcessEnv = process.env) {
  return resolve(root, env.CRM_SEND_LOG_PATH || './data/crm-send-log.json');
}

function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function listTemplates() {
  return DEFAULT_TEMPLATES;
}

export function personalize(template: string, lead: Partial<CrmLead>) {
  const contact = lead.contact_name?.trim() || 'there';
  const business = lead.business_name?.trim() || 'your studio';
  return template
    .replaceAll('{{contact_name}}', contact)
    .replaceAll('{{business_name}}', business)
    .replaceAll('{{email}}', lead.email || '')
    .replaceAll('{{location}}', lead.location || '')
    .replaceAll('{{category}}', lead.category || '');
}

export function buildPreviews(
  leads: CrmLead[],
  recipientIds: Array<number | string>,
  subject: string,
  body: string,
): PersonalizedPreview[] {
  const wanted = new Set(recipientIds.map(String));
  return leads
    .filter((lead) => wanted.has(String(lead.id)))
    .map((lead) => ({
      lead_id: lead.id,
      email: lead.email,
      business_name: lead.business_name,
      subject: personalize(subject, lead),
      body: personalize(body, lead),
    }));
}

export function createPreviewToken(
  recipientIds: Array<number | string>,
  subject: string,
  body: string,
) {
  const token = randomBytes(16).toString('hex');
  previewSessions.set(token, {
    recipient_ids: recipientIds.map(String).sort(),
    created_at: Date.now(),
    subject,
    body: createHash('sha256').update(body).digest('hex'),
  });
  return token;
}

export function getPreviewSession(token: string | undefined) {
  if (!token) return null;
  const session = previewSessions.get(token);
  if (!session) return null;
  if (Date.now() - session.created_at > PREVIEW_TTL_MS) {
    previewSessions.delete(token);
    return null;
  }
  return session;
}

/** Test helper — clear in-memory preview sessions. */
export function clearPreviewSessions() {
  previewSessions.clear();
}

export function listDrafts(env: NodeJS.ProcessEnv = process.env): CampaignDraft[] {
  return readJsonFile<CampaignDraft[]>(draftsPath(env), []);
}

export function saveDraft(
  input: Omit<CampaignDraft, 'id' | 'created_at' | 'updated_at'> & { id?: string },
  env: NodeJS.ProcessEnv = process.env,
): CampaignDraft {
  const drafts = listDrafts(env);
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
  writeJsonFile(draftsPath(env), next);
  return draft;
}

function appendSendLog(entry: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env) {
  const log = readJsonFile<Record<string, unknown>[]>(sendLogPath(env), []);
  log.unshift(entry);
  writeJsonFile(sendLogPath(env), log.slice(0, 200));
}

/**
 * Manual campaign send. Default path is dry-run only — no Resend call.
 * Live ESP send requires MANUAL_SEND_LIVE_ENABLED=true, EMAIL_DRY_RUN=false,
 * confirm_live, plus the select → preview → confirm gate.
 */
export function executeManualSend(
  request: ManualSendRequest,
  leads: CrmLead[],
  env: NodeJS.ProcessEnv = process.env,
  opts?: { liveSender?: (payload: { to: string; subject: string; text: string }) => Promise<boolean> },
): ManualSendResult {
  const gate = validateManualSendGate({
    recipient_ids: request.recipient_ids,
    preview_token: request.preview_token,
    expected_preview_token: getPreviewSession(request.preview_token) ? request.preview_token : undefined,
    confirmed: request.confirmed,
  });
  // Re-check preview session contents match current composition when present.
  const session = getPreviewSession(request.preview_token);
  if (gate.ok && session) {
    const sameRecipients =
      session.recipient_ids.join(',') === [...request.recipient_ids].map(String).sort().join(',');
    const sameBody = session.body === createHash('sha256').update(request.body).digest('hex');
    const sameSubject = session.subject === request.subject;
    if (!sameRecipients || !sameBody || !sameSubject) {
      return {
        ok: false,
        dry_run: true,
        live: false,
        campaign_id: '',
        recipient_count: 0,
        excluded_count: 0,
        excluded: [],
        intended: [],
        message: 'Preview is out of date. Preview again after changing recipients or copy.',
      };
    }
  }
  if (!gate.ok) {
    return {
      ok: false,
      dry_run: true,
      live: false,
      campaign_id: '',
      recipient_count: 0,
      excluded_count: 0,
      excluded: [],
      intended: [],
      message: gate.message,
    };
  }

  const { included, excluded } = filterSendableRecipients(leads, request.recipient_ids);
  const intended = included.map((lead) => ({
    id: lead.id,
    email: String(lead.email),
    subject: personalize(request.subject, lead as CrmLead),
  }));
  const campaignId = `camp_${randomBytes(8).toString('hex')}`;
  const live = maySendLive({ confirm_live: request.confirm_live }, env);

  if (!live) {
    appendSendLog(
      {
        id: campaignId,
        dry_run: true,
        live: false,
        name: request.campaign_name,
        subject: request.subject,
        recipient_count: intended.length,
        excluded,
        intended,
        created_at: new Date().toISOString(),
      },
      env,
    );
    return {
      ok: true,
      dry_run: true,
      live: false,
      campaign_id: campaignId,
      recipient_count: intended.length,
      excluded_count: excluded.length,
      excluded,
      intended,
      message: isDryRun(env)
        ? `Dry-run only: ${intended.length} recipient(s) logged. No emails were sent.`
        : `Manual live send is disabled (MANUAL_SEND_LIVE_ENABLED≠true). ${intended.length} recipient(s) logged as dry-run.`,
    };
  }

  // Live path — only when flags + confirm_live. Still refuses without a sender.
  if (!opts?.liveSender) {
    return {
      ok: false,
      dry_run: false,
      live: false,
      campaign_id: campaignId,
      recipient_count: intended.length,
      excluded_count: excluded.length,
      excluded,
      intended,
      message: 'Live send flagged but no ESP sender is configured. Aborting without sending.',
    };
  }

  // Intentionally not invoked in this build phase by default tests / UI.
  return {
    ok: false,
    dry_run: false,
    live: false,
    campaign_id: campaignId,
    recipient_count: intended.length,
    excluded_count: excluded.length,
    excluded,
    intended,
    message: 'Live ESP send is blocked in this build phase. Keep MANUAL_SEND_LIVE_ENABLED=false.',
  };
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
