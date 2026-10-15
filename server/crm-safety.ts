/**
 * Safety gates for CRM email campaigns.
 * Automated outreach stays OFF. Manual send is dry-run unless an explicit
 * live flag is enabled (default: false).
 */

export type SafetyEnv = {
  EMAIL_OUTREACH_ENABLED?: string;
  EMAIL_DRY_RUN?: string;
  MANUAL_SEND_LIVE_ENABLED?: string;
};

function truthy(value: string | undefined) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function falsy(value: string | undefined) {
  return ['0', 'false', 'no', 'off'].includes(String(value || '').trim().toLowerCase());
}

/** Auto / scheduled outreach — always treated as disabled unless explicitly true. */
export function isOutreachEnabled(env: SafetyEnv = process.env) {
  return truthy(env.EMAIL_OUTREACH_ENABLED);
}

/** Default true. Only false when EMAIL_DRY_RUN is explicitly falsy. */
export function isDryRun(env: SafetyEnv = process.env) {
  if (env.EMAIL_DRY_RUN === undefined || env.EMAIL_DRY_RUN === '') return true;
  if (falsy(env.EMAIL_DRY_RUN)) return false;
  return true;
}

/** Manual live send — OFF unless MANUAL_SEND_LIVE_ENABLED is explicitly true. */
export function isManualLiveSendEnabled(env: SafetyEnv = process.env) {
  return truthy(env.MANUAL_SEND_LIVE_ENABLED);
}

/**
 * Whether this request may hit a real ESP.
 * Requires: dry-run false AND manual live flag AND confirm_live.
 * Outreach auto-enable alone is never enough.
 */
export function maySendLive(opts: { confirm_live?: boolean }, env: SafetyEnv = process.env) {
  if (isDryRun(env)) return false;
  if (!isManualLiveSendEnabled(env)) return false;
  if (!opts.confirm_live) return false;
  return true;
}

export function safetySnapshot(env: SafetyEnv = process.env) {
  return {
    EMAIL_OUTREACH_ENABLED: isOutreachEnabled(env),
    EMAIL_DRY_RUN: isDryRun(env),
    MANUAL_SEND_LIVE_ENABLED: isManualLiveSendEnabled(env),
    auto_outreach_active: false,
    live_manual_send_allowed: isManualLiveSendEnabled(env) && !isDryRun(env),
  };
}

export type SelectableLead = {
  id: number | string;
  email?: string | null;
  suppressed?: boolean;
  unsubscribed?: boolean;
  bounced?: 'YES' | 'NO' | 'UNKNOWN';
  email_status?: string | null;
};

export function normalizeId(id: number | string) {
  return String(id);
}

export function toggleSelection(selected: Array<number | string>, id: number | string) {
  const key = normalizeId(id);
  const set = new Set(selected.map(normalizeId));
  if (set.has(key)) set.delete(key);
  else set.add(key);
  return [...set];
}

export function selectAllIds(ids: Array<number | string>) {
  return [...new Set(ids.map(normalizeId))];
}

export function clearSelection() {
  return [] as string[];
}

export function selectedCount(selected: Array<number | string>) {
  return new Set(selected.map(normalizeId)).size;
}

/** Exclude unsubscribed / suppressed / hard-bounced / complained from send. */
export function filterSendableRecipients(
  leads: SelectableLead[],
  selectedIds: Array<number | string>,
) {
  const wanted = new Set(selectedIds.map(normalizeId));
  const included: SelectableLead[] = [];
  const excluded: Array<{ id: number | string; reason: string }> = [];

  for (const lead of leads) {
    const id = normalizeId(lead.id);
    if (!wanted.has(id)) continue;
    const status = String(lead.email_status || '').toUpperCase();
    if (lead.unsubscribed) {
      excluded.push({ id: lead.id, reason: 'unsubscribed' });
      continue;
    }
    if (lead.suppressed) {
      excluded.push({ id: lead.id, reason: 'suppressed' });
      continue;
    }
    if (lead.bounced === 'YES' || status === 'BOUNCED' || status === 'COMPLAINED') {
      excluded.push({ id: lead.id, reason: status === 'COMPLAINED' ? 'complained' : 'bounced' });
      continue;
    }
    if (!lead.email || !String(lead.email).includes('@')) {
      excluded.push({ id: lead.id, reason: 'invalid_email' });
      continue;
    }
    included.push(lead);
  }

  return { included, excluded };
}

export type ConfirmGateInput = {
  recipient_ids: Array<number | string>;
  preview_token?: string;
  expected_preview_token?: string;
  confirmed?: boolean;
};

export type ConfirmGateResult =
  | { ok: true }
  | { ok: false; code: 'no_recipients' | 'preview_required' | 'confirm_required'; message: string };

/**
 * Manual send gate: select → preview → confirm.
 * Does not authorize live ESP delivery by itself.
 */
export function validateManualSendGate(input: ConfirmGateInput): ConfirmGateResult {
  if (!input.recipient_ids?.length) {
    return { ok: false, code: 'no_recipients', message: 'Select at least one recipient before sending.' };
  }
  if (!input.preview_token || !input.expected_preview_token || input.preview_token !== input.expected_preview_token) {
    return {
      ok: false,
      code: 'preview_required',
      message: 'Preview the campaign before sending. Open Preview, then confirm.',
    };
  }
  if (!input.confirmed) {
    return {
      ok: false,
      code: 'confirm_required',
      message: 'Confirm the send in the review modal before continuing.',
    };
  }
  return { ok: true };
}
