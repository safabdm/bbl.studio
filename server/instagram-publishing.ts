import { readWithRetry } from './growth-monitor.js';

export type InstagramPublishingEnv = {
  INSTAGRAM_ACCESS_TOKEN?: string;
  INSTAGRAM_ACCOUNT_ID?: string;
  INSTAGRAM_LOGIN_MODE?: string;
  META_GRAPH_VERSION?: string;
};

/** Tokens from Unified Login belong to Facebook Graph, not Instagram Login. */
export function instagramPublishingApi(env: InstagramPublishingEnv) {
  const mode = env.INSTAGRAM_LOGIN_MODE || 'instagram';
  if (mode !== 'unified' && mode !== 'instagram')
    throw new Error('Unsupported Instagram login mode.');
  const version =
    env.META_GRAPH_VERSION || (mode === 'unified' ? 'v27.0' : 'v24.0');
  if (!/^v[1-9]\d?\.0$/.test(version))
    throw new Error('Invalid Meta Graph version.');
  return `https://${mode === 'unified' ? 'graph.facebook.com' : 'graph.instagram.com'}/${version}`;
}

export type InstagramPublishingPreflight = {
  status: 'verified' | 'unavailable';
  at: string;
  reason?: string;
  api?: string;
  account?: { id: string; username: 'businessbrandlab' };
  quotaUsage?: number;
  quotaTotal?: number | null;
  requests: number;
  published: 0;
  queued: 0;
};

async function boundedJson(
  response: Response,
): Promise<Record<string, unknown>> {
  if (!response.ok || !response.body) throw new Error('provider_read_failed');
  const reader = response.body.getReader();
  let size = 0;
  let text = '';
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 65536) throw new Error('provider_response_too_large');
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    await reader.cancel();
  }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid_provider_response');
  return value as Record<string, unknown>;
}

/** GET-only capability check: never creates containers, queues, or publications.
 * A quota response proves the provider accepted this read, not a successful publish.
 * No provider error, credential or account list is returned to the dashboard. */
export async function preflightInstagramPublishing(
  env: InstagramPublishingEnv,
  io: typeof fetch = fetch,
  now = Date.now(),
): Promise<InstagramPublishingPreflight> {
  const result: InstagramPublishingPreflight = {
    status: 'unavailable',
    at: new Date(now).toISOString(),
    requests: 0,
    published: 0,
    queued: 0,
  };
  const id = env.INSTAGRAM_ACCOUNT_ID;
  if (!env.INSTAGRAM_ACCESS_TOKEN || !id || !/^\d+$/.test(id))
    return { ...result, reason: 'credentials_missing' };
  try {
    const api = instagramPublishingApi(env);
    result.api = api;
    const get = async (path: string) =>
      boundedJson(
        await readWithRetry(
          `${api}/${path}`,
          {
            method: 'GET',
            redirect: 'error',
            headers: { Authorization: `Bearer ${env.INSTAGRAM_ACCESS_TOKEN}` },
          },
          async (url, init) => {
            result.requests++;
            return io(url, init);
          },
        ),
      );
    const account = await get(`${id}?fields=id,username`);
    if (account.id !== id || account.username !== 'businessbrandlab')
      return { ...result, reason: 'identity_mismatch' };
    const quota = await get(
      `${id}/content_publishing_limit?fields=quota_usage,config`,
    );
    const entries = quota.data;
    if (!Array.isArray(entries) || entries.length !== 1)
      return { ...result, reason: 'invalid_quota_response' };
    const entry: unknown = entries[0];
    if (!entry || typeof entry !== 'object')
      return { ...result, reason: 'invalid_quota_response' };
    const { quota_usage: usage, config } = entry as Record<string, unknown>;
    if (typeof usage !== 'number' || !Number.isSafeInteger(usage) || usage < 0)
      return { ...result, reason: 'invalid_quota_response' };
    const total =
      config && typeof config === 'object'
        ? (config as Record<string, unknown>).quota_total
        : null;
    if (
      total !== null &&
      total !== undefined &&
      (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0)
    )
      return { ...result, reason: 'invalid_quota_response' };
    return {
      ...result,
      status: 'verified',
      account: { id, username: 'businessbrandlab' },
      quotaUsage: usage,
      quotaTotal: typeof total === 'number' ? total : null,
    };
  } catch {
    return {
      ...result,
      reason: 'provider_read_failed_or_invalid_configuration',
    };
  }
}
