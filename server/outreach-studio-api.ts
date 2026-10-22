/**
 * HTTP handlers for Outreach Studio (Lead Queue, Email Studio, caps, Graph).
 * Live prospect email stays gated — defaults OFF.
 */
import type { CrmJsonResult } from './crm-api.js';
import {
  applySuggestedCap,
  maybeSuggestCapRaise,
  readDailyCapState,
  remainingSends,
  setDailyCap,
  effectiveCap,
  type DailyCapEnv,
} from './daily-cap.js';
import {
  approveStudioDrafts,
  listStudioDrafts,
  renderStudioDraft,
  upsertStudioDraftFromLead,
  EMAIL_STUDIO_TEMPLATE,
} from './email-studio.js';
import {
  buildGraphAuthUrl,
  clearGraphTokens,
  createOauthState,
  exchangeGraphAuthCode,
  getActiveSender,
  importGraphReplies,
  saveGraphTokens,
  senderSettingsSnapshot,
  sendViaGraph,
  setActiveSender,
  type ActiveSender,
  type GraphSenderEnv,
} from './graph-sender.js';
import {
  applyLeadQueueAction,
  buildLeadQueue,
  filterLeadQueue,
  readLeadQueueAudit,
  type LeadQueueAction,
  type LeadQueueEnv,
  type LeadQueueFilter,
} from './lead-queue.js';
import { safetySnapshot, type SafetyEnv } from './crm-safety.js';
import {
  cancelSending,
  enqueueApprovedRecipients,
  pauseSending,
  processNextSend,
  readSendControls,
  readSendQueue,
  recordBounceOrComplaint,
  resumeSending,
  countResendRisk,
  writeSendControls,
  type SendControlsEnv,
} from './send-controls.js';
import { dbWriteKv } from './crm-db.js';
import {
  bulkApproveDaily20,
  getDaily20Dashboard,
  type Daily20Env,
} from './daily-20-pipeline.js';
import {
  generateFollowUpDrafts,
  listFollowUpDrafts,
  listInterestedNotify,
  recordInterestedFromInbox,
} from './follow-up-drafts.js';
import { fetchEmailHistory, fetchLeads } from './crm-lead-client.js';

/** Narrow wide env intersections for safetySnapshot (same pattern as discoverySafetyEnv). */
function asSafetyEnv(env: Record<string, unknown> | NodeJS.ProcessEnv): SafetyEnv {
  return {
    EMAIL_OUTREACH_ENABLED: env.EMAIL_OUTREACH_ENABLED as string | undefined,
    EMAIL_DRY_RUN: env.EMAIL_DRY_RUN as string | undefined,
    MANUAL_SEND_LIVE_ENABLED: env.MANUAL_SEND_LIVE_ENABLED as string | undefined,
  };
}

function adminOk(isAdmin: boolean): CrmJsonResult | null {
  if (isAdmin) return null;
  return { status: 401, body: { ok: false, message: 'Sign in required.' } };
}

const OAUTH_STATE_KV = 'outreach:graph_oauth_state';

export async function handleLeadQueueList(
  isAdmin: boolean,
  query: LeadQueueFilter = {},
  env: LeadQueueEnv = process.env,
): Promise<CrmJsonResult> {
  const denied = adminOk(isAdmin);
  if (denied) return denied;
  const built = await buildLeadQueue({}, env);
  const items = filterLeadQueue(built.items, query);
  return {
    status: 200,
    body: {
      ok: true,
      items,
      excluded: built.excluded,
      count: items.length,
      excluded_count: built.excluded.length,
      message: built.message,
      live_email_send: false,
      safety: { ...safetySnapshot(asSafetyEnv(env)), FOLLOWUPS_LIVE: false },
    },
  };
}

export async function handleLeadQueueAction(
  isAdmin: boolean,
  body: { lead_id?: string; action?: LeadQueueAction; reason?: string },
  env: LeadQueueEnv = process.env,
): Promise<CrmJsonResult> {
  const denied = adminOk(isAdmin);
  if (denied) return denied;
  if (!body.lead_id || !body.action) {
    return { status: 400, body: { ok: false, message: 'lead_id and action required.' } };
  }
  const result = await applyLeadQueueAction(
    { lead_id: body.lead_id, action: body.action, reason: body.reason },
    env,
  );
  if (!result.ok) return { status: 400, body: result };
  return {
    status: 200,
    body: { ok: true, audit: result.audit, message: `Action ${body.action} saved.` },
  };
}

export async function handleLeadQueueAudit(
  isAdmin: boolean,
  env: LeadQueueEnv = process.env,
): Promise<CrmJsonResult> {
  const denied = adminOk(isAdmin);
  if (denied) return denied;
  const audit = await readLeadQueueAudit(env);
  return { status: 200, body: { ok: true, audit } };
}

export async function handleEmailStudioList(
  isAdmin: boolean,
  env = process.env,
): Promise<CrmJsonResult> {
  const denied = adminOk(isAdmin);
  if (denied) return denied;
  const drafts = await listStudioDrafts(env);
  return {
    status: 200,
    body: {
      ok: true,
      drafts,
      template: EMAIL_STUDIO_TEMPLATE,
      live_email_send: false,
    },
  };
}

export async function handleEmailStudioDraft(
  isAdmin: boolean,
  body: {
    lead_id?: string;
    subject?: string;
    body?: string;
    regenerate?: boolean;
    lead?: Parameters<typeof renderStudioDraft>[0];
  },
  env = process.env,
): Promise<CrmJsonResult> {
  const denied = adminOk(isAdmin);
  if (denied) return denied;
  if (!body.lead && !body.lead_id) {
    return { status: 400, body: { ok: false, message: 'lead or lead_id required.' } };
  }
  let lead = body.lead;
  if (!lead && body.lead_id) {
    const built = await buildLeadQueue({}, env);
    lead = [...built.items, ...built.excluded].find((i) => i.id === body.lead_id);
  }
  if (!lead) {
    return { status: 404, body: { ok: false, message: 'Lead not found in queue.' } };
  }
  const draft = await upsertStudioDraftFromLead(
    lead,
    { subject: body.subject, body: body.body, regenerate: body.regenerate },
    env,
  );
  return {
    status: 200,
    body: {
      ok: true,
      draft,
      blocked: draft.blocked_reasons.length > 0,
      message: draft.blocked_reasons.length
        ? `Draft saved but blocked: ${draft.blocked_reasons.join(', ')}`
        : 'Draft ready.',
      live_email_send: false,
    },
  };
}

export async function handleEmailStudioApprove(
  isAdmin: boolean,
  body: { lead_ids?: string[] },
  env = process.env,
): Promise<CrmJsonResult> {
  const denied = adminOk(isAdmin);
  if (denied) return denied;
  const ids = body.lead_ids || [];
  if (!ids.length) return { status: 400, body: { ok: false, message: 'lead_ids required.' } };
  const result = await approveStudioDrafts(ids, env);
  return {
    status: 200,
    body: {
      ok: true,
      approved: result.approved,
      blocked: result.blocked,
      message: result.blocked.length
        ? `${result.approved.length} approved, ${result.blocked.length} blocked (observation/policy).`
        : `${result.approved.length} draft(s) approved.`,
      live_email_send: false,
    },
  };
}

export async function handleDailyCapGet(
  isAdmin: boolean,
  env: DailyCapEnv = process.env,
): Promise<CrmJsonResult> {
  const denied = adminOk(isAdmin);
  if (denied) return denied;
  const state = await readDailyCapState(env);
  return {
    status: 200,
    body: {
      ok: true,
      state,
      effective_cap: effectiveCap(state),
      remaining: remainingSends(state),
      suggestion_auto_applies: false,
    },
  };
}

export async function handleDailyCapSet(
  isAdmin: boolean,
  body: { cap?: number; apply_suggestion?: boolean },
  env: DailyCapEnv = process.env,
): Promise<CrmJsonResult> {
  const denied = adminOk(isAdmin);
  if (denied) return denied;
  if (body.apply_suggestion) {
    const result = await applySuggestedCap(env);
    if (!result.ok) return { status: 400, body: result };
    return { status: 200, body: { ok: true, state: result.state, message: 'Suggested cap applied by owner.' } };
  }
  if (body.cap == null) return { status: 400, body: { ok: false, message: 'cap required.' } };
  const state = await setDailyCap(Number(body.cap), env);
  return { status: 200, body: { ok: true, state, message: 'Daily cap updated.' } };
}

export async function handleSendControlsGet(
  isAdmin: boolean,
  env: SendControlsEnv = process.env,
): Promise<CrmJsonResult> {
  const denied = adminOk(isAdmin);
  if (denied) return denied;
  const [controls, queue, cap] = await Promise.all([
    readSendControls(env),
    readSendQueue(env),
    readDailyCapState(env),
  ]);
  return {
    status: 200,
    body: {
      ok: true,
      controls,
      queue,
      resend_risk: countResendRisk(queue),
      daily_cap: {
        state: cap,
        effective_cap: effectiveCap(cap),
        remaining: remainingSends(cap),
      },
      live_email_send: false,
    },
  };
}

export async function handleSendControlsAction(
  isAdmin: boolean,
  body: {
    action?: 'pause' | 'resume' | 'cancel' | 'enqueue' | 'process_one' | 'record_bounce' | 'record_complaint';
    reason?: string;
    recipients?: Array<{
      lead_id: string;
      email: string;
      business_name: string;
      subject: string;
      body: string;
      draft_id: string;
    }>;
    confirm_recipients?: string[];
    allow_live?: boolean;
  },
  env: SendControlsEnv & GraphSenderEnv = process.env,
): Promise<CrmJsonResult> {
  const denied = adminOk(isAdmin);
  if (denied) return denied;
  const action = body.action;
  if (!action) return { status: 400, body: { ok: false, message: 'action required.' } };

  if (action === 'pause') {
    const controls = await pauseSending(body.reason || 'Paused by owner', env);
    return { status: 200, body: { ok: true, controls } };
  }
  if (action === 'resume') {
    const controls = await resumeSending(env);
    return { status: 200, body: { ok: true, controls } };
  }
  if (action === 'cancel') {
    const result = await cancelSending(env);
    return { status: 200, body: { ok: true, ...result } };
  }
  if (action === 'record_bounce') {
    const controls = await recordBounceOrComplaint('bounce', env);
    return { status: 200, body: { ok: true, controls } };
  }
  if (action === 'record_complaint') {
    const controls = await recordBounceOrComplaint('complaint', env);
    return { status: 200, body: { ok: true, controls } };
  }
  if (action === 'enqueue') {
    const recipients = body.recipients || [];
    if (!recipients.length) {
      return { status: 400, body: { ok: false, message: 'recipients required.' } };
    }
    const listed = body.confirm_recipients?.map((e) => e.toLowerCase()) || [];
    if (!listed.length) {
      return {
        status: 400,
        body: {
          ok: false,
          message: 'Explicit confirm_recipients (email list) required before enqueue.',
          recipients_preview: recipients.map((r) => r.email),
        },
      };
    }
    for (const r of recipients) {
      if (!listed.includes(r.email.toLowerCase())) {
        return {
          status: 400,
          body: { ok: false, message: `Recipient ${r.email} not in confirm_recipients list.` },
        };
      }
    }
    const result = await enqueueApprovedRecipients(recipients, env);
    return {
      status: 200,
      body: {
        ok: true,
        ...result,
        message: `Queued ${result.added} (skipped ${result.skipped} already submitted/pending).`,
        live_email_send: false,
      },
    };
  }
  if (action === 'process_one') {
    // Real ESP only when allow_live AND existing CRM safety gates. Otherwise mocked provider.
    if (body.allow_live && !safetySnapshot(asSafetyEnv(env)).live_manual_send_allowed) {
      return {
        status: 403,
        body: {
          ok: false,
          message: 'Live send blocked: MANUAL_SEND_LIVE_ENABLED / EMAIL_DRY_RUN gates.',
          safety: safetySnapshot(asSafetyEnv(env)),
        },
      };
    }
    const allowLive = Boolean(body.allow_live) && safetySnapshot(asSafetyEnv(env)).live_manual_send_allowed;
    const active = await getActiveSender(env);
    const processed = await processNextSend(
      async (item) => {
        if (!allowLive) {
          return { ok: true, provider_message_id: `mock_${item.attempt_token.slice(0, 8)}` };
        }
        if (active === 'graph') {
          const sent = await sendViaGraph(item, env);
          return sent.ok
            ? { ok: true, provider_message_id: sent.provider_message_id }
            : { ok: false, error: sent.message };
        }
        return { ok: false, error: 'Active sender not connected for live send (pick Graph or Resend).' };
      },
      env,
      { allowLive: true },
    );
    return {
      status: 200,
      body: { ok: true, ...processed, live_email_send: allowLive },
    };
  }
  return { status: 400, body: { ok: false, message: `Unknown action ${action}` } };
}

export async function handleOutlookConnect(
  isAdmin: boolean,
  env: GraphSenderEnv = process.env,
): Promise<CrmJsonResult> {
  const denied = adminOk(isAdmin);
  if (denied) return denied;
  const state = createOauthState();
  await dbWriteKv(OAUTH_STATE_KV, { state, created_at: new Date().toISOString() }, env);
  const auth = buildGraphAuthUrl(state, env);
  if (!auth.ok) return { status: 503, body: { ok: false, message: auth.message } };
  return { status: 200, body: { ok: true, authorize_url: auth.url, state } };
}

export async function handleOutlookCallback(
  query: { code?: string; state?: string; error?: string },
  env: GraphSenderEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<CrmJsonResult> {
  if (query.error) {
    return { status: 400, body: { ok: false, message: `Outlook OAuth error: ${query.error}` } };
  }
  if (!query.code || !query.state) {
    return { status: 400, body: { ok: false, message: 'code and state required.' } };
  }
  const stored = await import('./crm-db.js').then((m) =>
    m.dbReadKv<{ state: string } | null>(OAUTH_STATE_KV, null, env),
  );
  if (!stored || stored.state !== query.state) {
    return { status: 400, body: { ok: false, message: 'Invalid OAuth state.' } };
  }
  const exchanged = await exchangeGraphAuthCode(query.code, env, fetchImpl);
  if (!exchanged.ok) return { status: 400, body: { ok: false, message: exchanged.message } };
  await saveGraphTokens(
    {
      access_token: exchanged.access_token,
      refresh_token: exchanged.refresh_token,
      expires_in: exchanged.expires_in,
    },
    env,
  );
  await dbWriteKv(OAUTH_STATE_KV, null, env);
  return {
    status: 200,
    body: { ok: true, message: 'Outlook connected. Choose Graph as active sender in Settings.' },
  };
}

export async function handleOutlookDisconnect(
  isAdmin: boolean,
  env: GraphSenderEnv = process.env,
): Promise<CrmJsonResult> {
  const denied = adminOk(isAdmin);
  if (denied) return denied;
  await clearGraphTokens(env);
  const active = await getActiveSender(env);
  if (active === 'graph') await setActiveSender('none', env);
  return { status: 200, body: { ok: true, message: 'Outlook disconnected.' } };
}

export async function handleSenderPreference(
  isAdmin: boolean,
  body: { active_sender?: ActiveSender },
  env: GraphSenderEnv = process.env,
): Promise<CrmJsonResult> {
  const denied = adminOk(isAdmin);
  if (denied) return denied;
  if (body.active_sender) {
    if (!['graph', 'resend', 'none'].includes(body.active_sender)) {
      return { status: 400, body: { ok: false, message: 'active_sender must be graph|resend|none.' } };
    }
    await setActiveSender(body.active_sender, env);
  }
  const snapshot = await senderSettingsSnapshot(env);
  return { status: 200, body: { ok: true, ...snapshot } };
}

export async function handleInboxImportReplies(
  isAdmin: boolean,
  env: GraphSenderEnv & LeadQueueEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<CrmJsonResult> {
  const denied = adminOk(isAdmin);
  if (denied) return denied;
  const built = await buildLeadQueue({}, env);
  const emails = new Set(
    [...built.items, ...built.excluded].map((i) => i.email).filter(Boolean),
  );
  const imported = await importGraphReplies({ known_emails: emails }, env, fetchImpl);
  if (!imported.ok) return { status: 502, body: { ok: false, message: imported.message } };
  const interested = await recordInterestedFromInbox(imported.items, env);
  return {
    status: 200,
    body: {
      ok: true,
      items: imported.items,
      marked_replied: imported.marked_replied,
      interested_notify: interested,
      message: interested.length
        ? `Imported ${imported.items.length} reply(ies); ${interested.length} flagged Interested for owner (no auto-reply).`
        : `Imported ${imported.items.length} reply(ies). Follow-ups should stop for matched senders.`,
    },
  };
}

export async function handleDaily20Get(
  isAdmin: boolean,
  query: { refresh?: string } = {},
  env: Daily20Env = process.env,
): Promise<CrmJsonResult> {
  const denied = adminOk(isAdmin);
  if (denied) return denied;
  const dash = await getDaily20Dashboard(env, { refresh: query.refresh !== '0' });
  const controls = await readSendControls(env);
  return {
    status: 200,
    body: {
      ok: true,
      ...dash,
      send_window: {
        enforce: controls.enforce_send_window,
        start_hour_pt: controls.window_start_hour_pt,
        end_hour_pt: controls.window_end_hour_pt,
        label: `${controls.window_start_hour_pt ?? 9}–${controls.window_end_hour_pt ?? 11} America/Los_Angeles`,
      },
      mail_app_interim:
        'Mac operator may send via Mail.app when Graph is unavailable — document only; Graph/Resend remain primary in Settings. No auto-send.',
      live_email_send: false,
      safety: { ...safetySnapshot(asSafetyEnv(env)), FOLLOWUPS_LIVE: false },
    },
  };
}

export async function handleDaily20BulkApprove(
  isAdmin: boolean,
  body: { lead_ids?: string[]; select_all_qualified?: boolean },
  env: Daily20Env = process.env,
): Promise<CrmJsonResult> {
  const denied = adminOk(isAdmin);
  if (denied) return denied;
  let ids = body.lead_ids || [];
  if (body.select_all_qualified) {
    const dash = await getDaily20Dashboard(env, { refresh: false });
    ids = dash.cohort.qualified.map((q) => q.id);
  }
  if (!ids.length) {
    return { status: 400, body: { ok: false, message: 'lead_ids or select_all_qualified required.' } };
  }
  const result = await bulkApproveDaily20(ids, env);
  return {
    status: 200,
    body: {
      ok: true,
      ...result,
      message: `${result.approved.length} approved for send queue prep; ${result.blocked.length} blocked.`,
      live_email_send: false,
    },
  };
}

export async function handleFollowUpDrafts(
  isAdmin: boolean,
  body: { generate?: boolean } = {},
  env: LeadQueueEnv = process.env,
): Promise<CrmJsonResult> {
  const denied = adminOk(isAdmin);
  if (denied) return denied;
  let created: Awaited<ReturnType<typeof generateFollowUpDrafts>> = [];
  if (body.generate) {
    const [leads, history] = await Promise.all([fetchLeads('', env), fetchEmailHistory(env)]);
    created = await generateFollowUpDrafts(
      {
        leads: leads.data || [],
        history: history.data || [],
      },
      env,
    );
  }
  const drafts = await listFollowUpDrafts(env);
  const interested = await listInterestedNotify(env);
  return {
    status: 200,
    body: {
      ok: true,
      drafts,
      created_count: created.length,
      interested_notify: interested.filter((i) => !i.acknowledged),
      message: 'Follow-up drafts are for owner approval only — never auto-sent.',
      live_email_send: false,
    },
  };
}

export async function handleSendWindowSet(
  isAdmin: boolean,
  body: { enforce_send_window?: boolean; window_start_hour_pt?: number; window_end_hour_pt?: number },
  env: SendControlsEnv = process.env,
): Promise<CrmJsonResult> {
  const denied = adminOk(isAdmin);
  if (denied) return denied;
  const controls = await readSendControls(env);
  const next = await writeSendControls(
    {
      ...controls,
      enforce_send_window:
        body.enforce_send_window === undefined ? controls.enforce_send_window : Boolean(body.enforce_send_window),
      window_start_hour_pt:
        body.window_start_hour_pt === undefined
          ? controls.window_start_hour_pt
          : Math.min(23, Math.max(0, Math.round(body.window_start_hour_pt))),
      window_end_hour_pt:
        body.window_end_hour_pt === undefined
          ? controls.window_end_hour_pt
          : Math.min(24, Math.max(1, Math.round(body.window_end_hour_pt))),
    },
    env,
  );
  return {
    status: 200,
    body: {
      ok: true,
      controls: next,
      message: `Send window ${next.window_start_hour_pt}–${next.window_end_hour_pt} PT (enforce=${next.enforce_send_window}).`,
    },
  };
}

export async function handleOutreachAnalytics(
  isAdmin: boolean,
  env: LeadQueueEnv & SendControlsEnv & DailyCapEnv = process.env,
): Promise<CrmJsonResult> {
  const denied = adminOk(isAdmin);
  if (denied) return denied;
  const [built, queue, controls, cap, dailyDash, followUps, interested] = await Promise.all([
    buildLeadQueue({}, env),
    readSendQueue(env),
    readSendControls(env),
    readDailyCapState(env),
    getDaily20Dashboard(env, { refresh: false }).catch(() => null),
    listFollowUpDrafts(env),
    listInterestedNotify(env),
  ]);

  const hasData =
    built.items.length > 0 ||
    built.excluded.length > 0 ||
    queue.length > 0 ||
    controls.submitted_count > 0 ||
    Boolean(dailyDash?.cohort.qualified.length);

  if (!hasData) {
    return {
      status: 200,
      body: {
        ok: true,
        metrics_trusted: false,
        metrics: null,
        empty: true,
        message: 'No outreach data yet — KPIs stay empty (never fake zeros).',
      },
    };
  }

  const byStatus: Record<string, number> = {};
  for (const item of [...built.items, ...built.excluded]) {
    byStatus[item.outreach_status] = (byStatus[item.outreach_status] || 0) + 1;
  }
  for (const item of queue) {
    byStatus[item.outreach_status] = (byStatus[item.outreach_status] || 0) + 1;
  }

  await maybeSuggestCapRaise(
    {
      total_sends: controls.submitted_count,
      bounces: controls.bounce_count,
      complaints: controls.complaint_count,
    },
    env,
  );
  const capFresh = await readDailyCapState(env);

  const submitted = queue.filter((i) => i.status === 'submitted');
  const failed = queue.filter((i) => i.status === 'failed');
  const positive = interested.filter((i) => !i.acknowledged).length;
  const booked = [...built.items, ...built.excluded].filter((i) => i.outreach_status === 'booked').length;
  const won = [...built.items, ...built.excluded].filter((i) => i.outreach_status === 'won').length;
  const replies = [...built.items, ...built.excluded].filter(
    (i) => i.outreach_status === 'replied' || i.outreach_status === 'interested',
  ).length;

  return {
    status: 200,
    body: {
      ok: true,
      metrics_trusted: true,
      empty: false,
      metrics: {
        discovered: dailyDash?.cohort.discovered_count ?? built.items.length + built.excluded.length,
        qualified: dailyDash?.cohort.qualified.length ?? 0,
        approved: dailyDash?.drafts_approved ?? built.items.filter((i) => i.queue_status === 'approved').length,
        sent: submitted.length || controls.submitted_count,
        failures: failed.length,
        replies,
        positive,
        booked,
        won,
        queue_eligible: built.items.length,
        queue_excluded: built.excluded.length,
        pending_send: queue.filter((i) => i.status === 'pending').length,
        bounced: controls.bounce_count,
        complaints: controls.complaint_count,
        follow_up_drafts: followUps.filter((d) => d.status === 'draft').length,
        by_outreach_status: byStatus,
      },
      daily_cap: {
        state: capFresh,
        effective_cap: effectiveCap(capFresh),
        remaining: remainingSends(capFresh),
        suggestion_auto_applies: false,
      },
      controls: {
        paused: controls.paused,
        auto_paused: controls.auto_paused,
        paused_reason: controls.paused_reason,
        send_window: `${controls.window_start_hour_pt ?? 9}–${controls.window_end_hour_pt ?? 11} PT`,
      },
    },
  };
}
