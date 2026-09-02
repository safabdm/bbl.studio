import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { AGREEMENT_NOTICE, agreementSections } from './agreement-template';
import { readAdminToken } from './admin-auth';
import { decryptSecret, encryptSecret, id, nowIso, randomToken, sha256 } from './crypto';
import { appOrigin, clientPortalUrl, publicClientUrl } from './env';
import { row, rows, run } from './db';
import { portalEmail } from './email';
import { PACKAGE_PRESETS } from './packages';
import { buildPlan, computeTotal, defaultPricingFromPreset, formatMoney, type InstallmentInput, type PaymentOption, type PricingInput } from './pricing';

const ADMIN_COOKIE = 'bbls_admin_session';
const REFUND = 'PLACEHOLDER: Refundability language must be attorney-reviewed before production use.';

function requireAdmin(c: { req: { header: (name: string) => string | undefined } }) {
  const raw = getCookie(c as never, ADMIN_COOKIE) || '';
  const signed = readAdminToken(raw);
  if (signed) return { id: 'ses_signed', subject_id: 'adm_env', expires_at: new Date(signed.exp || Date.now()).toISOString() };
  if (!raw) return null;
  const session = row<{ id: string; subject_id: string; expires_at: string }>(
    `SELECT * FROM sessions WHERE session_hash = ? AND kind = 'admin'`,
    [sha256(raw)],
  );
  if (!session || new Date(session.expires_at).getTime() < Date.now()) return null;
  return session;
}

function audit(projectId: string | null, actor: string, action: string, meta: unknown = {}) {
  const eventId = id('aud_');
  run(`INSERT INTO audit_events (id, project_id, actor, action, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [
    eventId, projectId, actor, action, JSON.stringify(meta), nowIso(),
  ]);
  return eventId;
}

function parseBody<T>(value: unknown) {
  return (value || {}) as T;
}

function asPricing(projectId: string, body: Partial<PricingInput> & Record<string, unknown>): PricingInput {
  const additional = Array.isArray(body.additional_services) ? body.additional_services : [];
  const third = Array.isArray(body.third_party_expenses) ? body.third_party_expenses : [];
  const additionalCents = additional.reduce((sum, item) => sum + Number(item.amount_cents || 0), 0);
  const thirdCents = third.reduce((sum, item) => sum + Number(item.amount_cents || 0), 0);
  return {
    package_id: String(body.package_id || '') || null,
    package_name: String(body.package_name || 'Custom Project'),
    base_price_cents: Number(body.base_price_cents || 0),
    discount_cents: Number(body.discount_cents || 0),
    additional_services_cents: additionalCents,
    third_party_cents: thirdCents,
    tax_cents: Number(body.tax_cents || 0),
    currency: String(body.currency || 'USD'),
    proposal_expires_at: body.proposal_expires_at ? String(body.proposal_expires_at) : null,
    deposit_required_cents: Number(body.deposit_required_cents || 0),
    deposit_percent: body.deposit_percent == null ? 50 : Number(body.deposit_percent),
    deposit_mode: body.deposit_mode === 'amount' ? 'amount' : 'percent',
    payment_option: (['full', 'two', 'three', 'custom'].includes(String(body.payment_option)) ? body.payment_option : 'two') as PaymentOption,
    installments: Array.isArray(body.installments) ? body.installments : [],
    client_pricing_notes: String(body.client_pricing_notes || ''),
    internal_notes: String(body.internal_notes || ''),
    additional_services: additional.map((item) => ({ label: String(item.label || 'Additional service'), amount_cents: Number(item.amount_cents || 0) })),
    third_party_expenses: third.map((item) => ({ label: String(item.label || 'Third-party expense'), amount_cents: Number(item.amount_cents || 0) })),
    deliverables: Array.isArray(body.deliverables) ? body.deliverables.map((item) => String(item)).filter(Boolean) : [],
  };
}

function signedVersion(projectId: string) {
  return row<{ signed_proposal_version: number | null; current_proposal_version: number }>(
    `SELECT signed_proposal_version, current_proposal_version FROM projects WHERE id = ?`,
    [projectId],
  );
}

function hasSignedAgreement(projectId: string) {
  return Boolean(row(`SELECT id FROM agreement_acceptances WHERE project_id = ? LIMIT 1`, [projectId]));
}

function replaceLineItems(projectId: string, pricing: PricingInput) {
  run(`DELETE FROM line_items WHERE project_id = ?`, [projectId]);
  run(`INSERT INTO line_items (id, project_id, label, amount_cents, kind, selected) VALUES (?, ?, ?, ?, 'included', 1)`, [
    id('li_'), projectId, pricing.package_name, pricing.base_price_cents,
  ]);
  if (pricing.discount_cents) {
    run(`INSERT INTO line_items (id, project_id, label, amount_cents, kind, selected) VALUES (?, ?, ?, ?, 'discount', 1)`, [
      id('li_'), projectId, 'Custom discount', -pricing.discount_cents,
    ]);
  }
  for (const item of pricing.additional_services) {
    run(`INSERT INTO line_items (id, project_id, label, amount_cents, kind, selected) VALUES (?, ?, ?, ?, 'addon', 1)`, [
      id('li_'), projectId, item.label, item.amount_cents,
    ]);
  }
  for (const item of pricing.third_party_expenses) {
    run(`INSERT INTO line_items (id, project_id, label, amount_cents, kind, selected) VALUES (?, ?, ?, ?, 'third_party', 1)`, [
      id('li_'), projectId, item.label, item.amount_cents,
    ]);
  }
  if (pricing.tax_cents) {
    run(`INSERT INTO line_items (id, project_id, label, amount_cents, kind, selected) VALUES (?, ?, ?, ?, 'tax', 1)`, [
      id('li_'), projectId, 'Taxes', pricing.tax_cents,
    ]);
  }
}

function replaceDeliverables(projectId: string, labels: string[]) {
  run(`DELETE FROM deliverables WHERE project_id = ?`, [projectId]);
  for (const label of labels) {
    run(`INSERT INTO deliverables (id, project_id, label, description) VALUES (?, ?, ?, ?)`, [id('del_'), projectId, label, label]);
  }
}

function replacePaymentPlan(projectId: string, pricing: PricingInput, total: number, installments: InstallmentInput[]) {
  run(`DELETE FROM installments WHERE project_id = ?`, [projectId]);
  run(`DELETE FROM payment_plans WHERE project_id = ?`, [projectId]);
  const planId = id('plan_');
  const names: Record<PaymentOption, string> = {
    full: 'Full payment',
    two: 'Two payments',
    three: 'Three payments',
    custom: 'Custom payment plan',
  };
  run(`INSERT INTO payment_plans (id, project_id, name, kind, refund_language) VALUES (?, ?, ?, ?, ?)`, [
    planId, projectId, names[pricing.payment_option], pricing.payment_option, REFUND,
  ]);
  installments.forEach((item, index) => {
    run(`INSERT INTO installments (id, payment_plan_id, project_id, number, amount_cents, milestone, due_at, status, stripe_checkout_id, checkout_expires_at, paid_at, name, percent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      id('ins_'), planId, projectId, index + 1, item.amount_cents, item.milestone, item.due_at, item.status || 'due', null, null, null, item.name, item.percent ?? null,
    ]);
  });
  const deposit = installments[0]?.amount_cents || 0;
  run(`UPDATE projects SET remaining_balance_cents = ?, deposit_cents = ? WHERE id = ?`, [total - deposit, deposit, projectId]);
}

function snapshotOf(projectId: string, pricing: PricingInput, total: number, installments: PricingInput['installments']) {
  return {
    projectId,
    package_name: pricing.package_name,
    currency: pricing.currency,
    base_price_cents: pricing.base_price_cents,
    discount_cents: pricing.discount_cents,
    additional_services: pricing.additional_services,
    third_party_expenses: pricing.third_party_expenses,
    tax_cents: pricing.tax_cents,
    total_cents: total,
    payment_option: pricing.payment_option,
    installments,
    deliverables: pricing.deliverables,
    client_pricing_notes: pricing.client_pricing_notes,
    proposal_expires_at: pricing.proposal_expires_at,
  };
}

export function loadPricing(projectId: string) {
  const project = row<Record<string, unknown>>(`SELECT p.*, c.company_name, c.contact_name, c.email, c.title as client_title, pkg.name as package_preset_name
    FROM projects p JOIN clients c ON c.id = p.client_id LEFT JOIN packages pkg ON pkg.id = p.package_id WHERE p.id = ?`, [projectId]);
  if (!project) return null;
  const items = rows<{ label: string; amount_cents: number; kind: string }>(`SELECT * FROM line_items WHERE project_id = ?`, [projectId]);
  const deliverables = rows<{ label: string }>(`SELECT * FROM deliverables WHERE project_id = ?`, [projectId]);
  const installments = rows<Record<string, unknown>>(`SELECT * FROM installments WHERE project_id = ? ORDER BY number`, [projectId]);
  const versions = rows(`SELECT id, version, status, total_cents, created_at, published_at FROM proposal_versions WHERE project_id = ? ORDER BY version DESC`, [projectId]);
  const changeOrders = rows(`SELECT * FROM change_orders WHERE project_id = ? ORDER BY created_at DESC`, [projectId]);
  const acceptance = row(`SELECT id, accepted_at, agreement_version_id FROM agreement_acceptances WHERE project_id = ? ORDER BY accepted_at DESC LIMIT 1`, [projectId]);
  const total = Number(project.price_cents);
  return {
    project,
    packages: PACKAGE_PRESETS,
    items,
    deliverables: deliverables.map((item) => item.label),
    additional_services: items.filter((item) => item.kind === 'addon').map((item) => ({ label: item.label, amount_cents: item.amount_cents })),
    third_party_expenses: items.filter((item) => item.kind === 'third_party').map((item) => ({ label: item.label, amount_cents: item.amount_cents })),
    installments,
    versions,
    changeOrders,
    acceptance,
    signed: Boolean(acceptance),
    totals: {
      base_price_cents: Number(project.price_cents) - Number(project.additional_services_cents || 0) - Number(project.third_party_cents || 0) - Number(project.tax_cents || 0) + Number(project.discount_cents || 0),
      discount_cents: Number(project.discount_cents || 0),
      additional_services_cents: Number(project.additional_services_cents || 0),
      third_party_cents: Number(project.third_party_cents || 0),
      tax_cents: Number(project.tax_cents || 0),
      final_total_cents: total,
      deposit_cents: Number(project.deposit_cents || 0),
      remaining_balance_cents: Number(project.remaining_balance_cents || 0),
      currency: String(project.currency || 'USD'),
    },
  };
}

export function clientFacingPayload(projectId: string, opts: { includeDraft?: boolean } = {}) {
  const pricing = loadPricing(projectId);
  if (!pricing) return null;
  const published = row<{ version: number; snapshot_json: string; status: string; total_cents: number }>(
    `SELECT * FROM proposal_versions WHERE project_id = ? AND status IN ('published','accepted') ORDER BY version DESC LIMIT 1`,
    [projectId],
  );
  const latest = row<{ version: number; snapshot_json: string; status: string; total_cents: number }>(
    `SELECT * FROM proposal_versions WHERE project_id = ? ORDER BY version DESC LIMIT 1`,
    [projectId],
  );
  const snapshot = opts.includeDraft
    ? (latest ? JSON.parse(latest.snapshot_json) : null)
    : (published ? JSON.parse(published.snapshot_json) : null);
  const changeOrders = rows<{ id: string; reason: string; additional_cents: number; status: string; created_at: string; snapshot_json: string }>(
    `SELECT id, reason, additional_cents, status, created_at, snapshot_json FROM change_orders WHERE project_id = ? ORDER BY created_at DESC`,
    [projectId],
  );
  const installments = rows<{ id: string; name: string | null; number: number; amount_cents: number; percent: number | null; milestone: string; due_at: string | null; status: string }>(
    `SELECT id, name, number, amount_cents, percent, milestone, due_at, status FROM installments WHERE project_id = ? ORDER BY number`,
    [projectId],
  );
  const pendingChangeOrders = changeOrders.filter((item) => item.status === 'pending').map((item) => ({
    id: item.id,
    reason: item.reason,
    additional_cents: item.additional_cents,
    status: item.status,
    created_at: item.created_at,
    schedule: JSON.parse(item.snapshot_json).installments || [],
  }));
  const previews = rows<{ id: string; version: number; kind: string; title: string; file_path: string | null; website_path: string | null; revoked: number }>(
    `SELECT id, version, kind, title, file_path, website_path, revoked FROM previews WHERE project_id = ? ORDER BY version, created_at`,
    [projectId],
  ).filter((item) => !item.revoked).map((item) => ({
    id: item.id,
    version: item.version,
    kind: item.kind,
    title: item.title,
    imageUrl: item.file_path ? `/api/portal/preview/${item.id}/file` : null,
    siteUrl: item.website_path ? `/api/portal/preview/${item.id}/site` : null,
  }));
  return {
    company: pricing.project.company_name,
    clientName: pricing.project.contact_name,
    clientTitle: pricing.project.client_title,
    projectName: pricing.project.name,
    status: pricing.project.status,
    proposalStatus: pricing.project.proposal_status,
    proposalAvailable: Boolean(snapshot),
    preview: Boolean(opts.includeDraft),
    requiresLatestAcceptance: Boolean(published && Number(pricing.project.signed_proposal_version || 0) !== Number(published.version) && !pricing.signed),
    currentVersion: published?.version || latest?.version || 0,
    signedVersion: pricing.project.signed_proposal_version,
    proposal: snapshot,
    clientPricingNotes: snapshot?.client_pricing_notes || '',
    currency: snapshot?.currency || pricing.project.currency,
    total_cents: snapshot?.total_cents || Number(pricing.project.price_cents),
    installments: snapshot?.installments || installments,
    deliverables: snapshot?.deliverables || pricing.deliverables,
    paymentOption: snapshot?.payment_option || pricing.project.payment_option,
    expiresAt: snapshot?.proposal_expires_at || pricing.project.proposal_expires_at,
    signed: pricing.signed,
    pendingChangeOrders,
    previews,
    acceptedChangeOrders: changeOrders.filter((item) => item.status === 'accepted').map((item) => ({
      id: item.id,
      reason: item.reason,
      additional_cents: item.additional_cents,
      accepted_at: item.created_at,
    })),
  };
}

function savePricing(projectId: string, pricing: PricingInput, asDraft: boolean) {
  const total = computeTotal(pricing);
  const plan = buildPlan(pricing.payment_option, total, pricing);
  if (!plan.ok && !asDraft) return plan;
  const installments = plan.ok ? plan.installments : pricing.installments;
  const signed = hasSignedAgreement(projectId);
  const current = signedVersion(projectId);

  if (signed) {
    const existingTotal = row<{ price_cents: number }>(`SELECT price_cents FROM projects WHERE id = ?`, [projectId]);
    if (existingTotal && existingTotal.price_cents !== total) {
      return { ok: false as const, message: 'This agreement is already signed. Create a change order for any price change. The signed total cannot be edited in place.' };
    }
    run(`UPDATE projects SET client_pricing_notes = ?, internal_notes = ?, proposal_expires_at = ? WHERE id = ?`, [
      pricing.client_pricing_notes, pricing.internal_notes, pricing.proposal_expires_at, projectId,
    ]);
    return { ok: true as const, total, draft: true, message: 'Signed proposal notes were saved. Price changes require a change order.' };
  }

  run(`UPDATE projects SET
    package_id = ?, name = name, description = description, price_cents = ?, third_party_costs = ?,
    payment_plan_kind = ?, proposal_expires_at = ?, currency = ?, discount_cents = ?, tax_cents = ?,
    additional_services_cents = ?, third_party_cents = ?, deposit_cents = ?, remaining_balance_cents = ?,
    deposit_percent = ?, deposit_mode = ?, payment_option = ?, client_pricing_notes = ?, internal_notes = ?,
    proposal_status = CASE WHEN proposal_status = 'published' THEN proposal_status ELSE 'draft' END
    WHERE id = ?`, [
    pricing.package_id, total, pricing.third_party_expenses.map((item) => `${item.label}: ${formatMoney(item.amount_cents, pricing.currency)}`).join('; '),
    pricing.payment_option, pricing.proposal_expires_at, pricing.currency, pricing.discount_cents, pricing.tax_cents,
    pricing.additional_services_cents, pricing.third_party_cents, installments[0]?.amount_cents || 0,
    total - (installments[0]?.amount_cents || 0), pricing.deposit_percent, pricing.deposit_mode, pricing.payment_option,
    pricing.client_pricing_notes, pricing.internal_notes, projectId,
  ]);
  replaceLineItems(projectId, pricing);
  replaceDeliverables(projectId, pricing.deliverables);
  if (plan.ok) replacePaymentPlan(projectId, pricing, total, plan.installments);

  const previousPublished = row<{ version: number; total_cents: number; status: string }>(
    `SELECT * FROM proposal_versions WHERE project_id = ? AND status IN ('published','accepted') ORDER BY version DESC LIMIT 1`,
    [projectId],
  );
  const nextVersion = (current?.current_proposal_version || 0) + (asDraft ? 0 : 0);
  const snap = JSON.stringify(snapshotOf(projectId, pricing, total, installments));
  const existingDraft = row<{ id: string; version: number }>(`SELECT id, version FROM proposal_versions WHERE project_id = ? AND status = 'draft' ORDER BY version DESC LIMIT 1`, [projectId]);
  if (existingDraft) {
    run(`UPDATE proposal_versions SET snapshot_json = ?, total_cents = ?, created_at = ? WHERE id = ?`, [snap, total, nowIso(), existingDraft.id]);
  } else {
    const version = (row<{ v: number }>(`SELECT IFNULL(MAX(version), 0) as v FROM proposal_versions WHERE project_id = ?`, [projectId])?.v || 0) + 1;
    run(`INSERT INTO proposal_versions (id, project_id, version, status, total_cents, snapshot_json, created_at, published_at) VALUES (?, ?, ?, 'draft', ?, ?, ?, NULL)`, [
      id('prp_'), projectId, version, total, snap, nowIso(),
    ]);
    run(`UPDATE projects SET current_proposal_version = ? WHERE id = ?`, [version, projectId]);
  }
  void previousPublished;
  void nextVersion;
  audit(projectId, 'admin', 'pricing_draft_saved', { total });
  return { ok: true as const, total, draft: true };
}

function issueLink(projectId: string, expiresAt: string | null) {
  const token = randomToken();
  run(`INSERT INTO portal_access_tokens (id, project_id, token_hash, expires_at, require_verification, created_at, token_cipher, last4) VALUES (?, ?, ?, ?, 0, ?, ?, ?)`, [
    id('tok_'), projectId, sha256(token), expiresAt, nowIso(), encryptSecret(token), token.slice(-4),
  ]);
  audit(projectId, 'admin', 'portal_link_generated', { expiresAt, last4: token.slice(-4) });
  return {
    token,
    last4: token.slice(-4),
    expiresAt,
    url: clientPortalUrl(token),
    publicUrl: publicClientUrl(token),
  };
}

function activeLinks(projectId: string) {
  return rows<{ id: string; expires_at: string | null; revoked_at: string | null; created_at: string; token_cipher: string | null; last4: string | null }>(
    `SELECT id, expires_at, revoked_at, created_at, token_cipher, last4 FROM portal_access_tokens WHERE project_id = ? ORDER BY created_at DESC`,
    [projectId],
  ).map((item) => {
    const token = decryptSecret(item.token_cipher);
    const expired = item.expires_at ? new Date(item.expires_at).getTime() < Date.now() : false;
    const revoked = Boolean(item.revoked_at);
    return {
      id: item.id,
      last4: item.last4,
      created_at: item.created_at,
      expires_at: item.expires_at,
      revoked_at: item.revoked_at,
      status: revoked ? 'revoked' : expired ? 'expired' : 'active',
      url: token && !revoked && !expired ? clientPortalUrl(token) : null,
      publicUrl: token && !revoked && !expired ? publicClientUrl(token) : null,
    };
  });
}

export function registerPricingRoutes(app: Hono) {
  app.get('/api/admin/packages', (c) => {
    if (!requireAdmin(c)) return c.json({ ok: false }, 401);
    return c.json({ ok: true, packages: PACKAGE_PRESETS });
  });

  app.post('/api/admin/clients', async (c) => {
    if (!requireAdmin(c)) return c.json({ ok: false }, 401);
    const body = parseBody<{
      company_name?: string; contact_name?: string; email?: string; title?: string; project_name?: string; package_id?: string;
    }>(await c.req.json());
    if (!body.company_name?.trim() || !body.contact_name?.trim() || !body.email?.trim() || !body.project_name?.trim()) {
      return c.json({ ok: false, message: 'Company, contact, email, and project name are required.' }, 400);
    }
    const preset = defaultPricingFromPreset(body.package_id || 'pkg_custom');
    const clientId = id('cli_');
    const projectId = id('prj_');
    const created = nowIso();
    run(`INSERT INTO clients (id, company_name, contact_name, email, title, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [
      clientId, body.company_name.trim(), body.contact_name.trim(), body.email.trim().toLowerCase(), body.title || '', created,
    ]);
    run(`INSERT INTO projects (id, client_id, package_id, name, status, description, pages, revisions_included, timeline, client_responsibilities, bbls_responsibilities, price_cents, third_party_costs, payment_plan_kind, proposal_expires_at, created_at, currency, discount_cents, tax_cents, additional_services_cents, third_party_cents, deposit_cents, remaining_balance_cents, deposit_percent, deposit_mode, payment_option, client_pricing_notes, internal_notes, proposal_status, current_proposal_version) VALUES (?, ?, ?, ?, 'draft', ?, 1, 2, 'Timeline confirmed after scope is approved.', 'Provide content, access, and timely feedback.', 'Coordinate the agreed brand, website, and launch work.', ?, '', 'two', ?, ?, 'USD', 0, 0, 0, 0, ?, ?, 50, 'percent', 'two', ?, '', 'draft', 0)`, [
      projectId, clientId, preset.package_id, body.project_name.trim(), preset.client_pricing_notes || PACKAGE_PRESETS.find((item) => item.id === preset.package_id)?.description || '',
      preset.base_price_cents, preset.proposal_expires_at, created, Math.round(preset.base_price_cents * 0.5), Math.round(preset.base_price_cents * 0.5), preset.client_pricing_notes,
    ]);
    const agreement = JSON.stringify({ notice: AGREEMENT_NOTICE, sections: agreementSections() });
    run(`INSERT INTO agreement_versions (id, project_id, version, title, body_json, content_hash, legal_status, created_at) VALUES (?, ?, 1, 'BBLS Service Agreement (template)', ?, ?, 'template_requires_attorney_review', ?)`, [
      id('agr_'), projectId, agreement, sha256(agreement), created,
    ]);
    savePricing(projectId, preset, true);
    const link = issueLink(projectId, preset.proposal_expires_at);
    audit(projectId, 'admin', 'client_project_created', { company: body.company_name });
    return c.json({ ok: true, clientId, projectId, pricingUrl: `/admin/projects/${projectId}/pricing`, link });
  });

  app.get('/api/admin/projects/:id/pricing', (c) => {
    if (!requireAdmin(c)) return c.json({ ok: false }, 401);
    const pricing = loadPricing(c.req.param('id'));
    if (!pricing) return c.json({ ok: false }, 404);
    return c.json({ ok: true, ...pricing, links: activeLinks(c.req.param('id')), origin: appOrigin() });
  });

  app.put('/api/admin/projects/:id/pricing', async (c) => {
    if (!requireAdmin(c)) return c.json({ ok: false }, 401);
    const projectId = c.req.param('id');
    if (!row(`SELECT id FROM projects WHERE id = ?`, [projectId])) return c.json({ ok: false }, 404);
    const pricing = asPricing(projectId, await c.req.json());
    const saved = savePricing(projectId, pricing, true);
    if (!saved.ok) return c.json(saved, 400);
    return c.json({ ok: true, total: saved.total, draft: saved.draft, message: 'message' in saved ? saved.message : undefined, pricing: loadPricing(projectId) });
  });

  app.post('/api/admin/projects/:id/pricing/publish', async (c) => {
    if (!requireAdmin(c)) return c.json({ ok: false }, 401);
    const projectId = c.req.param('id');
    if (hasSignedAgreement(projectId)) {
      return c.json({ ok: false, message: 'The signed agreement cannot be replaced. Create a change order for additional work or a new total.' }, 400);
    }
    const pricing = asPricing(projectId, await c.req.json());
    const total = computeTotal(pricing);
    const plan = buildPlan(pricing.payment_option, total, pricing);
    if (!plan.ok) return c.json(plan, 400);
    const saved = savePricing(projectId, pricing, true);
    if (!saved.ok) return c.json(saved, 400);
    const draft = row<{ id: string; version: number; total_cents: number; snapshot_json: string }>(`SELECT * FROM proposal_versions WHERE project_id = ? AND status = 'draft' ORDER BY version DESC LIMIT 1`, [projectId]);
    if (!draft) return c.json({ ok: false, message: 'Save a draft before publishing.' }, 400);
    run(`UPDATE proposal_versions SET status = 'superseded' WHERE project_id = ? AND status = 'published'`, [projectId]);
    run(`UPDATE proposal_versions SET status = 'published', published_at = ?, total_cents = ?, snapshot_json = ? WHERE id = ?`, [
      nowIso(), total, JSON.stringify(snapshotOf(projectId, pricing, total, plan.installments)), draft.id,
    ]);
    run(`UPDATE projects SET proposal_status = 'published', status = 'proposal_ready', current_proposal_version = ?, price_cents = ? WHERE id = ?`, [
      draft.version, total, projectId,
    ]);
    audit(projectId, 'admin', 'proposal_published', { version: draft.version, total });
    const client = row<{ contact_name: string; email: string; name: string }>(`SELECT c.contact_name, c.email, p.name FROM clients c JOIN projects p ON p.client_id = c.id WHERE p.id = ?`, [projectId]);
    return c.json({ ok: true, version: draft.version, total, formatted: formatMoney(total, pricing.currency), clientEmail: client?.email || null });
  });

  app.get('/api/admin/projects/:id/client-preview', (c) => {
    if (!requireAdmin(c)) return c.json({ ok: false }, 401);
    const payload = clientFacingPayload(c.req.param('id'), { includeDraft: true });
    if (!payload) return c.json({ ok: false }, 404);
    audit(c.req.param('id'), 'admin', 'client_preview_opened', { changedStatus: false, notified: false });
    return c.json({ ok: true, ...payload });
  });

  app.get('/api/admin/projects/:id/links', (c) => {
    if (!requireAdmin(c)) return c.json({ ok: false }, 401);
    return c.json({ ok: true, links: activeLinks(c.req.param('id')) });
  });

  app.post('/api/admin/projects/:id/link', async (c) => {
    if (!requireAdmin(c)) return c.json({ ok: false }, 401);
    const body = parseBody<{ expiresAt?: string; days?: number }>(await c.req.json().catch(() => ({})));
    const expiresAt = body.expiresAt || new Date(Date.now() + (body.days || 21) * 86400000).toISOString();
    const link = issueLink(c.req.param('id'), expiresAt);
    return c.json({ ok: true, link });
  });

  app.post('/api/admin/projects/:id/link/regenerate', async (c) => {
    if (!requireAdmin(c)) return c.json({ ok: false }, 401);
    const projectId = c.req.param('id');
    const body = parseBody<{ expiresAt?: string }>(await c.req.json().catch(() => ({})));
    run(`UPDATE portal_access_tokens SET revoked_at = ? WHERE project_id = ? AND revoked_at IS NULL`, [nowIso(), projectId]);
    const current = row<{ proposal_expires_at: string | null }>(`SELECT proposal_expires_at FROM projects WHERE id = ?`, [projectId]);
    const link = issueLink(projectId, body.expiresAt || current?.proposal_expires_at || new Date(Date.now() + 21 * 86400000).toISOString());
    audit(projectId, 'admin', 'portal_link_regenerated', { last4: link.last4 });
    return c.json({ ok: true, link });
  });

  app.patch('/api/admin/projects/:id/link', async (c) => {
    if (!requireAdmin(c)) return c.json({ ok: false }, 401);
    const { tokenId, expiresAt } = parseBody<{ tokenId?: string; expiresAt?: string }>(await c.req.json());
    if (!expiresAt) return c.json({ ok: false, message: 'Choose an expiration date.' }, 400);
    const target = tokenId
      ? tokenId
      : row<{ id: string }>(`SELECT id FROM portal_access_tokens WHERE project_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`, [c.req.param('id')])?.id;
    if (!target) return c.json({ ok: false, message: 'Generate a private link first.' }, 400);
    run(`UPDATE portal_access_tokens SET expires_at = ? WHERE id = ? AND project_id = ?`, [expiresAt, target, c.req.param('id')]);
    audit(c.req.param('id'), 'admin', 'portal_link_expiration_updated', { tokenId: target, expiresAt });
    return c.json({ ok: true, expiresAt, links: activeLinks(c.req.param('id')) });
  });

  app.post('/api/admin/projects/:id/invite', async (c) => {
    if (!requireAdmin(c)) return c.json({ ok: false }, 401);
    const projectId = c.req.param('id');
    const client = row<{ contact_name: string; email: string; name: string }>(`SELECT c.contact_name, c.email, p.name FROM clients c JOIN projects p ON p.client_id = c.id WHERE p.id = ?`, [projectId]);
    if (!client) return c.json({ ok: false }, 404);
    const latest = activeLinks(projectId).find((item) => item.status === 'active');
    if (!latest?.url) return c.json({ ok: false, message: 'Generate a private link before sending an invitation.' }, 400);
    portalEmail({
      template: 'portal_invitation',
      to: client.email,
      clientName: client.contact_name,
      projectName: client.name,
      action: 'Open your private BBLS portal',
      portalPath: latest.url.replace(appOrigin(), ''),
      extra: 'This is a logged local invitation. No real email is sent in development.',
    });
    audit(projectId, 'admin', 'invitation_logged', { to: client.email, sent: false, mode: 'log' });
    return c.json({ ok: true, loggedTo: client.email, sent: false, mode: 'log' });
  });

  app.post('/api/admin/projects/:id/change-orders', async (c) => {
    if (!requireAdmin(c)) return c.json({ ok: false }, 401);
    const projectId = c.req.param('id');
    if (!hasSignedAgreement(projectId)) {
      return c.json({ ok: false, message: 'Change orders are used after a client signs. Update and publish a new proposal version instead.' }, 400);
    }
    const body = parseBody<{ reason?: string; additional_cents?: number; installments?: PricingInput['installments'] }>(await c.req.json());
    if (!body.reason?.trim() || !Number(body.additional_cents)) {
      return c.json({ ok: false, message: 'A change order needs a reason and an additional amount.' }, 400);
    }
    const current = row<{ price_cents: number; currency: string }>(`SELECT price_cents, currency FROM projects WHERE id = ?`, [projectId]);
    const additional = Math.round(Number(body.additional_cents));
    const newTotal = Number(current?.price_cents || 0) + additional;
    const schedule = Array.isArray(body.installments) && body.installments.length
      ? body.installments
      : [{ name: 'Change order', amount_cents: additional, percent: null, due_at: null, milestone: body.reason.trim(), status: 'pending_acceptance' }];
    const extraSum = schedule.reduce((sum, item) => sum + Number(item.amount_cents || 0), 0);
    if (extraSum !== additional) {
      return c.json({ ok: false, message: 'Change-order installments must equal the additional amount.' }, 400);
    }
    run(`INSERT INTO change_orders (id, project_id, reason, additional_cents, snapshot_json, status, created_at, accepted_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL)`, [
      id('cho_'), projectId, body.reason.trim(), additional, JSON.stringify({ newTotal, installments: schedule, previousTotal: current?.price_cents }), nowIso(),
    ]);
    audit(projectId, 'admin', 'change_order_created', { additional });
    return c.json({ ok: true, additional_cents: additional, formatted: formatMoney(additional, current?.currency || 'USD') });
  });
}

export { activeLinks, issueLink };
