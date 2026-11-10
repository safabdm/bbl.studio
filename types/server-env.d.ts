import type { GrowthEnv } from '../server/growth.js';
import type { CrmSyncAuthEnv } from '../api/crm-sync-auth.js';
import type { ResendWebhookEnv } from '../api/resend-webhook.js';

// Vinext adds named properties to ProcessEnv. Explicit optional server keys
// preserve structural compatibility with the narrow injected agent env types.
// This is type-only: it provides no credentials or runtime defaults.
declare global {
  namespace NodeJS {
    interface ProcessEnv extends GrowthEnv, CrmSyncAuthEnv, ResendWebhookEnv {}
  }
}
