import { createHash } from 'node:crypto';
import {
  acquireCrmLease,
  releaseCrmLease,
  dbReadKv,
  dbWriteKv,
  type CrmDbEnv,
} from './crm-db.js';

export type SocialEnv = CrmDbEnv & {
  SOCIAL_PUBLISH_ENABLED?: string;
  SOCIAL_QUEUE_RECONCILED_AT?: string;
  INSTAGRAM_ACCESS_TOKEN?: string;
  INSTAGRAM_ACCOUNT_ID?: string;
  META_GRAPH_VERSION?: string;
  LINKEDIN_ACCESS_TOKEN?: string;
  LINKEDIN_AUTHOR_URN?: string;
  LINKEDIN_VERSION?: string;
  SOCIAL_MEDIA_HOSTS?: string;
};
export type SocialPost = {
  id: string;
  network: 'instagram' | 'linkedin';
  caption: string;
  mediaUrl?: string;
  linkedInVideoUrn?: string;
  authorUrn?: string;
  mediaSha256?: string;
  scheduledAt: string;
  createdAt: string;
  repeatAt?: string[];
  receipts?: Array<{ id: string; scheduledAt: string; recordedAt: string }>;
  status: 'review' | 'approved' | 'processing' | 'published' | 'uncertain';
  approval?: { digest: string; at: string; reviewer: string; qa: string };
  containerId?: string;
  providerId?: string;
  error?: string;
};
export const SOCIAL_QUEUE = 'growth:social:v1';
export async function readSocialQueue(env: SocialEnv) {
  return dbReadKv<SocialPost[]>(SOCIAL_QUEUE, [], env);
}
export function socialDigest(
  post: Pick<
    SocialPost,
    | 'network'
    | 'caption'
    | 'mediaSha256'
    | 'mediaUrl'
    | 'linkedInVideoUrn'
    | 'authorUrn'
    | 'scheduledAt'
    | 'repeatAt'
  >,
) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        post.network,
        post.caption,
        post.mediaSha256,
        post.mediaUrl,
        post.linkedInVideoUrn,
        post.authorUrn,
        post.scheduledAt,
        post.repeatAt,
      ]),
    )
    .digest('hex');
}
function contentKey(post: SocialPost) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        post.network,
        post.caption.trim().replace(/\s+/g, ' '),
        post.mediaSha256 || post.mediaUrl || post.linkedInVideoUrn,
      ]),
    )
    .digest('hex');
}

/** Read only trusted immutable media URLs, without any social-provider credentials. */
export async function verifySocialMedia(
  post: SocialPost,
  env: SocialEnv,
  io: typeof fetch,
) {
  const url = new URL(post.mediaUrl || '');
  const hosts = (env.SOCIAL_MEDIA_HOSTS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    !hosts.includes(url.hostname.toLowerCase())
  )
    throw new Error('Media requires an explicitly trusted HTTPS storage host.');
  const response = await io(url.href, {
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  if (
    !response.ok ||
    !response.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('video/mp4') ||
    !response.body
  )
    throw new Error('Approved MP4 is unavailable.');
  const maxBytes = 64 * 1024 * 1024;
  if (Number(response.headers.get('content-length') || 0) > maxBytes)
    throw new Error('Approved MP4 exceeds 64 MiB render limit.');
  const reader = response.body.getReader();
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > maxBytes)
        throw new Error('Approved MP4 exceeds 64 MiB render limit.');
      hash.update(chunk.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  if (!bytes || hash.digest('hex') !== post.mediaSha256)
    throw new Error(
      'Media checksum differs from the exact owner-approved render.',
    );
}
export async function saveSocialPost(
  input: SocialPost,
  env: SocialEnv,
  approval?: { reviewer: string; qa: string; digest: string },
) {
  if (
    !input ||
    typeof input !== 'object' ||
    typeof input.id !== 'string' ||
    !/^[A-Za-z0-9_-]{1,120}$/.test(input.id)
  )
    throw new Error('A stable social queue ID is required.');
  if (
    !['instagram', 'linkedin'].includes(input.network) ||
    typeof input.caption !== 'string' ||
    !input.caption.trim() ||
    input.caption.length > 2200 ||
    !Number.isFinite(Date.parse(input.scheduledAt))
  )
    throw new Error(
      'Valid network, caption and ISO schedule with offset required.',
    );
  if (!/T.*(Z|[+-]\d\d:\d\d)$/.test(input.scheduledAt))
    throw new Error(
      'Schedule must include a UTC offset; ambiguous Pacific wall times are rejected.',
    );
  if (
    input.repeatAt !== undefined &&
    (!Array.isArray(input.repeatAt) ||
      input.repeatAt.length > 11 ||
      input.repeatAt.some(
        (at, i) =>
          typeof at !== 'string' ||
          !/T.*(Z|[+-]\d\d:\d\d)$/.test(at) ||
          !Number.isFinite(Date.parse(at)) ||
          Date.parse(at) -
            Date.parse(i ? input.repeatAt![i - 1]! : input.scheduledAt) <
            86400000,
      ))
  )
    throw new Error(
      'Recurring approval requires up to 11 exact future timestamps, at least one day apart, with UTC offsets.',
    );
  if (
    input.network === 'instagram' &&
    (!input.mediaUrl?.startsWith('https://') ||
      !/^[a-f0-9]{64}$/.test(input.mediaSha256 || ''))
  )
    throw new Error('Instagram requires a rendered HTTPS video and SHA-256.');
  if (
    input.linkedInVideoUrn &&
    !/^urn:li:video:[A-Za-z0-9_-]+$/.test(input.linkedInVideoUrn)
  )
    throw new Error('Invalid LinkedIn video URN.');
  const lease = await acquireCrmLease(SOCIAL_QUEUE, env);
  if (!lease) throw new Error('Social queue busy; retry.');
  try {
    const queue = await readSocialQueue(env);
    const existing = queue.find((p) => p.id === input.id);
    if (
      existing &&
      (existing.receipts?.length ||
        ['processing', 'published', 'uncertain'].includes(existing.status))
    )
      throw new Error(
        'Published or claimed posts are immutable; reconcile uncertain outcomes with the provider.',
      );
    if (
      queue.some(
        (p) => p.id !== input.id && contentKey(p) === contentKey(input),
      )
    )
      throw new Error('Duplicate content already queued or published.');
    const next: SocialPost = {
      id: input.id,
      network: input.network,
      caption: input.caption.trim(),
      mediaUrl: input.mediaUrl,
      mediaSha256: input.mediaSha256,
      linkedInVideoUrn: input.linkedInVideoUrn,
      authorUrn: input.authorUrn,
      scheduledAt: input.scheduledAt,
      repeatAt: input.repeatAt,
      createdAt: existing?.createdAt || new Date().toISOString(),
      status: 'review',
    };
    if (approval) {
      if (
        next.network === 'linkedin' &&
        !/^urn:li:(organization|person):[A-Za-z0-9_-]+$/.test(
          next.authorUrn || '',
        )
      )
        throw new Error('Approve the exact LinkedIn author/account URN.');
      if (
        !approval.reviewer ||
        !approval.qa?.trim() ||
        approval.digest !== socialDigest(next)
      )
        throw new Error(
          'Review the exact caption, rendered motion, rights, brand safety, media checksum and schedule before approval.',
        );
      next.approval = { ...approval, at: new Date().toISOString() };
      next.status = 'approved';
    }
    await dbWriteKv(
      SOCIAL_QUEUE,
      [...queue.filter((p) => p.id !== next.id), next],
      env,
    );
    return next;
  } finally {
    await releaseCrmLease(SOCIAL_QUEUE, lease, env);
  }
}

/** Called only by the authenticated cloud worker. Claims precede provider mutations.
 * Failed GET polling is retryable. An uncertain POST is never automatically repeated. */
export async function publishNextSocial(
  env: SocialEnv,
  io: typeof fetch = fetch,
  now = Date.now(),
) {
  if (env.SOCIAL_PUBLISH_ENABLED !== 'true')
    return { status: 'disabled', published: 0 };
  const reconciled = Date.parse(env.SOCIAL_QUEUE_RECONCILED_AT || '');
  if (!Number.isFinite(reconciled) || reconciled > now)
    return { status: 'reconciliation_required', published: 0 };
  const lease = await acquireCrmLease(SOCIAL_QUEUE, env);
  if (!lease) return { status: 'busy', published: 0 };
  try {
    const queue = await readSocialQueue(env);
    const dueAt = (p: SocialPost) =>
      [p.scheduledAt, ...(p.repeatAt || [])][p.receipts?.length || 0];
    const post = queue.find(
      (p) =>
        ['approved', 'processing'].includes(p.status) &&
        Date.parse(dueAt(p) || '') <= now,
    );
    if (!post) return { status: 'idle', published: 0 };
    if (!post.approval || post.approval.digest !== socialDigest(post))
      throw new Error('Approval invalidated by content or schedule change.');
    if (
      post.network === 'linkedin' &&
      post.authorUrn !== env.LINKEDIN_AUTHOR_URN
    )
      throw new Error(
        'LinkedIn destination differs from the owner-approved account.',
      );
    const meta = `https://graph.instagram.com/${env.META_GRAPH_VERSION || 'v24.0'}`;
    const token =
      post.network === 'instagram'
        ? env.INSTAGRAM_ACCESS_TOKEN
        : env.LINKEDIN_ACCESS_TOKEN;
    if (
      !token ||
      (post.network === 'instagram'
        ? !/^\d+$/.test(env.INSTAGRAM_ACCOUNT_ID || '')
        : !/^urn:li:(organization|person):[A-Za-z0-9_-]+$/.test(
            env.LINKEDIN_AUTHOR_URN || '',
          ))
    )
      return { status: 'credentials_missing', published: 0 };
    const headers = { Authorization: `Bearer ${token}` };
    const request = (url: string, init?: RequestInit) => {
      const combined = new Headers(init?.headers);
      combined.set('Authorization', headers.Authorization);
      return io(url, {
        ...init,
        headers: combined,
        signal: AbortSignal.timeout(10000),
      });
    };
    if (post.network === 'instagram') {
      const identity = await request(
        `${meta}/${env.INSTAGRAM_ACCOUNT_ID}?fields=username`,
      );
      if (
        !identity.ok ||
        ((await identity.json()) as { username?: string }).username !==
          'businessbrandlab'
      )
        throw new Error('Instagram identity must be businessbrandlab.');
      if (post.containerId) {
        const ready = await request(
          `${meta}/${post.containerId}?fields=status_code`,
        );
        if (!ready.ok) return { status: 'poll_retry', published: 0 };
        const result = (await ready.json()) as { status_code?: string };
        if (result.status_code === 'IN_PROGRESS')
          return { status: 'processing', published: 0 };
        if (result.status_code !== 'FINISHED') {
          post.status = 'uncertain';
          post.error = 'Container needs provider review.';
          await dbWriteKv(SOCIAL_QUEUE, queue, env);
          return { status: post.status, published: 0 };
        }
      }
    }
    if (post.network === 'instagram' && !post.containerId)
      await verifySocialMedia(post, env, io);
    // This durable barrier also holds a worker crash between request and receipt.
    post.status = 'uncertain';
    post.error =
      'Provider outcome requires reconciliation if no receipt is stored.';
    await dbWriteKv(SOCIAL_QUEUE, queue, env);
    try {
      if (post.network === 'instagram' && !post.containerId) {
        const response = await request(
          `${meta}/${env.INSTAGRAM_ACCOUNT_ID}/media`,
          {
            method: 'POST',
            body: new URLSearchParams({
              media_type: 'REELS',
              video_url: post.mediaUrl!,
              caption: post.caption,
            }),
          },
        );
        const body = (await response.json()) as { id?: string };
        if (!response.ok || !body.id)
          throw new Error('Container creation failed.');
        post.containerId = body.id;
        post.status = 'processing';
        delete post.error;
      } else {
        const response =
          post.network === 'instagram'
            ? await request(
                `${meta}/${env.INSTAGRAM_ACCOUNT_ID}/media_publish`,
                {
                  method: 'POST',
                  body: new URLSearchParams({ creation_id: post.containerId! }),
                },
              )
            : await request('https://api.linkedin.com/rest/posts', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Linkedin-Version': env.LINKEDIN_VERSION || '202609',
                  'X-Restli-Protocol-Version': '2.0.0',
                },
                body: JSON.stringify({
                  author: env.LINKEDIN_AUTHOR_URN,
                  commentary: post.caption,
                  visibility: 'PUBLIC',
                  distribution: {
                    feedDistribution: 'MAIN_FEED',
                    targetEntities: [],
                    thirdPartyDistributionChannels: [],
                  },
                  lifecycleState: 'PUBLISHED',
                  isReshareDisabledByAuthor: false,
                  ...(post.linkedInVideoUrn
                    ? { content: { media: { id: post.linkedInVideoUrn } } }
                    : {}),
                }),
              });
        const body =
          post.network === 'instagram'
            ? ((await response.json()) as { id?: string })
            : null;
        const id = body?.id || response.headers.get('x-restli-id');
        if (!response.ok || !id)
          throw new Error('Publication outcome unavailable.');
        post.providerId = id;
        post.status = 'published';
        delete post.error;
        post.receipts ||= [];
        post.receipts.push({
          id,
          scheduledAt: dueAt(post)!,
          recordedAt: new Date(now).toISOString(),
        });
      }
    } catch {
      /* Keep uncertain; operator reconciles before any retry. */
    }
    const published = post.status === 'published' ? 1 : 0;
    if (
      published &&
      (post.receipts?.length || 0) < 1 + (post.repeatAt?.length || 0)
    ) {
      post.status = 'approved';
      delete post.containerId;
      delete post.providerId;
    }
    await dbWriteKv(SOCIAL_QUEUE, queue, env);
    return { status: post.status, published };
  } finally {
    await releaseCrmLease(SOCIAL_QUEUE, lease, env);
  }
}
