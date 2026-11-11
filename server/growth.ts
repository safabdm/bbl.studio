import { createHash } from 'node:crypto';
import { growthOpportunities } from './growth-opportunities.js';
import {
  acquireCrmLease,
  releaseCrmLease,
  dbReadKv,
  dbWriteKv,
} from './crm-db.js';
import { readSnapshot } from './crm-sync-store.js';
import { countDiscoveredLeads } from './crm-discovery-store.js';
import { readDaily20Cohort } from './daily-20-pipeline.js';
import { listStudioDrafts } from './email-studio.js';
import {
  readMarketingState,
  runMarketingTick,
  type MarketingEnv,
} from './marketing-automation.js';
import {
  readSchedulerState,
  SCHEDULER_RUNS_KV,
  type SchedulerJobResult,
} from './daily-outreach-scheduler.js';
import {
  readSocialQueue,
  publishNextSocial,
  type SocialEnv,
} from './growth-social.js';
import {
  readGrowthMonitor,
  runGrowthMonitor,
  type MonitorEnv,
} from './growth-monitor.js';
import { pacificParts } from './pacific-time.js';
import {
  readInstagramSnapshot,
  runInstagramRead,
  type InstagramReadEnv,
} from './instagram-read.js';
import {
  planMarketingReply,
  type MarketingMessage,
} from './marketing-conversation.js';

export type GrowthEnv = MarketingEnv &
  InstagramReadEnv &
  SocialEnv &
  MonitorEnv & { GROWTH_MONITOR_ENABLED?: string };
export type SalesRecord = {
  email: string;
  stage:
    | 'qualified'
    | 'interested'
    | 'consultation'
    | 'proposal'
    | 'won'
    | 'lost';
  requirements: string;
  evidence: string;
  updatedAt: string;
  proposal?: string;
};
export type GrowthLog = {
  at: string;
  agent: string;
  status: string;
  message: string;
};
export const SALES_KEY = 'growth:sales:v1';
export const LOG_KEY = 'growth:logs:v1';
export const SALES_REVIEW_KEY = 'growth:sales-reviews:v1';
export type SalesReview = ReturnType<typeof salesAssistant> & {
  messageId: string;
  email: string;
  receivedAt: string;
  evidence: string;
};

/** Suggestions never replace the owner's sales stage or confirmed commercial terms. */
export async function prepareSalesReviews(env: GrowthEnv) {
  const [marketing, sales] = await Promise.all([
    readMarketingState(env),
    dbReadKv<SalesRecord[]>(SALES_KEY, [], env),
  ]);
  const reviews: SalesReview[] = (marketing.inbound || [])
    .slice(0, 200)
    .map((message) => ({
      ...salesAssistant(
        message,
        sales.find((s) => s.email === message.email.trim().toLowerCase())
          ?.requirements || '',
      ),
      messageId: message.id,
      email: message.email,
      receivedAt: message.receivedAt,
      evidence: message.text,
    }));
  await dbWriteKv(SALES_REVIEW_KEY, reviews, env);
  return reviews;
}

export function salesAssistant(message: MarketingMessage, requirements = '') {
  const optout =
    /\b(unsubscribe|remove me|stop emailing|not interested)\b/i.test(
      message.text,
    );
  const interested =
    !optout &&
    /\b(interested|consultation|let.s talk|send.*(proposal|outline)|yes)\b/i.test(
      message.text,
    );
  return {
    classification: optout
      ? 'optout'
      : message.automated
        ? 'automated'
        : interested
          ? 'interested'
          : 'needs_review',
    response:
      message.automated || optout
        ? null
        : planMarketingReply(message)?.body ||
          'Thank you for getting in touch. Could you share your website, goals, required pages and functionality, and desired timeline?',
    bookingUrl: 'https://www.bbl.studio/booking',
    proposal: requirements.trim()
      ? `DRAFT — owner review required\nVerified requirements supplied by owner:\n${requirements.trim()}\n\nScope, deliverables, timeline, pricing, payment terms and contract require owner confirmation. No commitment has been made.`
      : null,
    approvalRequired: true,
    transmitted: 0,
  };
}

export async function saveSalesRecord(input: SalesRecord, env: GrowthEnv) {
  if (
    !input ||
    typeof input !== 'object' ||
    typeof input.email !== 'string' ||
    input.email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) ||
    ![
      'qualified',
      'interested',
      'consultation',
      'proposal',
      'won',
      'lost',
    ].includes(input.stage) ||
    typeof input.evidence !== 'string' ||
    !input.evidence.trim() ||
    input.evidence.length > 10000 ||
    typeof input.requirements !== 'string' ||
    input.requirements.length > 10000
  )
    throw new Error(
      'Valid lead, stage, verified requirements and owner evidence required.',
    );
  const lease = await acquireCrmLease(SALES_KEY, env);
  if (!lease) throw new Error('Sales pipeline busy; retry.');
  try {
    const records = await dbReadKv<SalesRecord[]>(SALES_KEY, [], env);
    const record: SalesRecord = {
      email: input.email.trim().toLowerCase(),
      stage: input.stage,
      requirements: input.requirements,
      evidence: input.evidence.trim(),
      updatedAt: new Date().toISOString(),
    };
    if (input.stage === 'proposal') {
      if (!record.requirements.trim())
        throw new Error(
          'Verified project requirements required before drafting a proposal.',
        );
      record.proposal = salesAssistant(
        {
          id: 'owner',
          email: record.email,
          subject: '',
          text: '',
          receivedAt: record.updatedAt,
          automated: false,
        },
        record.requirements,
      ).proposal!;
    }
    await dbWriteKv(
      SALES_KEY,
      [...records.filter((r) => r.email !== record.email), record],
      env,
    );
    return record;
  } finally {
    await releaseCrmLease(SALES_KEY, lease, env);
  }
}

/** Dashboard reads existing stores. Missing sources never become invented zero totals. */
export async function growthDashboard(env: GrowthEnv, now = Date.now()) {
  const sources = {
    snapshot: () => readSnapshot(env),
    discovery: () => countDiscoveredLeads(env),
    cohort: () => readDaily20Cohort(env),
    drafts: () => listStudioDrafts(env),
    marketing: () => readMarketingState(env),
    scheduler: () => readSchedulerState(env),
    runs: () => dbReadKv<SchedulerJobResult[]>(SCHEDULER_RUNS_KV, [], env),
    social: () => readSocialQueue(env),
    monitor: () => readGrowthMonitor(env),
    instagramRead: () => readInstagramSnapshot(env),
    sales: () => dbReadKv<SalesRecord[]>(SALES_KEY, [], env),
    salesReviews: () => dbReadKv<SalesReview[]>(SALES_REVIEW_KEY, [], env),
    logs: () => dbReadKv<GrowthLog[]>(LOG_KEY, [], env),
  };
  const entries = await Promise.all(
    Object.entries(sources).map(async ([key, read]) => {
      try {
        return [key, { status: 'available', data: await read() }] as const;
      } catch {
        return [key, { status: 'unavailable', data: null }] as const;
      }
    }),
  );
  const loaded = Object.fromEntries(entries);
  const get = <K extends keyof typeof sources>(key: K) =>
    loaded[key]?.data as Awaited<ReturnType<(typeof sources)[K]>> | null;
  const snapshot = get('snapshot'),
    marketing = get('marketing'),
    posts = get('social'),
    sales = get('sales');
  const receiptIds = new Set([
    ...(snapshot?.email_history || [])
      .filter(
        (h) => !h.dry_run && h.accepted === 'YES' && h.provider_message_id,
      )
      .map((h) => h.provider_message_id!),
    ...(marketing?.attempts || [])
      .filter((a) => a.status === 'SUBMITTED' && a.providerId)
      .map((a) => a.providerId!),
  ]);
  const scheduler = get('scheduler');
  const age = scheduler?.last_at
    ? now - Date.parse(scheduler.last_at)
    : Infinity;
  return {
    checkedAt: new Date(now).toISOString(),
    opportunities: growthOpportunities(get('monitor'), now),
    timezone: 'America/Los_Angeles',
    pacific: pacificParts(now),
    approvalOnly: true,
    sources: Object.fromEntries(entries),
    metrics: {
      discovered: get('discovery')?.total ?? null,
      qualifiedToday:
        get('cohort')?.day_key === pacificParts(now).dayKey
          ? get('cohort')!.qualified.length
          : null,
      outreachAwaitingApproval: get('drafts')
        ? get('drafts')!.filter((d) => !d.approved).length +
          (marketing?.drafts?.length || 0)
        : null,
      providerAccepted:
        snapshot || marketing?.attempts.length ? receiptIds.size : null,
      replies:
        snapshot || marketing?.inbound
          ? new Set([
              ...(snapshot?.inbox || []).map((i) => i.from_email.toLowerCase()),
              ...(marketing?.inbound || [])
                .filter((m) => !m.automated && m.threadMatched !== false)
                .map((m) => m.email.toLowerCase()),
            ]).size
          : null,
      consultations: snapshot
        ? snapshot.bookings.filter((b) => b.status === 'confirmed').length
        : null,
      proposals: sales
        ? sales.filter((s) => s.stage === 'proposal').length
        : null,
      closedDeals: sales ? sales.filter((s) => s.stage === 'won').length : null,
      contentCreated: posts?.length ?? null,
      contentPublished: posts
        ? posts.reduce(
            (n, p) =>
              n +
              (p.receipts?.length ||
                (p.status === 'published' && p.providerId ? 1 : 0)),
            0,
          )
        : null,
      instagramReach: null,
      instagramEngagement: null,
    },
    metricNotes: {
      providerAccepted:
        'Unique provider receipts from loaded history; acceptance is not delivery. Counts can be partial.',
      replies:
        'Distinct senders in the synced inbox and latest authorized Outlook scans; not all replies express interest.',
      closedDeals:
        'Owner-recorded evidence only; interested replies never count as clients.',
      social:
        'This queue only. Reconcile/import the existing provider queue before enabling publishing. Social analytics unavailable until connected.',
      search:
        'Search Console rows are a bounded query/page sample, not site-wide totals. GA4 key events depend on configured conversion events. AI referrals can be identified only where source attribution exists.',
    },
    health: {
      morning: !scheduler?.last_at
        ? 'never_observed'
        : scheduler.last_error
          ? 'failed'
          : age > 96 * 3600000
            ? 'stale'
            : 'observed',
      lastObservedAt: scheduler?.last_at || null,
      missingSources: entries
        .filter(([, v]) => v.status === 'unavailable')
        .map(([k]) => k),
      publishingEnabled: env.SOCIAL_PUBLISH_ENABLED === 'true',
      googleMonitoringConfigured: Boolean(env.GROWTH_GOOGLE_REFRESH_TOKEN),
    },
  };
}

/** Bounded, Mac-independent worker. No prospect sender is reachable from this worker. */
export type GrowthServices = {
  marketing: typeof runMarketingTick;
  reviews: typeof prepareSalesReviews;
  readMonitor: typeof readGrowthMonitor;
  monitor: typeof runGrowthMonitor;
  social: typeof publishNextSocial;
  instagramRead: typeof runInstagramRead;
  readInstagram: typeof readInstagramSnapshot;
};
export async function runGrowthTick(
  env: GrowthEnv,
  io: typeof fetch = fetch,
  now = Date.now(),
  overrides: Partial<GrowthServices> = {},
) {
  const lease = await acquireCrmLease('growth:tick', env, 300);
  if (!lease) return { ok: true, status: 'busy', transmitted: 0 };
  try {
    const logs = await dbReadKv<GrowthLog[]>(LOG_KEY, [], env);
    const current: GrowthLog[] = [];
    const services: GrowthServices = {
      marketing: runMarketingTick,
      reviews: prepareSalesReviews,
      readMonitor: readGrowthMonitor,
      monitor: runGrowthMonitor,
      social: publishNextSocial,
      instagramRead: runInstagramRead,
      readInstagram: readInstagramSnapshot,
      ...overrides,
    };
    const append = (agent: string, status: string, message: string) => {
      const entry = { at: new Date(now).toISOString(), agent, status, message };
      current.push(entry);
      logs.unshift(entry);
    };
    let marketingStatus = 'failed';
    let socialPublications = 0;
    try {
      const marketing = await services.marketing(env, undefined, now);
      marketingStatus = marketing.status;
      append(
        'sales_and_replies',
        marketing.status,
        'message' in marketing
          ? marketing.message
          : 'blockers' in marketing
            ? marketing.blockers?.join(', ') || 'Check configuration'
            : 'Check configuration',
      );
    } catch {
      append(
        'sales_and_replies',
        'failed',
        'Marketing checks failed; no prospect sender is reachable.',
      );
    }
    try {
      const reviews = await services.reviews(env);
      append(
        'sales_review',
        'drafts_only',
        `${reviews.length} evidence-linked inbound reviews prepared; no messages or commitments transmitted.`,
      );
    } catch {
      append(
        'sales_review',
        'failed',
        'Could not prepare sales suggestions; owner stages unchanged.',
      );
    }
    if (env.GROWTH_MONITOR_ENABLED === 'true') {
      try {
        const prior = await services.readMonitor(env);
        const observedAt = Date.parse(prior?.at || '');
        const retryAfter = prior?.search.status === 'verified' && prior?.traffic.status === 'verified'
          ? 23 * 3600000 : 3600000;
        if (!prior || !Number.isFinite(observedAt) || observedAt > now || now - observedAt >= retryAfter) {
          const monitor = await services.monitor(env, io, now);
          append(
            'seo_geo',
            monitor.search.status === 'verified' &&
              monitor.traffic.status === 'verified' &&
              monitor.technical.every((t) => t.status === 200)
              ? 'verified'
              : 'partial',
            'Technical audit and available Google data stored.',
          );
        }
      } catch {
        append(
          'seo_geo',
          'failed',
          'Monitor failed; inspect provider permissions and service logs.',
        );
      }
    }
    if (env.INSTAGRAM_READ_ENABLED === 'true') {
      try {
        const prior = await services.readInstagram(env);
        if (
          !prior ||
          prior.status !== 'verified' ||
          !Number.isFinite(Date.parse(prior.at)) ||
          Date.parse(prior.at) > now ||
          now - Date.parse(prior.at) >= 3600000
        ) {
          const snapshot = await services.instagramRead(env, io, now);
          append(
            'instagram_read',
            snapshot.status === 'verified' ? 'verified' : 'failed',
            snapshot.status === 'verified'
              ? 'Verified profile and bounded media sample stored; GET only.'
              : 'Instagram read unavailable; check credentials and account identity.',
          );
        }
      } catch {
        append(
          'instagram_read',
          'failed',
          'Instagram read failed; publishing credentials are not used.',
        );
      }
    }
    try {
      const social = await services.social(env, io, now);
      socialPublications = social.published;
      append(
        'social',
        social.status,
        `Published receipts recorded: ${social.published}`,
      );
    } catch {
      append(
        'social',
        'failed',
        'Social check failed; no automatic retry of uncertain publication.',
      );
    }
    await dbWriteKv(LOG_KEY, logs.slice(0, 200), env);
    const ok = !current.some((l) =>
      [
        'BLOCKED',
        'failed',
        'uncertain',
        'partial',
        'credentials_missing',
        'poll_retry',
        'reconciliation_required',
      ].includes(l.status),
    );
    return {
      ok,
      status: ok ? 'COMPLETED' : 'BLOCKED',
      marketing_status: marketingStatus,
      transmitted: 0,
      prospect_emails_transmitted: 0,
      social_publications: socialPublications,
      logs: current,
    };
  } finally {
    await releaseCrmLease('growth:tick', lease, env);
  }
}

export function draftId(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}
