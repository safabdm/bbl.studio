import type { GrowthEnv } from './growth.js';
import { getOutreachReadinessSnapshot } from './daily-outreach-scheduler.js';
import { marketingConfigBlockers } from './marketing-automation.js';

/** Configuration evidence only. No token exchange, provider probe or mutation. */
export function growthReadiness(env: GrowthEnv, now = Date.now()) {
  const missing = (keys: Array<keyof GrowthEnv>) =>
    keys.filter((key) => !String(env[key] || '').trim());
  const reconciled = Date.parse(env.SOCIAL_QUEUE_RECONCILED_AT || '');
  return {
    checkedAt: new Date(now).toISOString(),
    timezone: 'America/Los_Angeles',
    configurationOnly: true,
    providerAuthorizationVerified: false,
    externalActionsRequireOwnerApproval: true,
    outreach: getOutreachReadinessSnapshot(env),
    marketing: {
      mode: 'drafts_only',
      missingConfiguration: marketingConfigBlockers(env),
      senderInvokedByTick: false,
    },
    monitoring: {
      enabled: env.GROWTH_MONITOR_ENABLED === 'true',
      missingConfiguration: missing([
        'GROWTH_GOOGLE_CLIENT_ID',
        'GROWTH_GOOGLE_CLIENT_SECRET',
        'GROWTH_GOOGLE_REFRESH_TOKEN',
        'GA4_PROPERTY_ID',
      ]),
      providerAuthorizationVerified: false,
    },
    social: {
      enabled: env.SOCIAL_PUBLISH_ENABLED === 'true',
      existingQueueReconciled: Number.isFinite(reconciled) && reconciled <= now,
      instagram: {
        missingConfiguration: missing([
          'INSTAGRAM_ACCESS_TOKEN',
          'INSTAGRAM_ACCOUNT_ID',
          'SOCIAL_MEDIA_HOSTS',
        ]),
        requiredIdentity: 'businessbrandlab',
        providerAuthorizationVerified: false,
      },
      linkedin: {
        missingConfiguration: missing([
          'LINKEDIN_ACCESS_TOKEN',
          'LINKEDIN_AUTHOR_URN',
        ]),
        exactApprovedAuthorRequired: true,
        providerAuthorizationVerified: false,
      },
    },
    note: 'Missing accounts/scopes are activation prerequisites, never inferred as connected. Disabled integrations stay off; this endpoint cannot enable sending, publishing or deployment.',
  };
}
