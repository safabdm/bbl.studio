/**
 * Microsoft Graph OAuth2 (auth-code) Mail.Send + Mail.Read.
 * Tokens encrypted in Neon. Owner picks Graph vs Resend as active sender.
 * No Mail.app path. Dev/tests: mocked fetch only — never real send.
 */
import { createHash, randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret } from './crypto.js';
import { dbReadKv, dbWriteKv, type CrmDbEnv } from './crm-db.js';
import type { SendQueueItem } from './send-controls.js';
import type { CrmInboxItem } from './crm-types.js';

export const GRAPH_TOKEN_KV = 'outreach:graph_tokens';
export const SENDER_PREF_KV = 'outreach:active_sender';

export type ActiveSender = 'graph' | 'resend' | 'none';

export type GraphTokenRecord = {
  access_token_enc: string;
  refresh_token_enc: string | null;
  expires_at: string;
  account_email: string | null;
  connected_at: string;
  scopes: string[];
};

export type GraphSenderEnv = CrmDbEnv & {
  MICROSOFT_GRAPH_CLIENT_ID?: string;
  MICROSOFT_GRAPH_CLIENT_SECRET?: string;
  MICROSOFT_GRAPH_TENANT_ID?: string;
  MICROSOFT_GRAPH_REDIRECT_URI?: string;
  SESSION_SECRET?: string;
  APP_ORIGIN?: string;
  VERCEL?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
};

function resolveAppOrigin(env: GraphSenderEnv): string {
  return String(env.APP_ORIGIN || (env.VERCEL ? 'https://www.bbl.studio' : 'http://127.0.0.1:4173')).replace(
    /\/$/,
    '',
  );
}

const GRAPH_SCOPES = ['Mail.Send', 'Mail.Read', 'offline_access', 'openid', 'profile', 'email'];

function nowIso(ms = Date.now()): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function graphConfigured(env: GraphSenderEnv = process.env): boolean {
  return Boolean(
    String(env.MICROSOFT_GRAPH_CLIENT_ID || '').trim() &&
      String(env.MICROSOFT_GRAPH_CLIENT_SECRET || '').trim() &&
      String(env.MICROSOFT_GRAPH_TENANT_ID || '').trim(),
  );
}

export function graphRedirectUri(env: GraphSenderEnv = process.env): string {
  const explicit = String(env.MICROSOFT_GRAPH_REDIRECT_URI || '').trim();
  if (explicit) return explicit;
  return `${resolveAppOrigin(env)}/api/admin/crm/outlook/callback`;
}

export function buildGraphAuthUrl(
  state: string,
  env: GraphSenderEnv = process.env,
): { ok: true; url: string } | { ok: false; message: string } {
  if (!graphConfigured(env)) {
    return {
      ok: false,
      message:
        'Microsoft Graph not configured. Set MICROSOFT_GRAPH_CLIENT_ID, MICROSOFT_GRAPH_CLIENT_SECRET, MICROSOFT_GRAPH_TENANT_ID (and redirect URI).',
    };
  }
  const tenant = String(env.MICROSOFT_GRAPH_TENANT_ID).trim();
  const params = new URLSearchParams({
    client_id: String(env.MICROSOFT_GRAPH_CLIENT_ID).trim(),
    response_type: 'code',
    redirect_uri: graphRedirectUri(env),
    response_mode: 'query',
    scope: GRAPH_SCOPES.join(' '),
    state,
  });
  return {
    ok: true,
    url: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize?${params}`,
  };
}

export function createOauthState(): string {
  return randomBytes(16).toString('hex');
}

export async function readGraphTokens(env: GraphSenderEnv = process.env): Promise<GraphTokenRecord | null> {
  const raw = await dbReadKv<GraphTokenRecord | null>(GRAPH_TOKEN_KV, null, env);
  return raw && raw.access_token_enc ? raw : null;
}

export async function saveGraphTokens(
  tokens: {
    access_token: string;
    refresh_token?: string | null;
    expires_in?: number;
    account_email?: string | null;
  },
  env: GraphSenderEnv = process.env,
): Promise<GraphTokenRecord> {
  const expiresAt = nowIso(Date.now() + Math.max(60, Number(tokens.expires_in) || 3600) * 1000);
  const record: GraphTokenRecord = {
    access_token_enc: encryptSecret(tokens.access_token),
    refresh_token_enc: tokens.refresh_token ? encryptSecret(tokens.refresh_token) : null,
    expires_at: expiresAt,
    account_email: tokens.account_email || null,
    connected_at: nowIso(),
    scopes: GRAPH_SCOPES,
  };
  await dbWriteKv(GRAPH_TOKEN_KV, record, env);
  return record;
}

export async function clearGraphTokens(env: GraphSenderEnv = process.env): Promise<void> {
  await dbWriteKv(GRAPH_TOKEN_KV, null, env);
}

export async function getActiveSender(env: GraphSenderEnv = process.env): Promise<ActiveSender> {
  const raw = await dbReadKv<ActiveSender | null>(SENDER_PREF_KV, null, env);
  if (raw === 'graph' || raw === 'resend' || raw === 'none') return raw;
  return 'none';
}

export async function setActiveSender(
  sender: ActiveSender,
  env: GraphSenderEnv = process.env,
): Promise<ActiveSender> {
  await dbWriteKv(SENDER_PREF_KV, sender, env);
  return sender;
}

export type TokenExchangeResult =
  | { ok: true; access_token: string; refresh_token?: string; expires_in?: number }
  | { ok: false; message: string };

/** Exchange auth code — inject fetchImpl in tests (never hit network in CI). */
export async function exchangeGraphAuthCode(
  code: string,
  env: GraphSenderEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenExchangeResult> {
  if (!graphConfigured(env)) {
    return { ok: false, message: 'Graph app credentials not configured.' };
  }
  const tenant = String(env.MICROSOFT_GRAPH_TENANT_ID).trim();
  const body = new URLSearchParams({
    client_id: String(env.MICROSOFT_GRAPH_CLIENT_ID).trim(),
    client_secret: String(env.MICROSOFT_GRAPH_CLIENT_SECRET).trim(),
    grant_type: 'authorization_code',
    code,
    redirect_uri: graphRedirectUri(env),
    scope: GRAPH_SCOPES.join(' '),
  });
  try {
    const res = await fetchImpl(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok || !json.access_token) {
      return {
        ok: false,
        message: String(json.error_description || json.error || `Token exchange failed (${res.status})`),
      };
    }
    return {
      ok: true,
      access_token: String(json.access_token),
      refresh_token: json.refresh_token ? String(json.refresh_token) : undefined,
      expires_in: Number(json.expires_in) || 3600,
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Token exchange failed.' };
  }
}

export async function resolveAccessToken(
  env: GraphSenderEnv = process.env,
): Promise<{ ok: true; token: string } | { ok: false; message: string }> {
  const record = await readGraphTokens(env);
  if (!record) return { ok: false, message: 'Outlook not connected.' };
  const token = decryptSecret(record.access_token_enc);
  if (!token) return { ok: false, message: 'Stored Graph token could not be decrypted.' };
  return { ok: true, token };
}

export type GraphSendResult =
  | { ok: true; provider_message_id: string }
  | { ok: false; message: string };

/**
 * Send via Graph. Always pass fetchImpl in tests.
 * Idempotency via client extension key when provided.
 */
export async function sendViaGraph(
  item: Pick<SendQueueItem, 'email' | 'subject' | 'body' | 'attempt_token'>,
  env: GraphSenderEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<GraphSendResult> {
  const access = await resolveAccessToken(env);
  if (!access.ok) return { ok: false, message: access.message };

  const idempotency = createHash('sha256')
    .update(`${item.attempt_token}:${item.email}`)
    .digest('hex')
    .slice(0, 32);

  try {
    const res = await fetchImpl('https://graph.microsoft.com/v1.0/me/sendMail', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${access.token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotency,
      },
      body: JSON.stringify({
        message: {
          subject: item.subject,
          body: { contentType: 'Text', content: item.body },
          toRecipients: [{ emailAddress: { address: item.email } }],
        },
        saveToSentItems: true,
      }),
    });
    if (res.status === 202 || res.ok) {
      return { ok: true, provider_message_id: `graph_${idempotency}` };
    }
    const text = await res.text();
    return { ok: false, message: `Graph send failed (${res.status}): ${text.slice(0, 200)}` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Graph send failed.' };
  }
}

export type GraphMessage = {
  id: string;
  conversationId?: string;
  subject?: string;
  bodyPreview?: string;
  receivedDateTime?: string;
  from?: { emailAddress?: { address?: string } };
  internetMessageHeaders?: Array<{ name: string; value: string }>;
};

/**
 * Import replies via Mail.Read. Match conversationId / In-Reply-To / from email.
 */
export async function importGraphReplies(
  opts: {
    known_emails?: Set<string>;
    known_conversation_ids?: Set<string>;
  } = {},
  env: GraphSenderEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; items: CrmInboxItem[]; marked_replied: string[] } | { ok: false; message: string }> {
  const access = await resolveAccessToken(env);
  if (!access.ok) return { ok: false, message: access.message };

  try {
    const res = await fetchImpl(
      'https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages?$top=50&$select=id,conversationId,subject,bodyPreview,receivedDateTime,from,internetMessageHeaders',
      {
        headers: { Authorization: `Bearer ${access.token}` },
      },
    );
    if (!res.ok) {
      return { ok: false, message: `Graph mail read failed (${res.status}).` };
    }
    const json = (await res.json()) as { value?: GraphMessage[] };
    const messages = Array.isArray(json.value) ? json.value : [];
    const items: CrmInboxItem[] = [];
    const marked: string[] = [];

    for (const msg of messages) {
      const from = String(msg.from?.emailAddress?.address || '')
        .trim()
        .toLowerCase();
      const inReplyTo = (msg.internetMessageHeaders || []).find(
        (h) => h.name.toLowerCase() === 'in-reply-to',
      )?.value;
      const conv = msg.conversationId || '';
      const matchEmail = from && opts.known_emails?.has(from);
      const matchConv = conv && opts.known_conversation_ids?.has(conv);
      const matchReply = Boolean(inReplyTo);
      if (!matchEmail && !matchConv && !matchReply) continue;

      items.push({
        id: `graph_${msg.id}`,
        from_email: from,
        subject: msg.subject || null,
        snippet: msg.bodyPreview || null,
        received_at: msg.receivedDateTime || null,
        source: 'gmail', // closest existing enum; Graph import
      });
      if (from) marked.push(from);
    }
    return { ok: true, items, marked_replied: [...new Set(marked)] };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Graph import failed.' };
  }
}

export async function senderSettingsSnapshot(env: GraphSenderEnv = process.env) {
  const tokens = await readGraphTokens(env);
  const active = await getActiveSender(env);
  return {
    active_sender: active,
    graph: {
      configured: graphConfigured(env),
      connected: Boolean(tokens),
      account_email: tokens?.account_email || null,
      connected_at: tokens?.connected_at || null,
      redirect_uri: graphRedirectUri(env),
      scopes: GRAPH_SCOPES,
    },
    resend: {
      configured: Boolean(String(env.RESEND_API_KEY || '').trim()),
      from: String(env.RESEND_FROM || 'BBL Studio <hello@bbl.studio>'),
    },
    mail_app_path: false,
    live_send_default: false,
  };
}
