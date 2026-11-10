import { dbReadKv, dbWriteKv, type CrmDbEnv } from './crm-db.js';
import { readWithRetry } from './growth-monitor.js';

export type InstagramReadEnv = CrmDbEnv & {
  INSTAGRAM_READ_ENABLED?: string;
  INSTAGRAM_READ_ACCESS_TOKEN?: string;
  INSTAGRAM_READ_ACCOUNT_ID?: string;
};
export const INSTAGRAM_READ_KEY = 'growth:instagram-read:v1';
export type InstagramReadSnapshot = {
  at: string;
  status: 'verified' | 'unavailable';
  reason?: string;
  profile?: { id: string; username: string };
  media?: Array<{ id: string; media_type: string; timestamp: string }>;
};
export const readInstagramSnapshot = (env: InstagramReadEnv) =>
  dbReadKv<InstagramReadSnapshot | null>(INSTAGRAM_READ_KEY, null, env);

/** Unified Login system-user token. Fixed Meta origin, GET only, separate from publishing. */
export async function runInstagramRead(
  env: InstagramReadEnv,
  io: typeof fetch = fetch,
  now = Date.now(),
): Promise<InstagramReadSnapshot> {
  const snapshot: InstagramReadSnapshot = {
    at: new Date(now).toISOString(),
    status: 'unavailable',
  };
  const account = env.INSTAGRAM_READ_ACCOUNT_ID;
  if (env.INSTAGRAM_READ_ENABLED !== 'true') snapshot.reason = 'disabled';
  else if (
    !env.INSTAGRAM_READ_ACCESS_TOKEN ||
    !account ||
    !/^\d+$/.test(account)
  )
    snapshot.reason = 'credentials_missing';
  else {
    try {
      const get = async (path: string): Promise<Record<string, unknown>> => {
        const response = await readWithRetry(
          `https://graph.facebook.com/v27.0/${path}`,
          {
            method: 'GET',
            redirect: 'error',
            headers: {
              Authorization: `Bearer ${env.INSTAGRAM_READ_ACCESS_TOKEN}`,
            },
          },
          io,
        );
        if (!response.ok) throw new Error('provider_read_failed');
        if (!response.body) throw new Error('empty_response');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let text = '';
        let bytes = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > 100000) throw new Error('response_too_large');
            text += decoder.decode(chunk.value, { stream: true });
          }
          text += decoder.decode();
        } finally {
          await reader.cancel();
        }
        return JSON.parse(text) as Record<string, unknown>;
      };
      const profile = await get(`${account}?fields=id,username`);
      if (profile.id !== account || profile.username !== 'businessbrandlab')
        throw new Error('identity_mismatch');
      const media = await get(
        `${account}/media?fields=id,media_type,timestamp&limit=10`,
      );
      if (!Array.isArray(media.data) || media.data.length > 10)
        throw new Error('invalid_media');
      snapshot.media = media.data.map((item: Record<string, unknown>) => {
        if (
          !/^\d+$/.test(String(item.id)) ||
          !['IMAGE', 'VIDEO', 'CAROUSEL_ALBUM'].includes(
            String(item.media_type),
          ) ||
          !Number.isFinite(Date.parse(String(item.timestamp)))
        )
          throw new Error('invalid_media');
        return {
          id: String(item.id),
          media_type: String(item.media_type),
          timestamp: String(item.timestamp),
        };
      });
      snapshot.profile = { id: account, username: 'businessbrandlab' };
      snapshot.status = 'verified';
    } catch {
      snapshot.reason = 'provider_read_failed_or_identity_mismatch';
      delete snapshot.profile;
      delete snapshot.media;
    }
  }
  await dbWriteKv(INSTAGRAM_READ_KEY, snapshot, env);
  return snapshot;
}
