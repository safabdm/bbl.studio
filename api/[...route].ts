import type { IncomingMessage, ServerResponse } from 'node:http';
import Stripe from 'stripe';
import { authorizeSuppressionList } from './unsubscribe-core.js';
import {
  BookingError,
  bookConsultation,
  bookingConfig,
  buildCandidateSlots,
  getCalendar,
  openSlots,
  publicBookingMeta,
  sendConfirmation,
  sendDueReminders,
} from './booking-core.js';
import {
  ADMIN_COOKIE,
  adminCookieHeader,
  adminEmail,
  adminName,
  cookieFromHeader,
  matchAdmin,
  readAdminToken,
  signAdminToken,
} from './admin-auth.js';
import { authorizeCrmSync } from './crm-sync-auth.js';

/** Lazy CRM / webhook loads — keep booking + admin/me off the CRM module graph. */
async function loadCrmApi() {
  return import('../server/crm-api.js');
}
async function loadCrmDiscoveryApi() {
  return import('../server/crm-discovery-api.js');
}
async function loadOutreachStudioApi() {
  return import('../server/outreach-studio-api.js');
}
async function loadResendWebhook() {
  return import('./resend-webhook.js');
}
async function loadUnsubscribeDurable() {
  return import('../server/unsubscribe.js');
}
async function loadSuppressionsDurable() {
  return import('../server/crm-suppressions.js');
}

function crmHeaders(req: IncomingMessage) {
  return {
    authorization: Array.isArray(req.headers.authorization)
      ? req.headers.authorization[0]
      : req.headers.authorization,
    'x-bbl-crm-sync-key': Array.isArray(req.headers['x-bbl-crm-sync-key'])
      ? req.headers['x-bbl-crm-sync-key'][0]
      : req.headers['x-bbl-crm-sync-key'],
    'x-bbl-crm-key': Array.isArray(req.headers['x-bbl-crm-key'])
      ? req.headers['x-bbl-crm-key'][0]
      : req.headers['x-bbl-crm-key'],
  };
}

export const config = { maxDuration: 30 };

const PROJECT_PACKAGES = {
  pkg_landing: { name: 'Simple Landing Page', depositCents: 60000 },
  pkg_business: { name: 'Business Website', depositCents: 110000 },
  pkg_commercial: { name: 'Commercial Website', depositCents: 170000 },
} as const;

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  for (const [key, value] of Object.entries(extra)) res.setHeader(key, value);
  res.end(JSON.stringify(body));
}

function readRawBody(req: IncomingMessage) {
  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

function readJson(req: IncomingMessage) {
  return readRawBody(req).then((raw) => {
    if (!raw) return {} as Record<string, string>;
    try {
      return JSON.parse(raw) as Record<string, string>;
    } catch {
      return {} as Record<string, string>;
    }
  });
}

function readJsonUnknown(req: IncomingMessage) {
  return readRawBody(req).then((raw) => {
    if (!raw) return {} as Record<string, unknown>;
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {} as Record<string, unknown>;
    }
  });
}

function requestPath(req: IncomingMessage) {
  const raw = req.url || '/';
  try {
    return new URL(raw, 'https://www.bbl.studio').pathname;
  } catch {
    return raw.split('?')[0] || '/';
  }
}

function matches(path: string, suffix: string) {
  const clean = path.replace(/\/+$/, '') || '/';
  return clean === suffix || clean.endsWith(suffix) || clean.endsWith(suffix.replace(/^\/api/, ''));
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    const path = requestPath(req);
    const method = (req.method || 'GET').toUpperCase();
    const cookieHeaderValue = Array.isArray(req.headers.cookie)
      ? req.headers.cookie.join(';')
      : req.headers.cookie;
    const admin = Boolean(readAdminToken(cookieFromHeader(cookieHeaderValue, ADMIN_COOKIE)));

    if (matches(path, '/api/book/reminders') && method === 'GET') {
      const secret = process.env.CRON_SECRET || '';
      const auth = String(req.headers.authorization || '');
      if (!secret || auth !== `Bearer ${secret}`) return send(res, 401, { ok: false, message: 'Unauthorized.' });
      const store = getCalendar();
      if (!store) return send(res, 200, { ok: true, sent: 0, checked: 0, emailConfigured: Boolean(process.env.RESEND_API_KEY) });
      return send(res, 200, { ok: true, ...(await sendDueReminders(store)) });
    }

    if (matches(path, '/api/crm/discovery/cron') && method === 'GET') {
      const { handleDiscoveryCron } = await loadCrmDiscoveryApi();
      const result = await handleDiscoveryCron({
        authorization: Array.isArray(req.headers.authorization)
          ? req.headers.authorization[0]
          : req.headers.authorization,
      });
      return send(res, result.status, result.body);
    }
    if (matches(path, '/api/crm/outreach/ready') && method === 'GET') {
      const { handleOutreachReadiness } = await loadOutreachStudioApi();
      const result = await handleOutreachReadiness(process.env);
      return send(res, result.status, result.body);
    }
    if (matches(path, '/api/crm/outreach/cron') && method === 'GET') {
      const { handleOutreachSchedulerCron } = await loadOutreachStudioApi();
      const url = new URL(req.url || '/', 'http://localhost');
      const source = url.searchParams.get('source') || undefined;
      const result = await handleOutreachSchedulerCron(
        {
          authorization: Array.isArray(req.headers.authorization)
            ? req.headers.authorization[0]
            : req.headers.authorization,
        },
        process.env,
        { source },
      );
      return send(res, result.status, result.body);
    }

    if (matches(path, '/api/book/slots') && method === 'GET') {
      const config = bookingConfig(process.env);
      const meta = publicBookingMeta(config);
      const open = buildCandidateSlots(new Date(), config);
      try {
        const store = getCalendar(process.env);
        if (!store) return send(res, 200, { ok: true, slots: open, ...meta });
        const slots = await openSlots(store, new Date(), config);
        return send(res, 200, { ok: true, slots, ...meta });
      } catch {
        return send(res, 200, { ok: true, slots: open, ...meta });
      }
    }

    if (matches(path, '/api/book') && method === 'POST') {
      const body = await readJson(req);
      if (String(body.website || '').trim()) return send(res, 200, { ok: true, message: 'Request received.' });
      const store = getCalendar();
      if (!store) return send(res, 503, { ok: false, message: 'Online booking is being connected. Email hello@bbl.studio or call (949) 524-2324.' });
      try {
        const result = await bookConsultation(store, {
          start: String(body.start || ''),
          name: String(body.name || ''),
          email: String(body.email || ''),
          company: String(body.company || ''),
          phone: String(body.phone || ''),
          note: String(body.note || ''),
        });
        const emailed = await sendConfirmation(result.slot, result.fields, bookingConfig());
        const message = result.canInvite
          ? `A calendar invitation${emailed ? ' and confirmation email were' : ' was'} sent to ${result.fields.email}.`
          : emailed
            ? `A confirmation email with a calendar file was sent to ${result.fields.email}.`
            : 'Your time is saved on the studio calendar.';
        return send(res, 200, {
          ok: true,
          when: `${result.slot.dateLabel} at ${result.slot.label}`,
          timezoneLabel: publicBookingMeta().timezoneLabel,
          durationMinutes: bookingConfig().durationMinutes,
          message,
        });
      } catch (error) {
        if (error instanceof BookingError) return send(res, error.status, { ok: false, code: error.code, message: error.message });
        throw error;
      }
    }

    if (matches(path, '/api/start-project/checkout') && method === 'POST') {
      const body = await readJson(req);
      const offerId = String(body.offerId || '') as keyof typeof PROJECT_PACKAGES;
      const selected = PROJECT_PACKAGES[offerId];
      const required = ['name', 'email', 'phone', 'businessName', 'pageCount', 'launchDate', 'goal', 'depositConsent'];
      if (String(body.website || '')) return send(res, 400, { ok: false, message: 'Request could not be submitted.' });
      if (!selected || required.some((key) => !String(body[key] || '').trim())) return send(res, 400, { ok: false, message: 'Please complete every required field.' });
      const email = String(body.email).trim().toLowerCase();
      if (!/^\S+@\S+\.\S+$/.test(email)) return send(res, 400, { ok: false, message: 'Please enter a valid email address.' });
      const key = process.env.STRIPE_SECRET_KEY || '';
      if (!key.startsWith('sk_')) return send(res, 503, { ok: false, message: 'Secure deposit checkout is being connected. Please call BBL to start your project.' });
      const stripe = new Stripe(key);
      const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'www.bbl.studio').split(',')[0].trim();
      const trustedHost = host === 'www.bbl.studio' || host === 'bbl.studio' || host === 'bbls.studio' || host.endsWith('.vercel.app') || host.endsWith('.chatgpt.site') || host.startsWith('127.0.0.1:') || host.startsWith('localhost:');
      const origin = trustedHost ? `${proto === 'http' ? 'http' : 'https'}://${host}` : 'https://www.bbl.studio';
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer_email: email,
        line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: selected.depositCents, product_data: { name: `BBL 20% Project Deposit: ${selected.name}` } } }],
        metadata: {
          offer_id: offerId,
          contact_name: String(body.name).slice(0, 120),
          phone: String(body.phone).slice(0, 60),
          business_name: String(body.businessName).slice(0, 120),
          page_count: String(body.pageCount).slice(0, 30),
          target_launch: String(body.launchDate).slice(0, 30),
          project_goal: String(body.goal).slice(0, 450),
        },
        success_url: `${origin}/?deposit=success#start-project`,
        cancel_url: `${origin}/?deposit=cancelled#start-project`,
      });
      if (!session.url) return send(res, 500, { ok: false, message: 'Secure checkout could not be opened. Please call BBL.' });
      return send(res, 200, { ok: true, url: session.url });
    }

    if (matches(path, '/api/health') && method === 'GET') {
      return send(res, 200, { ok: true, stripeMode: process.env.STRIPE_SECRET_KEY ? 'test' : 'mock' });
    }

    if (matches(path, '/api/unsubscribe/suppressions') && method === 'GET') {
      const auth = String(req.headers.authorization || req.headers['x-unsubscribe-secret'] || '');
      if (!authorizeSuppressionList(auth)) return send(res, 401, { ok: false, message: 'Unauthorized.' });
      const { listDurableSuppressions } = await loadSuppressionsDurable();
      return send(res, 200, { ok: true, suppressions: await listDurableSuppressions() });
    }

    if (matches(path, '/api/unsubscribe') && (method === 'GET' || method === 'POST')) {
      const url = new URL(req.url || '/', 'https://bbl.studio');
      const body = method === 'POST' ? await readJson(req) : {};
      const { processUnsubscribeDurable } = await loadUnsubscribeDurable();
      const result = await processUnsubscribeDurable({
        email: String(body.email || url.searchParams.get('email') || ''),
        lead_id: body.lead_id ?? url.searchParams.get('lead_id'),
        token: String(body.token || url.searchParams.get('token') || ''),
      });
      if (!result.ok) {
        const status = result.error === 'misconfigured' ? 503 : result.error === 'invalid_token' ? 403 : 400;
        return send(res, status, result);
      }
      return send(res, 200, result);
    }

    if (matches(path, '/api/admin/login') && method === 'POST') {
      const body = await readJson(req);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!matchAdmin(email, password)) {
        return send(res, 401, { ok: false, message: 'Invalid credentials.' });
      }
      return send(res, 200, { ok: true, name: adminName() }, { 'Set-Cookie': adminCookieHeader(signAdminToken()) });
    }

    if (matches(path, '/api/admin/logout') && method === 'POST') {
      return send(res, 200, { ok: true }, { 'Set-Cookie': adminCookieHeader('', true) });
    }

    if (matches(path, '/api/admin/me') && method === 'GET') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      return send(res, 200, {
        ok: true,
        admin: { id: 'adm_env', email: adminEmail(), name: adminName() },
        emails: [],
        stripeMode: process.env.STRIPE_SECRET_KEY ? 'test' : 'mock',
      });
    }

    if (matches(path, '/api/admin/projects') && method === 'GET') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      return send(res, 200, {
        ok: true,
        projects: [
          {
            id: process.env.PORTAL_TEST_PROJECT_ID || 'prj_7mKq9pR2xW4nV8sL',
            name: 'Northshore Botanica Brand & Website Launch',
            status: 'proposal_ready',
            company_name: 'Northshore Botanica',
            contact_name: 'Elena Voss',
            email: 'elena@northshore-botanica.example',
            package_name: 'Brand & Website',
            updated_at: '2026-10-10T12:00:00.000Z',
            created_at: '2026-10-10T12:00:00.000Z',
          },
        ],
      });
    }

    if (matches(path, '/api/resend-webhook') && method === 'POST') {
      const raw = await readRawBody(req);
      const { processResendWebhook } = await loadResendWebhook();
      const result = await processResendWebhook({
        body: raw,
        headers: {
          'svix-id': req.headers['svix-id'],
          'svix-timestamp': req.headers['svix-timestamp'],
          'svix-signature': req.headers['svix-signature'],
        },
      });
      return send(res, result.status, {
        ok: result.ok,
        duplicate: result.duplicate,
        forwarded: result.forwarded,
        stored: result.stored,
        applied_to_crm: result.applied_to_crm,
        matched_leads: result.matched_leads,
        event_id: result.event_id,
        type: result.type,
        message: result.message,
      });
    }

    if (matches(path, '/api/crm/sync') && method === 'POST') {
      const headers = crmHeaders(req);
      const auth = authorizeCrmSync(headers);
      if (!auth.ok) return send(res, auth.status, { ok: false, message: auth.message });
      const raw = await readRawBody(req);
      let body: unknown = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return send(res, 400, { ok: false, message: 'Invalid JSON body.' });
      }
      const { handleCrmSyncIngest } = await loadCrmApi();
      const result = await handleCrmSyncIngest(headers, body, {
        rawBytes: Buffer.byteLength(raw, 'utf8'),
      });
      return send(res, result.status, result.body);
    }

    if (matches(path, '/api/crm/sync/status') && method === 'GET') {
      const headers = crmHeaders(req);
      const auth = authorizeCrmSync(headers);
      if (!auth.ok) return send(res, auth.status, { ok: false, message: auth.message });
      const { handleCrmSyncStatus } = await loadCrmApi();
      const result = await handleCrmSyncStatus(headers);
      return send(res, result.status, result.body);
    }

    if (matches(path, '/api/admin/crm/overview') && method === 'GET') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      const { handleCrmOverview } = await loadCrmApi();
      const result = await handleCrmOverview(admin);
      return send(res, result.status, result.body);
    }
    if (matches(path, '/api/admin/crm/leads') && method === 'GET') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      const url = new URL(req.url || '/', 'https://www.bbl.studio');
      const { handleCrmLeads } = await loadCrmApi();
      const result = await handleCrmLeads(admin, url.searchParams.toString());
      return send(res, result.status, result.body);
    }
    if (matches(path, '/api/admin/crm/inbox') && method === 'GET') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      const { handleCrmInbox } = await loadCrmApi();
      const result = await handleCrmInbox(admin);
      return send(res, result.status, result.body);
    }
    if (matches(path, '/api/admin/crm/bookings') && method === 'GET') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      const { handleCrmBookings } = await loadCrmApi();
      const result = await handleCrmBookings(admin);
      return send(res, result.status, result.body);
    }
    if (matches(path, '/api/admin/crm/campaigns') && method === 'GET') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      const { handleCrmCampaigns } = await loadCrmApi();
      const result = await handleCrmCampaigns(admin);
      return send(res, result.status, result.body);
    }
    if (matches(path, '/api/admin/crm/settings') && method === 'GET') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      const { handleCrmSettings } = await loadCrmApi();
      const result = await handleCrmSettings(admin);
      return send(res, result.status, result.body);
    }
    if (matches(path, '/api/admin/crm/selection') && method === 'POST') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      const body = await readJsonUnknown(req);
      const { handleCrmSelectionMeta } = await loadCrmApi();
      const result = handleCrmSelectionMeta(admin, body as { selected_ids?: Array<number | string> });
      return send(res, result.status, result.body);
    }
    if (matches(path, '/api/admin/crm/preview') && method === 'POST') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      const body = await readJsonUnknown(req);
      const { handleCrmPreview } = await loadCrmApi();
      const result = await handleCrmPreview(admin, body as never);
      return send(res, result.status, result.body);
    }
    if (matches(path, '/api/admin/crm/drafts') && method === 'POST') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      const body = await readJsonUnknown(req);
      const { handleCrmSaveDraft } = await loadCrmApi();
      const result = await handleCrmSaveDraft(admin, body as never);
      return send(res, result.status, result.body);
    }
    if (matches(path, '/api/admin/crm/send-test') && method === 'POST') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      const body = await readJsonUnknown(req);
      const { handleCrmSendTest } = await loadCrmApi();
      const result = await handleCrmSendTest(admin, body as never);
      return send(res, result.status, result.body);
    }
    if (matches(path, '/api/admin/crm/send') && method === 'POST') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      const body = await readJsonUnknown(req);
      const { handleCrmSendCampaign } = await loadCrmApi();
      const result = await handleCrmSendCampaign(admin, body as never);
      return send(res, result.status, result.body);
    }
    if (matches(path, '/api/admin/crm/freelance/import') && method === 'POST') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      const body = await readJsonUnknown(req);
      const { handleFreelanceImport } = await loadCrmApi();
      const result = await handleFreelanceImport(admin, body as never);
      return send(res, result.status, result.body);
    }
    if (matches(path, '/api/admin/crm/freelance/score') && method === 'POST') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      const body = await readJsonUnknown(req);
      const { handleFreelanceScore } = await loadCrmApi();
      const result = handleFreelanceScore(admin, body as never);
      return send(res, result.status, result.body);
    }

    if (matches(path, '/api/admin/crm/discovery') && method === 'GET') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      const { handleDiscoveryStatus } = await loadCrmDiscoveryApi();
      const result = await handleDiscoveryStatus(admin);
      return send(res, result.status, result.body);
    }
    if (matches(path, '/api/admin/crm/discovery/run') && method === 'POST') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      const body = await readJsonUnknown(req);
      const { handleDiscoveryRun } = await loadCrmDiscoveryApi();
      const result = await handleDiscoveryRun(admin, body as never);
      return send(res, result.status, result.body);
    }
    if (matches(path, '/api/admin/crm/discovery/pause') && method === 'POST') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      const body = await readJsonUnknown(req);
      const { handleDiscoveryPause } = await loadCrmDiscoveryApi();
      const result = await handleDiscoveryPause(admin, body as never);
      return send(res, result.status, result.body);
    }
    if (matches(path, '/api/admin/crm/discovery/resume') && method === 'POST') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      const { handleDiscoveryResume } = await loadCrmDiscoveryApi();
      const result = await handleDiscoveryResume(admin);
      return send(res, result.status, result.body);
    }
    if (matches(path, '/api/admin/crm/discovery/logs') && method === 'GET') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      const url = new URL(req.url || '/', 'https://www.bbl.studio');
      const limit = Number(url.searchParams.get('limit') || '20');
      const { handleDiscoveryLogs } = await loadCrmDiscoveryApi();
      const result = await handleDiscoveryLogs(admin, limit);
      return send(res, result.status, result.body);
    }
    if (matches(path, '/api/admin/crm/discovery/qualified') && method === 'GET') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      const url = new URL(req.url || '/', 'https://www.bbl.studio');
      const limit = Number(url.searchParams.get('limit') || '50');
      const { handleDiscoveryQualified } = await loadCrmDiscoveryApi();
      const result = await handleDiscoveryQualified(admin, limit);
      return send(res, result.status, result.body);
    }
    if (matches(path, '/api/admin/crm/discovery/enrich') && method === 'POST') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      const body = await readJsonUnknown(req);
      const { handleDiscoveryEnrich } = await loadCrmDiscoveryApi();
      const result = await handleDiscoveryEnrich(admin, body as never);
      return send(res, result.status, result.body);
    }

    /* Outreach Studio */
    if (matches(path, '/api/admin/crm/lead-queue') && method === 'GET') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      const url = new URL(req.url || '/', 'https://www.bbl.studio');
      const { handleLeadQueueList } = await loadOutreachStudioApi();
      const result = await handleLeadQueueList(admin, {
        q: url.searchParams.get('q') || undefined,
        queue_status: (url.searchParams.get('queue_status') as never) || undefined,
        source: (url.searchParams.get('source') as never) || undefined,
        has_email:
          url.searchParams.get('has_email') === '1'
            ? true
            : url.searchParams.get('has_email') === '0'
              ? false
              : undefined,
        has_observation:
          url.searchParams.get('has_observation') === '1'
            ? true
            : url.searchParams.get('has_observation') === '0'
              ? false
              : undefined,
      });
      return send(res, result.status, result.body);
    }
    if (matches(path, '/api/admin/crm/lead-queue/action') && method === 'POST') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      const body = await readJsonUnknown(req);
      const { handleLeadQueueAction } = await loadOutreachStudioApi();
      const result = await handleLeadQueueAction(admin, body as never);
      return send(res, result.status, result.body);
    }
    if (matches(path, '/api/admin/crm/lead-queue/audit') && method === 'GET') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      const { handleLeadQueueAudit } = await loadOutreachStudioApi();
      const result = await handleLeadQueueAudit(admin);
      return send(res, result.status, result.body);
    }
    if (matches(path, '/api/admin/crm/email-studio') && method === 'GET') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      const { handleEmailStudioList } = await loadOutreachStudioApi();
      const result = await handleEmailStudioList(admin);
      return send(res, result.status, result.body);
    }
    if (matches(path, '/api/admin/crm/email-studio/draft') && method === 'POST') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      const body = await readJsonUnknown(req);
      const { handleEmailStudioDraft } = await loadOutreachStudioApi();
      const result = await handleEmailStudioDraft(admin, body as never);
      return send(res, result.status, result.body);
    }
    if (matches(path, '/api/admin/crm/email-studio/approve') && method === 'POST') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      const body = await readJsonUnknown(req);
      const { handleEmailStudioApprove } = await loadOutreachStudioApi();
      const result = await handleEmailStudioApprove(admin, body as never);
      return send(res, result.status, result.body);
    }
    if (matches(path, '/api/admin/crm/daily-cap') && method === 'GET') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      const { handleDailyCapGet } = await loadOutreachStudioApi();
      const result = await handleDailyCapGet(admin);
      return send(res, result.status, result.body);
    }
    if (matches(path, '/api/admin/crm/daily-cap') && method === 'POST') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      const body = await readJsonUnknown(req);
      const { handleDailyCapSet } = await loadOutreachStudioApi();
      const result = await handleDailyCapSet(admin, body as never);
      return send(res, result.status, result.body);
    }
    if (matches(path, '/api/admin/crm/send-controls') && method === 'GET') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      const { handleSendControlsGet } = await loadOutreachStudioApi();
      const result = await handleSendControlsGet(admin);
      return send(res, result.status, result.body);
    }
    if (matches(path, '/api/admin/crm/send-controls') && method === 'POST') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      const body = await readJsonUnknown(req);
      const { handleSendControlsAction } = await loadOutreachStudioApi();
      const result = await handleSendControlsAction(admin, body as never);
      return send(res, result.status, result.body);
    }
    if (matches(path, '/api/admin/crm/outlook/connect') && method === 'POST') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      const { handleOutlookConnect } = await loadOutreachStudioApi();
      const result = await handleOutlookConnect(admin);
      return send(res, result.status, result.body);
    }
    if (matches(path, '/api/admin/crm/outlook/callback') && method === 'GET') {
      const url = new URL(req.url || '/', 'https://www.bbl.studio');
      const { handleOutlookCallback } = await loadOutreachStudioApi();
      const result = await handleOutlookCallback({
        code: url.searchParams.get('code') || undefined,
        state: url.searchParams.get('state') || undefined,
        error: url.searchParams.get('error') || undefined,
      });
      return send(res, result.status, result.body);
    }
    if (matches(path, '/api/admin/crm/outlook/disconnect') && method === 'POST') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      const { handleOutlookDisconnect } = await loadOutreachStudioApi();
      const result = await handleOutlookDisconnect(admin);
      return send(res, result.status, result.body);
    }
    if (matches(path, '/api/admin/crm/sender') && (method === 'GET' || method === 'POST')) {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      const body = method === 'POST' ? await readJsonUnknown(req) : {};
      const { handleSenderPreference } = await loadOutreachStudioApi();
      const result = await handleSenderPreference(admin, body as never);
      return send(res, result.status, result.body);
    }
    if (matches(path, '/api/admin/crm/inbox/import-replies') && method === 'POST') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      const { handleInboxImportReplies } = await loadOutreachStudioApi();
      const result = await handleInboxImportReplies(admin);
      return send(res, result.status, result.body);
    }
    if (matches(path, '/api/admin/crm/outreach-analytics') && method === 'GET') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      const { handleOutreachAnalytics } = await loadOutreachStudioApi();
      const result = await handleOutreachAnalytics(admin);
      return send(res, result.status, result.body);
    }
    if (matches(path, '/api/admin/crm/daily-20') && method === 'GET') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      const url = new URL(req.url || '/', 'https://www.bbl.studio');
      const { handleDaily20Get } = await loadOutreachStudioApi();
      const result = await handleDaily20Get(admin, { refresh: url.searchParams.get('refresh') || undefined });
      return send(res, result.status, result.body);
    }
    if (matches(path, '/api/admin/crm/daily-20/approve') && method === 'POST') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      const body = await readJsonUnknown(req);
      const { handleDaily20BulkApprove } = await loadOutreachStudioApi();
      const result = await handleDaily20BulkApprove(admin, body as never);
      return send(res, result.status, result.body);
    }
    if (matches(path, '/api/admin/crm/follow-ups') && (method === 'GET' || method === 'POST')) {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      const body = method === 'POST' ? await readJsonUnknown(req) : { generate: false };
      const { handleFollowUpDrafts } = await loadOutreachStudioApi();
      const result = await handleFollowUpDrafts(admin, body as never);
      return send(res, result.status, result.body);
    }
    if (matches(path, '/api/admin/crm/send-window') && method === 'POST') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      const body = await readJsonUnknown(req);
      const { handleSendWindowSet } = await loadOutreachStudioApi();
      const result = await handleSendWindowSet(admin, body as never);
      return send(res, result.status, result.body);
    }
    if (matches(path, '/api/admin/crm/scheduler') && method === 'GET') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      const { handleSchedulerStatus } = await loadOutreachStudioApi();
      const result = await handleSchedulerStatus(admin);
      return send(res, result.status, result.body);
    }
    if (matches(path, '/api/admin/crm/scheduler/run') && method === 'POST') {
      if (!admin) return send(res, 401, { ok: false, message: 'Sign in required.' });
      const body = await readJsonUnknown(req);
      const { handleSchedulerRunJob } = await loadOutreachStudioApi();
      const result = await handleSchedulerRunJob(admin, body as never);
      return send(res, result.status, result.body);
    }

    return send(res, 404, { ok: false, message: 'Not found.' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Request failed.';
    return send(res, 500, { ok: false, message });
  }
}
