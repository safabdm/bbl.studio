import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { AGREEMENT_NOTICE } from './agreement-template';
import { adminName, matchAdmin, readAdminToken, signAdminToken } from './admin-auth';
import { clientIp, cookieValue, dollars, hashEquals, hashPassword, id, nowIso, randomToken, sha256, verifyPassword } from './crypto';
import { db, paths, row, rows, run } from './db';
import { esign } from './esign';
import { logEmail, portalEmail, recentEmails } from './email';
import { writeTextPdf } from './pdf';
import { seedIfNeeded } from './seed';
import { stripeClient, stripeMode } from './stripe';
import { activeLinks, clientFacingPayload, registerPricingRoutes } from './admin-pricing';
import { registerLeadRoutes } from './lead-routes';
import { seedLeadsIfNeeded } from './leads';

try {
  seedIfNeeded();
  seedLeadsIfNeeded();
} catch (error) {
  console.error('BBLS seed skipped', error);
}

const CLIENT_COOKIE = 'bbls_client_session';
const ADMIN_COOKIE = 'bbls_admin_session';
const INVALID = 'This private link is invalid, expired, or no longer available.';
const rate = new Map<string, { count: number; start: number }>();
const mockCheckouts = new Map<string, { installmentId: string; projectId: string; amount: number }>();

function limited(key: string, max = 8) {
  const now = Date.now();
  const hit = rate.get(key);
  if (!hit || now - hit.start > 10 * 60 * 1000) {
    rate.set(key, { count: 1, start: now });
    return true;
  }
  hit.count += 1;
  return hit.count <= max;
}

function cookieOpts() {
  return {
    httpOnly: true,
    sameSite: 'Lax' as const,
    path: '/',
    secure: Boolean(process.env.VERCEL) || (process.env.APP_ORIGIN || '').startsWith('https'),
    maxAge: 60 * 60 * 12,
  };
}

function audit(projectId: string | null, actor: string, action: string, meta: unknown = {}) {
  const eventId = id('aud_');
  run(`INSERT INTO audit_events (id, project_id, actor, action, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [
    eventId, projectId, actor, action, JSON.stringify(meta), nowIso(),
  ]);
  return eventId;
}

function findToken(token: string) {
  return row<{
    id: string; project_id: string; expires_at: string | null; revoked_at: string | null; require_verification: number;
  }>(`SELECT * FROM portal_access_tokens WHERE token_hash = ?`, [sha256(token)]);
}

function tokenUsable(record: ReturnType<typeof findToken>) {
  if (!record) return false;
  if (record.revoked_at) return false;
  if (record.expires_at && new Date(record.expires_at).getTime() < Date.now()) return false;
  return true;
}

function projectBundle(projectId: string) {
  const project = row<Record<string, unknown>>(`SELECT p.*, c.company_name, c.contact_name, c.email, c.title as client_title, pkg.name as package_name
    FROM projects p JOIN clients c ON c.id = p.client_id LEFT JOIN packages pkg ON pkg.id = p.package_id WHERE p.id = ?`, [projectId]);
  if (!project) return null;
  const items = rows(`SELECT * FROM line_items WHERE project_id = ?`, [projectId]);
  const deliverables = rows(`SELECT * FROM deliverables WHERE project_id = ?`, [projectId]);
  const plans = rows<Record<string, unknown>>(`SELECT * FROM payment_plans WHERE project_id = ?`, [projectId]);
  const installments = rows<Record<string, unknown>>(`SELECT * FROM installments WHERE project_id = ? ORDER BY payment_plan_id, number`, [projectId]);
  const agreement = row<Record<string, unknown>>(`SELECT * FROM agreement_versions WHERE project_id = ? ORDER BY version DESC LIMIT 1`, [projectId]);
  const acceptance = row<Record<string, unknown>>(`SELECT * FROM agreement_acceptances WHERE project_id = ? AND agreement_version_id = ?`, [projectId, agreement?.id]);
  const payments = rows(`SELECT * FROM payments WHERE project_id = ? ORDER BY created_at`, [projectId]);
  const previews = rows<Record<string, unknown>>(`SELECT id, version, kind, title, revoked, created_at FROM previews WHERE project_id = ? ORDER BY version, created_at`, [projectId]);
  const feedback = rows(`SELECT * FROM feedback WHERE project_id = ? ORDER BY created_at`, [projectId]);
  const approvals = rows(`SELECT * FROM approvals WHERE project_id = ? ORDER BY created_at`, [projectId]);
  const releases = rows<Record<string, unknown>>(`SELECT id, label, released_at FROM file_releases WHERE project_id = ?`, [projectId]);
  const paid = (payments as { amount_cents: number; status: string }[]).filter((item) => item.status === 'paid').reduce((sum, item) => sum + item.amount_cents, 0);
  return {
    project,
    items,
    deliverables,
    plans: plans.map((plan) => ({ ...plan, installments: installments.filter((item) => item.payment_plan_id === plan.id) })),
    agreement,
    acceptance,
    payments,
    previews,
    feedback,
    approvals,
    releases: releases.map((file) => ({ ...file, available: Boolean(file.released_at) })),
    paid_cents: paid,
    remaining_cents: Number(project.price_cents) - paid,
    dashboardUnlocked: Boolean(acceptance) && paid > 0,
    stripeMode: stripeMode(),
  };
}

function sessionFrom(cookieHeader: string | undefined, kind: 'client' | 'admin') {
  const raw = getCookieFrom(cookieHeader, kind === 'client' ? CLIENT_COOKIE : ADMIN_COOKIE);
  if (!raw) return null;
  return row<{ id: string; subject_id: string; token_id: string | null; expires_at: string }>(
    `SELECT * FROM sessions WHERE session_hash = ? AND kind = ?`,
    [sha256(raw), kind],
  );
}

function getCookieFrom(header: string | undefined, name: string) {
  return cookieValue(header, name);
}

function createSession(kind: 'client' | 'admin', subjectId: string, tokenId?: string) {
  const token = randomToken();
  run(`INSERT INTO sessions (id, kind, subject_id, token_id, session_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
    id('ses_'), kind, subjectId, tokenId || null, sha256(token), new Date(Date.now() + 12 * 3600000).toISOString(), nowIso(),
  ]);
  return token;
}

function requireClient(c: { req: { header: (name: string) => string | undefined } }) {
  const session = sessionFrom(c.req.header('cookie'), 'client');
  if (!session || new Date(session.expires_at).getTime() < Date.now()) return null;
  return session;
}

function requireAdmin(c: { req: { header: (name: string) => string | undefined } }) {
  const signed = readAdminToken(cookieValue(c.req.header('cookie'), ADMIN_COOKIE));
  if (signed) {
    return { id: 'ses_signed', subject_id: 'adm_env', token_id: null, expires_at: new Date(signed.exp || Date.now()).toISOString() };
  }
  const session = sessionFrom(c.req.header('cookie'), 'admin');
  if (!session || new Date(session.expires_at).getTime() < Date.now()) return null;
  return session;
}

function markInstallmentPaid(installmentId: string, checkoutId: string, paymentIntent: string | null, receiptUrl: string | null) {
  const installment = row<{ id: string; project_id: string; amount_cents: number; status: string }>(`SELECT * FROM installments WHERE id = ?`, [installmentId]);
  if (!installment) return;
  if (installment.status === 'paid') return;
  run(`UPDATE installments SET status = 'paid', paid_at = ?, stripe_checkout_id = ? WHERE id = ?`, [nowIso(), checkoutId, installmentId]);
  run(`INSERT INTO payments (id, project_id, installment_id, stripe_payment_intent, stripe_checkout_id, amount_cents, status, receipt_url, created_at) VALUES (?, ?, ?, ?, ?, ?, 'paid', ?, ?)`, [
    id('pay_'), installment.project_id, installmentId, paymentIntent, checkoutId, installment.amount_cents, receiptUrl, nowIso(),
  ]);
  const project = row<{ status: string; contact_name?: string }>(`SELECT p.status, c.contact_name FROM projects p JOIN clients c ON c.id = p.client_id WHERE p.id = ?`, [installment.project_id]);
  if (project && ['proposal_ready', 'awaiting_agreement', 'awaiting_payment'].includes(String(project.status))) {
    run(`UPDATE projects SET status = 'project_active' WHERE id = ?`, [installment.project_id]);
  }
  const client = row<{ contact_name: string; email: string; name: string }>(`SELECT c.contact_name, c.email, p.name FROM clients c JOIN projects p ON p.client_id = c.id WHERE p.id = ?`, [installment.project_id]);
  if (client) {
    portalEmail({
      template: 'payment_received',
      to: client.email,
      clientName: client.contact_name,
      projectName: client.name,
      action: 'Payment was recorded. Continue in the private portal.',
      portalPath: '/admin',
      extra: `Amount confirmed: ${dollars(installment.amount_cents)}. No card details are included in this email.`,
    });
  }
  audit(installment.project_id, 'stripe', 'payment_verified', { installmentId, checkoutId });
}

export const app = new Hono();

app.use('/api/*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  c.header('X-Robots-Tag', 'noindex, nofollow');
  await next();
});

app.get('/api/health', (c) => c.json({ ok: true, stripeMode: stripeMode() }));

app.post('/api/portal/open', async (c) => {
  const ip = clientIp(c.req.header('x-forwarded-for') || c.req.header('x-real-ip'));
  if (!limited(`open:${ip}`)) return c.json({ ok: false, code: 'invalid_link', message: INVALID }, 429);
  const body = await c.req.json<{ token?: string }>();
  const token = body.token?.trim() || '';
  const record = findToken(token);
  if (!tokenUsable(record)) return c.json({ ok: false, code: 'invalid_link', message: INVALID }, 404);
  const project = projectBundle(record!.project_id);
  const verificationRequired = Boolean(record!.require_verification);
  if (!verificationRequired) {
    setCookie(c, CLIENT_COOKIE, createSession('client', record!.project_id, record!.id), cookieOpts());
    audit(record!.project_id, 'client', 'opened_private_link', { ip });
  }
  return c.json({
    ok: true,
    verificationRequired,
    company: project?.project.company_name,
    clientName: project?.project.contact_name,
    projectName: project?.project.name,
    status: project?.project.status,
    createdAt: project?.project.created_at,
    expiresAt: project?.project.proposal_expires_at,
  });
});

app.post('/api/portal/request-code', async (c) => {
  const ip = clientIp(c.req.header('x-forwarded-for') || c.req.header('x-real-ip'));
  if (!limited(`code:${ip}`, 6)) return c.json({ ok: false, code: 'invalid_link', message: INVALID }, 429);
  const { token } = await c.req.json<{ token?: string }>();
  const record = findToken(token || '');
  if (!tokenUsable(record)) return c.json({ ok: false, code: 'invalid_link', message: INVALID }, 404);
  const code = String(Math.floor(100000 + Math.random() * 900000));
  run(`INSERT INTO verification_codes (id, token_id, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`, [
    id('vc_'), record!.id, sha256(code), new Date(Date.now() + 10 * 60 * 1000).toISOString(), nowIso(),
  ]);
  const client = row<{ contact_name: string; email: string; name: string }>(`SELECT c.contact_name, c.email, p.name FROM clients c JOIN projects p ON p.client_id = c.id WHERE p.id = ?`, [record!.project_id]);
  if (client) {
    portalEmail({
      template: 'verification_code',
      to: client.email,
      clientName: client.contact_name,
      projectName: client.name,
      action: 'Enter the one-time verification code',
      portalPath: '/client',
      extra: `Your one-time code is logged for local development only and is never placed in the URL.`,
    });
    logEmail('verification_code', client.email, 'BBLS verification code', `Local development code: ${code}`);
  }
  return c.json({ ok: true, message: 'If this link is valid, a verification code was sent.' });
});

app.post('/api/portal/verify', async (c) => {
  const ip = clientIp(c.req.header('x-forwarded-for') || c.req.header('x-real-ip'));
  if (!limited(`verify:${ip}`)) return c.json({ ok: false, message: INVALID }, 429);
  const { token, code } = await c.req.json<{ token?: string; code?: string }>();
  const record = findToken(token || '');
  if (!tokenUsable(record)) return c.json({ ok: false, code: 'invalid_link', message: INVALID }, 404);
  const found = row<{ id: string }>(`SELECT id FROM verification_codes WHERE token_id = ? AND code_hash = ? AND consumed_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1`, [
    record!.id, sha256(String(code || '')), nowIso(),
  ]);
  if (!found) return c.json({ ok: false, message: 'That code is not valid. Request a new code and try again.' }, 400);
  run(`UPDATE verification_codes SET consumed_at = ? WHERE id = ?`, [nowIso(), found.id]);
  const session = createSession('client', record!.project_id, record!.id);
  setCookie(c, CLIENT_COOKIE, session, cookieOpts());
  audit(record!.project_id, 'client', 'verified_portal_access', { ip });
  return c.json({ ok: true });
});

app.get('/api/portal/session', (c) => {
  const session = requireClient(c);
  if (!session) return c.json({ ok: false, auth: false }, 401);
  const bundle = projectBundle(session.subject_id);
  const facing = clientFacingPayload(session.subject_id);
  return c.json({
    ok: true,
    ...facing,
    agreement: bundle?.agreement
      ? { id: bundle.agreement.id, version: bundle.agreement.version, title: bundle.agreement.title, body_json: bundle.agreement.body_json, legal_status: bundle.agreement.legal_status }
      : null,
    acceptance: bundle?.acceptance
      ? { accepted_at: bundle.acceptance.accepted_at, typed_name: bundle.acceptance.typed_name, company: bundle.acceptance.company }
      : null,
    paid_cents: bundle?.paid_cents || 0,
    remaining_cents: facing?.total_cents ? facing.total_cents - (bundle?.paid_cents || 0) : bundle?.remaining_cents,
    stripeMode: stripeMode(),
  });
});

app.post('/api/portal/accept-proposal', (c) => {
  const session = requireClient(c);
  if (!session) return c.json({ ok: false }, 401);
  const published = row<{ id: string; version: number }>(`SELECT id, version FROM proposal_versions WHERE project_id = ? AND status = 'published' ORDER BY version DESC LIMIT 1`, [session.subject_id]);
  if (!published) {
    run(`UPDATE projects SET status = CASE WHEN status = 'proposal_ready' THEN 'awaiting_agreement' ELSE status END WHERE id = ?`, [session.subject_id]);
    audit(session.subject_id, 'client', 'proposal_accepted', {});
    return c.json({ ok: true });
  }
  run(`UPDATE proposal_versions SET status = 'accepted' WHERE id = ?`, [published.id]);
  run(`UPDATE projects SET status = CASE WHEN status IN ('proposal_ready','draft') THEN 'awaiting_agreement' ELSE status END, signed_proposal_version = ? WHERE id = ?`, [published.version, session.subject_id]);
  audit(session.subject_id, 'client', 'proposal_accepted', { version: published.version });
  return c.json({ ok: true, version: published.version });
});

app.post('/api/portal/change-orders/:id/accept', (c) => {
  const session = requireClient(c);
  if (!session) return c.json({ ok: false }, 401);
  const order = row<{ id: string; additional_cents: number; snapshot_json: string; status: string }>(
    `SELECT * FROM change_orders WHERE id = ? AND project_id = ?`,
    [c.req.param('id'), session.subject_id],
  );
  if (!order || order.status !== 'pending') return c.json({ ok: false, message: 'That change order is not awaiting acceptance.' }, 400);
  const snap = JSON.parse(order.snapshot_json) as { newTotal?: number; installments?: { name: string; amount_cents: number; milestone: string; due_at?: string | null; percent?: number | null }[] };
  const project = row<{ price_cents: number }>(`SELECT price_cents FROM projects WHERE id = ?`, [session.subject_id]);
  const newTotal = Number(snap.newTotal || (Number(project?.price_cents || 0) + order.additional_cents));
  run(`UPDATE change_orders SET status = 'accepted', accepted_at = ? WHERE id = ?`, [nowIso(), order.id]);
  run(`UPDATE projects SET price_cents = ?, remaining_balance_cents = remaining_balance_cents + ? WHERE id = ?`, [newTotal, order.additional_cents, session.subject_id]);
  const plan = row<{ id: string }>(`SELECT id FROM payment_plans WHERE project_id = ? ORDER BY rowid DESC LIMIT 1`, [session.subject_id]);
  const last = row<{ number: number }>(`SELECT number FROM installments WHERE project_id = ? ORDER BY number DESC LIMIT 1`, [session.subject_id]);
  (snap.installments || []).forEach((item, index) => {
    run(`INSERT INTO installments (id, payment_plan_id, project_id, number, amount_cents, milestone, due_at, status, stripe_checkout_id, checkout_expires_at, paid_at, name, percent) VALUES (?, ?, ?, ?, ?, ?, ?, 'due', NULL, NULL, NULL, ?, ?)`, [
      id('ins_'), plan?.id || id('plan_'), session.subject_id, (last?.number || 0) + index + 1, item.amount_cents, item.milestone || item.name, item.due_at || null, item.name, item.percent ?? null,
    ]);
  });
  audit(session.subject_id, 'client', 'change_order_accepted', { orderId: order.id, additional: order.additional_cents });
  return c.json({ ok: true, newTotal });
});

app.get('/api/portal/proposal.pdf', (c) => {
  const session = requireClient(c);
  if (!session) return c.json({ ok: false }, 401);
  const bundle = projectBundle(session.subject_id);
  if (!bundle) return c.json({ ok: false }, 404);
  const p = bundle.project;
  const path = writeTextPdf(
    `${session.subject_id}/proposal.pdf`,
    'BBLS Proposal',
    [
      String(p.company_name),
      String(p.name),
      `Package: ${p.package_name}`,
      `Price: ${dollars(Number(p.price_cents))}`,
      String(p.description),
      `Pages: ${p.pages}`,
      `Revisions: ${p.revisions_included}`,
      `Timeline: ${p.timeline}`,
      `Expires: ${p.proposal_expires_at}`,
      'This PDF is generated for the named client only.',
    ],
  );
  return c.body(createReadStream(path) as unknown as ReadableStream, 200, {
    'Content-Type': 'application/pdf',
    'Content-Disposition': 'attachment; filename="bbls-proposal.pdf"',
    'X-Robots-Tag': 'noindex, nofollow',
  });
});

app.post('/api/portal/accept-agreement', async (c) => {
  const session = requireClient(c);
  if (!session) return c.json({ ok: false }, 401);
  const body = await c.req.json<{
    agree?: boolean;
    previewRestriction?: boolean;
    portfolio?: 'yes_after_launch' | 'no' | 'ask_again';
    typedName?: string;
    title?: string;
    company?: string;
    signature?: string;
  }>();
  if (!body.agree || !body.previewRestriction) return c.json({ ok: false, message: 'Required consents are missing.' }, 400);
  if (!body.typedName?.trim() || !body.company?.trim() || !body.signature?.trim() || !body.portfolio) {
    return c.json({ ok: false, message: 'Complete name, company, signature, and portfolio permission.' }, 400);
  }
  const agreement = row<{ id: string; content_hash: string; version: number }>(`SELECT * FROM agreement_versions WHERE project_id = ? ORDER BY version DESC LIMIT 1`, [session.subject_id]);
  if (!agreement) return c.json({ ok: false }, 400);
  const existing = row(`SELECT id FROM agreement_acceptances WHERE project_id = ? AND agreement_version_id = ?`, [session.subject_id, agreement.id]);
  if (existing) return c.json({ ok: true, already: true });
  await esign.createEnvelope({
    agreementVersionId: agreement.id,
    signerName: body.typedName,
    signerEmail: 'portal-session',
    company: body.company,
  });
  const ip = clientIp(c.req.header('x-forwarded-for') || c.req.header('x-real-ip'));
  const auditId = audit(session.subject_id, 'client', 'agreement_accepted', { version: agreement.version, hash: agreement.content_hash });
  const pdfPath = writeTextPdf(`${session.subject_id}/agreement-v${agreement.version}.pdf`, 'BBLS Signed Agreement', [
    AGREEMENT_NOTICE,
    `Version ${agreement.version}`,
    `Hash ${agreement.content_hash}`,
    `Signed by ${body.typedName}`,
    `Company ${body.company}`,
    `Role ${body.title || 'n/a'}`,
    `Portfolio permission ${body.portfolio}`,
    `Accepted ${nowIso()}`,
    `Audit ${auditId}`,
  ]);
  run(`INSERT INTO agreement_acceptances (id, agreement_version_id, project_id, typed_name, title, company, signature_data, portfolio_permission, consents_json, accepted_at, ip_address, user_agent, audit_event_id, content_hash, pdf_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    id('acc_'), agreement.id, session.subject_id, body.typedName.trim(), body.title || '', body.company.trim(), body.signature, body.portfolio,
    JSON.stringify({ agree: true, previewRestriction: true, portfolio: body.portfolio }), nowIso(), ip, c.req.header('user-agent') || '', auditId, agreement.content_hash, pdfPath,
  ]);
  run(`UPDATE projects SET status = 'awaiting_payment' WHERE id = ?`, [session.subject_id]);
  const client = row<{ contact_name: string; email: string; name: string }>(`SELECT c.contact_name, c.email, p.name FROM clients c JOIN projects p ON p.client_id = c.id WHERE p.id = ?`, [session.subject_id]);
  if (client) {
    portalEmail({
      template: 'agreement_accepted',
      to: client.email,
      clientName: client.contact_name,
      projectName: client.name,
      action: 'Select a payment option',
      portalPath: '/client',
    });
  }
  return c.json({ ok: true, auditId });
});

app.get('/api/portal/agreement.pdf', (c) => {
  const session = requireClient(c);
  if (!session) return c.json({ ok: false }, 401);
  const acceptance = row<{ pdf_path: string }>(`SELECT pdf_path FROM agreement_acceptances WHERE project_id = ? ORDER BY accepted_at DESC LIMIT 1`, [session.subject_id]);
  if (!acceptance?.pdf_path) return c.json({ ok: false, message: 'Agreement PDF is available after acceptance.' }, 404);
  return c.body(createReadStream(acceptance.pdf_path) as unknown as ReadableStream, 200, {
    'Content-Type': 'application/pdf',
    'Content-Disposition': 'attachment; filename="bbls-agreement.pdf"',
    'X-Robots-Tag': 'noindex, nofollow',
  });
});

app.post('/api/portal/checkout', async (c) => {
  const session = requireClient(c);
  if (!session) return c.json({ ok: false }, 401);
  const accepted = row(`SELECT id FROM agreement_acceptances WHERE project_id = ?`, [session.subject_id]);
  if (!accepted) return c.json({ ok: false, message: 'Accept the proposal and agreement before payment.' }, 400);
  const { installmentId } = await c.req.json<{ installmentId?: string }>();
  const installment = row<{ id: string; amount_cents: number; status: string; stripe_checkout_id: string | null; checkout_expires_at: string | null; milestone: string }>(
    `SELECT * FROM installments WHERE id = ? AND project_id = ?`,
    [installmentId, session.subject_id],
  );
  if (!installment || installment.status === 'paid') return c.json({ ok: false, message: 'That installment is not payable.' }, 400);
  if (installment.stripe_checkout_id && installment.checkout_expires_at && new Date(installment.checkout_expires_at).getTime() > Date.now()) {
    return c.json({ ok: true, url: installment.stripe_checkout_id.startsWith('mock_') ? `/api/portal/checkout/mock/${installment.stripe_checkout_id}` : installment.stripe_checkout_id });
  }
  const origin = process.env.APP_ORIGIN || 'http://127.0.0.1:4173';
  if (stripeMode() === 'local_mock') {
    const mockId = `mock_${randomToken(12)}`;
    mockCheckouts.set(mockId, { installmentId: installment.id, projectId: session.subject_id, amount: installment.amount_cents });
    run(`UPDATE installments SET stripe_checkout_id = ?, checkout_expires_at = ? WHERE id = ?`, [mockId, new Date(Date.now() + 30 * 60 * 1000).toISOString(), installment.id]);
    return c.json({ ok: true, url: `/api/portal/checkout/mock/${mockId}` });
  }
  const stripe = stripeClient();
  if (!stripe) return c.json({ ok: false, message: 'Stripe Test Mode is not configured.' }, 500);
  const created = await stripe.checkout.sessions.create({
    mode: 'payment',
    success_url: `${origin}/client/payment-return?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/client/payment-return?canceled=1`,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: installment.amount_cents,
        product_data: { name: `BBLS · ${installment.milestone}` },
      },
    }],
    metadata: { projectId: session.subject_id, installmentId: installment.id },
  }, { idempotencyKey: `checkout_${installment.id}_${installment.stripe_checkout_id || 'new'}` });
  run(`UPDATE installments SET stripe_checkout_id = ?, checkout_expires_at = ? WHERE id = ?`, [created.url, new Date(Date.now() + 30 * 60 * 1000).toISOString(), installment.id]);
  return c.json({ ok: true, url: created.url });
});

app.get('/api/portal/checkout/mock/:id', (c) => {
  const checkout = mockCheckouts.get(c.req.param('id'));
  if (!checkout) return c.text('This test checkout is no longer available.', 404);
  return c.html(`<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>BBLS Test Checkout</title>
    <style>body{font-family:Inter,sans-serif;background:#0a0a0a;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0}main{width:min(26rem,92vw);border:1px solid rgba(255,255,255,.15);border-radius:16px;padding:2rem;background:rgba(255,255,255,.08)}button,a{min-height:44px;display:inline-flex;align-items:center;justify-content:center;border-radius:99px;padding:.7rem 1rem}button{width:100%;border:0;background:#fff;color:#0a0a0a;font-weight:600}p{color:#cfcfcf}</style></head>
    <body><main><p style="color:#d4b483">STRIPE TEST MODE MOCK</p><h1>Pay ${dollars(checkout.amount)}</h1><p>No live charges. Confirming this page records a verified local test payment through the same webhook-style ledger used for Stripe events.</p>
    <form method="post"><button type="submit">Pay with test card 4242</button></form></main></body></html>`);
});

app.post('/api/portal/checkout/mock/:id', async (c) => {
  const checkoutId = c.req.param('id');
  const checkout = mockCheckouts.get(checkoutId);
  if (!checkout) return c.text('This test checkout is no longer available.', 404);
  const eventId = `evt_mock_${checkoutId}`;
  const exists = row(`SELECT id FROM stripe_events WHERE id = ?`, [eventId]);
  if (!exists) {
    run(`INSERT INTO stripe_events (id, type, payload_json, processed_at) VALUES (?, ?, ?, ?)`, [
      eventId, 'checkout.session.completed', JSON.stringify(checkout), nowIso(),
    ]);
    markInstallmentPaid(checkout.installmentId, checkoutId, null, null);
  }
  return c.redirect('/client/opened');
});

app.post('/api/stripe/webhook', async (c) => {
  const stripe = stripeClient();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !secret) return c.json({ ok: false }, 400);
  const payload = await c.req.text();
  const signature = c.req.header('stripe-signature') || '';
  let event;
  try {
    event = stripe.webhooks.constructEvent(payload, signature, secret);
  } catch {
    return c.json({ ok: false }, 400);
  }
  const seen = row(`SELECT id FROM stripe_events WHERE id = ?`, [event.id]);
  if (seen) return c.json({ ok: true, duplicate: true });
  run(`INSERT INTO stripe_events (id, type, payload_json, processed_at) VALUES (?, ?, ?, ?)`, [event.id, event.type, payload, nowIso()]);
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as { id: string; metadata?: { installmentId?: string }; payment_intent?: string; amount_total?: number };
    if (session.metadata?.installmentId) {
      markInstallmentPaid(session.metadata.installmentId, session.id, String(session.payment_intent || ''), null);
    }
  }
  return c.json({ received: true });
});

app.post('/api/portal/question', async (c) => {
  const session = requireClient(c);
  if (!session) return c.json({ ok: false }, 401);
  const { body, previewId } = await c.req.json<{ body?: string; previewId?: string }>();
  if (!body?.trim()) return c.json({ ok: false, message: 'Enter a question or comment.' }, 400);
  run(`INSERT INTO feedback (id, preview_id, project_id, body, created_at, status) VALUES (?, ?, ?, ?, ?, 'question')`, [
    id('fb_'), previewId || 'none', session.subject_id, body.trim(), nowIso(),
  ]);
  audit(session.subject_id, 'client', 'question_submitted', {});
  return c.json({ ok: true });
});

app.post('/api/portal/revisions', async (c) => {
  const session = requireClient(c);
  if (!session) return c.json({ ok: false }, 401);
  const bundle = projectBundle(session.subject_id);
  if (!bundle?.dashboardUnlocked) return c.json({ ok: false, message: 'Dashboard unlocks after agreement and initial payment.' }, 400);
  const { previewId, body } = await c.req.json<{ previewId?: string; body?: string }>();
  if (!previewId || !body?.trim()) return c.json({ ok: false, message: 'Revision requests need written feedback.' }, 400);
  run(`INSERT INTO feedback (id, preview_id, project_id, body, created_at, status) VALUES (?, ?, ?, ?, ?, 'revision_requested')`, [
    id('fb_'), previewId, session.subject_id, body.trim(), nowIso(),
  ]);
  run(`UPDATE projects SET status = 'revisions_requested' WHERE id = ?`, [session.subject_id]);
  audit(session.subject_id, 'client', 'revisions_requested', { previewId });
  return c.json({ ok: true });
});

app.post('/api/portal/approve', async (c) => {
  const session = requireClient(c);
  if (!session) return c.json({ ok: false }, 401);
  const bundle = projectBundle(session.subject_id);
  if (!bundle?.dashboardUnlocked) return c.json({ ok: false }, 400);
  const { previewId, typedName, confirm } = await c.req.json<{ previewId?: string; typedName?: string; confirm?: boolean }>();
  if (!confirm || !typedName?.trim() || !previewId) return c.json({ ok: false, message: 'Confirmation and typed name are required.' }, 400);
  const preview = row<{ version: number }>(`SELECT version FROM previews WHERE id = ? AND project_id = ?`, [previewId, session.subject_id]);
  if (!preview) return c.json({ ok: false }, 404);
  run(`INSERT INTO approvals (id, preview_id, project_id, typed_name, created_at) VALUES (?, ?, ?, ?, ?)`, [
    id('ap_'), previewId, session.subject_id, typedName.trim(), nowIso(),
  ]);
  run(`UPDATE projects SET status = 'approved' WHERE id = ?`, [session.subject_id]);
  audit(session.subject_id, 'client', 'preview_approved', { previewId, version: preview.version });
  return c.json({ ok: true, version: preview.version });
});

app.get('/api/portal/preview/:id', (c) => {
  const session = requireClient(c);
  if (!session) return c.json({ ok: false }, 401);
  const preview = row<{ id: string; kind: string; file_path: string | null; website_path: string | null; revoked: number; title: string; version: number }>(
    `SELECT * FROM previews WHERE id = ? AND project_id = ?`,
    [c.req.param('id'), session.subject_id],
  );
  if (!preview || preview.revoked) return c.json({ ok: false }, 404);
  return c.json({ ok: true, preview: { id: preview.id, kind: preview.kind, title: preview.title, version: preview.version }, imageUrl: preview.file_path ? `/api/portal/preview/${preview.id}/file` : null, siteUrl: preview.website_path ? `/api/portal/preview/${preview.id}/site` : null });
});

app.get('/api/portal/preview/:id/file', async (c) => {
  const session = requireClient(c);
  if (!session) return c.body('Unauthorized', 401);
  const preview = row<{ file_path: string | null; revoked: number }>(`SELECT file_path, revoked FROM previews WHERE id = ? AND project_id = ?`, [c.req.param('id'), session.subject_id]);
  if (!preview?.file_path || preview.revoked) return c.body('Not found', 404);
  const file = await BunFile(preview.file_path);
  return c.body(file, 200, { 'Content-Type': preview.file_path.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream', 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store' });
});

app.get('/api/portal/preview/:id/site', async (c) => {
  const session = requireClient(c);
  if (!session) return c.body('Unauthorized', 401);
  const preview = row<{ website_path: string | null; revoked: number }>(`SELECT website_path, revoked FROM previews WHERE id = ? AND project_id = ?`, [c.req.param('id'), session.subject_id]);
  if (!preview?.website_path || preview.revoked) return c.body('Not found', 404);
  const html = await BunFileText(preview.website_path);
  return c.html(`<div style="position:fixed;top:0;left:0;right:0;z-index:9;background:#d4b483;color:#0a0a0a;text-align:center;padding:.7rem;font-family:Inter,sans-serif;font-size:.78rem;letter-spacing:.08em">PRIVATE CLIENT PREVIEW. NOT APPROVED FOR PUBLIC OR COMMERCIAL USE</div><div style="padding-top:3rem">${html}</div>`, 200, { 'X-Robots-Tag': 'noindex, nofollow' });
});

async function BunFile(path: string) {
  const { readFileSync } = await import('node:fs');
  return readFileSync(path);
}
async function BunFileText(path: string) {
  const { readFileSync } = await import('node:fs');
  return readFileSync(path, 'utf8');
}

app.post('/api/portal/download/:releaseId', (c) => {
  const session = requireClient(c);
  if (!session) return c.json({ ok: false }, 401);
  const release = row<{ id: string; file_path: string; released_at: string | null; label: string }>(`SELECT * FROM file_releases WHERE id = ? AND project_id = ?`, [c.req.param('releaseId'), session.subject_id]);
  if (!release?.released_at) return c.json({ ok: false, message: 'Final files are locked until BBLS releases them.' }, 403);
  const token = randomToken();
  run(`INSERT INTO download_tokens (id, file_release_id, token_hash, expires_at) VALUES (?, ?, ?, ?)`, [
    id('dl_'), release.id, sha256(token), new Date(Date.now() + 2 * 60 * 1000).toISOString(),
  ]);
  return c.json({ ok: true, url: `/api/portal/files/${token}` });
});

app.get('/api/portal/files/:token', async (c) => {
  const session = requireClient(c);
  if (!session) return c.body('Unauthorized', 401);
  const token = row<{ file_release_id: string; expires_at: string; used_at: string | null }>(`SELECT dt.*, fr.file_path, fr.project_id FROM download_tokens dt JOIN file_releases fr ON fr.id = dt.file_release_id WHERE dt.token_hash = ?`, [sha256(c.req.param('token'))]);
  const full = row<{ file_path: string; project_id: string; id: string; label: string }>(`SELECT fr.* FROM download_tokens dt JOIN file_releases fr ON fr.id = dt.file_release_id WHERE dt.token_hash = ?`, [sha256(c.req.param('token'))]);
  if (!token || !full || token.used_at || new Date(token.expires_at).getTime() < Date.now() || full.project_id !== session.subject_id) {
    return c.body('This download link is invalid or expired.', 404);
  }
  run(`UPDATE download_tokens SET used_at = ? WHERE token_hash = ?`, [nowIso(), sha256(c.req.param('token'))]);
  run(`INSERT INTO download_events (id, file_release_id, project_id, downloaded_at, ip_address) VALUES (?, ?, ?, ?, ?)`, [
    id('dlev_'), full.id, full.project_id, nowIso(), clientIp(c.req.header('x-forwarded-for')),
  ]);
  audit(full.project_id, 'client', 'final_file_downloaded', { label: full.label });
  const data = await BunFile(full.file_path);
  return c.body(data, 200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${basename(full.file_path)}"`,
    'X-Robots-Tag': 'noindex, nofollow',
  });
});

app.post('/api/admin/login', async (c) => {
  const ip = clientIp(c.req.header('x-forwarded-for') || c.req.header('x-real-ip'));
  if (!limited(`admin:${ip}`, 10)) return c.json({ ok: false, message: 'Try again later.' }, 429);
  const { email, password } = await c.req.json<{ email?: string; password?: string }>();
  if (matchAdmin(email, password)) {
    setCookie(c, ADMIN_COOKIE, signAdminToken(), cookieOpts());
    return c.json({ ok: true, name: adminName() });
  }
  const admin = row<{ id: string; password_hash: string; name: string; email: string }>(`SELECT * FROM admin_users WHERE email = ?`, [(email || '').toLowerCase()]);
  if (!admin || !verifyPassword(password || '', admin.password_hash)) return c.json({ ok: false, message: 'Invalid credentials.' }, 401);
  setCookie(c, ADMIN_COOKIE, createSession('admin', admin.id), cookieOpts());
  audit(null, admin.email, 'admin_login', {});
  return c.json({ ok: true, name: admin.name });
});

app.post('/api/admin/logout', (c) => {
  deleteCookie(c, ADMIN_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

app.get('/api/admin/me', (c) => {
  const session = requireAdmin(c);
  if (!session) return c.json({ ok: false }, 401);
  const admin = row(`SELECT id, email, name FROM admin_users WHERE id = ?`, [session.subject_id]);
  return c.json({ ok: true, admin, emails: recentEmails(8), stripeMode: stripeMode() });
});

app.get('/api/admin/projects', (c) => {
  if (!requireAdmin(c)) return c.json({ ok: false }, 401);
  const list = rows(`SELECT p.*, c.company_name, c.contact_name, c.email FROM projects p JOIN clients c ON c.id = p.client_id ORDER BY p.created_at DESC`);
  return c.json({ ok: true, projects: list });
});

app.get('/api/admin/projects/:id', (c) => {
  if (!requireAdmin(c)) return c.json({ ok: false }, 401);
  const bundle = projectBundle(c.req.param('id'));
  if (!bundle) return c.json({ ok: false }, 404);
  const timeline = rows(`SELECT * FROM audit_events WHERE project_id = ? ORDER BY created_at DESC`, [c.req.param('id')]);
  return c.json({
    ok: true,
    ...bundle,
    links: activeLinks(c.req.param('id')),
    timeline,
    pricingUrl: `/admin/projects/${c.req.param('id')}/pricing`,
  });
});

app.post('/api/admin/projects/:id/status', async (c) => {
  if (!requireAdmin(c)) return c.json({ ok: false }, 401);
  const { status } = await c.req.json<{ status?: string }>();
  run(`UPDATE projects SET status = ? WHERE id = ?`, [status, c.req.param('id')]);
  audit(c.req.param('id'), 'admin', 'status_updated', { status });
  return c.json({ ok: true });
});

app.post('/api/admin/projects/:id/token', async (c) => {
  if (!requireAdmin(c)) return c.json({ ok: false }, 401);
  const { days, requireVerification } = await c.req.json<{ days?: number; requireVerification?: boolean }>();
  const token = randomToken();
  const expires = new Date(Date.now() + (days || 21) * 86400000).toISOString();
  run(`INSERT INTO portal_access_tokens (id, project_id, token_hash, expires_at, require_verification, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [
    id('tok_'), c.req.param('id'), sha256(token), expires, requireVerification === false ? 0 : 1, nowIso(),
  ]);
  audit(c.req.param('id'), 'admin', 'portal_link_generated', { expires });
  return c.json({ ok: true, url: `${process.env.APP_ORIGIN || 'http://127.0.0.1:4173'}/client/${token}`, expires });
});

app.post('/api/admin/tokens/:id/revoke', (c) => {
  if (!requireAdmin(c)) return c.json({ ok: false }, 401);
  const token = row<{ project_id: string }>(`SELECT project_id FROM portal_access_tokens WHERE id = ?`, [c.req.param('id')]);
  run(`UPDATE portal_access_tokens SET revoked_at = ? WHERE id = ?`, [nowIso(), c.req.param('id')]);
  if (token) audit(token.project_id, 'admin', 'portal_link_revoked', { tokenId: c.req.param('id') });
  return c.json({ ok: true });
});

app.post('/api/admin/projects/:id/agreement/new-version', async (c) => {
  if (!requireAdmin(c)) return c.json({ ok: false }, 401);
  const current = row<{ version: number; body_json: string; title: string }>(`SELECT * FROM agreement_versions WHERE project_id = ? ORDER BY version DESC LIMIT 1`, [c.req.param('id')]);
  if (!current) return c.json({ ok: false }, 404);
  const next = JSON.stringify({ ...JSON.parse(current.body_json), amendedAt: nowIso() });
  run(`INSERT INTO agreement_versions (id, project_id, version, title, body_json, content_hash, legal_status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'template_requires_attorney_review', ?)`, [
    id('agr_'), c.req.param('id'), current.version + 1, current.title, next, sha256(next), nowIso(),
  ]);
  run(`UPDATE projects SET status = 'awaiting_agreement' WHERE id = ?`, [c.req.param('id')]);
  audit(c.req.param('id'), 'admin', 'agreement_version_created', { version: current.version + 1 });
  return c.json({ ok: true, version: current.version + 1 });
});

app.post('/api/admin/projects/:id/release', (c) => {
  if (!requireAdmin(c)) return c.json({ ok: false }, 401);
  const paid = row<{ remaining: number }>(`SELECT (SELECT price_cents FROM projects WHERE id = ?) - IFNULL((SELECT SUM(amount_cents) FROM payments WHERE project_id = ? AND status = 'paid'), 0) as remaining`, [c.req.param('id'), c.req.param('id')]);
  const accepted = row(`SELECT id FROM agreement_acceptances WHERE project_id = ?`, [c.req.param('id')]);
  if (!accepted) return c.json({ ok: false, message: 'Agreement must be accepted first.' }, 400);
  if ((paid?.remaining || 0) > 0) return c.json({ ok: false, message: 'Required payments must be verified before release.' }, 400);
  run(`UPDATE file_releases SET released_at = ?, released_by = 'admin' WHERE project_id = ? AND released_at IS NULL`, [nowIso(), c.req.param('id')]);
  run(`UPDATE projects SET status = 'final_files_released' WHERE id = ?`, [c.req.param('id')]);
  audit(c.req.param('id'), 'admin', 'final_files_released', {});
  return c.json({ ok: true });
});

app.post('/api/admin/projects/:id/line-items', async (c) => {
  if (!requireAdmin(c)) return c.json({ ok: false }, 401);
  const { label, amount_cents, kind } = await c.req.json<{ label?: string; amount_cents?: number; kind?: string }>();
  run(`INSERT INTO line_items (id, project_id, label, amount_cents, kind, selected) VALUES (?, ?, ?, ?, ?, 1)`, [
    id('li_'), c.req.param('id'), label || 'Custom item', amount_cents || 0, kind || 'custom',
  ]);
  return c.json({ ok: true });
});

app.get('/api/admin/projects/:id/export', (c) => {
  if (!requireAdmin(c)) return c.json({ ok: false }, 401);
  const bundle = projectBundle(c.req.param('id'));
  const timeline = rows(`SELECT * FROM audit_events WHERE project_id = ? ORDER BY created_at`, [c.req.param('id')]);
  return c.json({ ok: true, exportedAt: nowIso(), bundle, timeline });
});

registerPricingRoutes(app);
registerLeadRoutes(app, requireAdmin);

export default app;
