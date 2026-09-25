import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGREEMENT_NOTICE, agreementSections } from './agreement-template';
import { encryptSecret, hashPassword, id, nowIso, randomToken, sha256 } from './crypto';
import { db, migrate, paths, row, run } from './db';
import { portalEmail } from './email';
import { seedLeadsIfNeeded } from './leads';

function insert(table: string, data: Record<string, unknown>) {
  const keys = Object.keys(data);
  run(
    `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
    keys.map((key) => data[key]),
  );
}

function syncAdminPassword() {
  const email = (process.env.ADMIN_EMAIL || 'admin@bbls.studio').toLowerCase();
  const password = process.env.ADMIN_PASSWORD || 'S@f@1371';
  const admin = row<{ id: string }>(`SELECT id FROM admin_users WHERE email = ?`, [email]);
  if (admin) {
    run(`UPDATE admin_users SET password_hash = ? WHERE id = ?`, [hashPassword(password), admin.id]);
  }
}

export function seedIfNeeded() {
  migrate();
  seedLeadsIfNeeded();
  if (row<{ c: number }>('SELECT COUNT(*) as c FROM admin_users')?.c) {
    syncAdminPassword();
    return loadLocalAccess();
  }

  const created = nowIso();
  const adminId = id('adm_');
  insert('admin_users', {
    id: adminId,
    email: (process.env.ADMIN_EMAIL || 'admin@bbls.studio').toLowerCase(),
    password_hash: hashPassword(process.env.ADMIN_PASSWORD || 'S@f@1371'),
    name: process.env.ADMIN_NAME || 'BBLS Studio',
    created_at: created,
  });

  const packages = [
    ['pkg_landing', 'Commercial Landing Page', 300000, 'A conversion focused single page for a defined offer.', 0, '$3,000+'],
    ['pkg_brand', 'Brand Identity', 350000, 'A usable identity system for a founder-led business.', 0, '$3,500+'],
    ['pkg_website', 'Commercial Website', 550000, 'A custom responsive website ready to take inquiries.', 0, '$5,500+'],
    ['pkg_premium', 'Premium Brand + Website', 850000, 'Brand identity and website planned as one engagement.', 0, '$8,500+'],
    ['pkg_essential', 'Essential Care', 35000, 'Monthly maintenance for small websites after launch.', 1, '$350/month'],
    ['pkg_growth_care', 'Growth Care', 65000, 'Monthly updates and optimization for active businesses.', 1, '$650/month'],
    ['pkg_priority', 'Priority Care', 95000, 'Faster monthly support for commercial websites.', 1, '$950/month'],
    ['pkg_custom', 'Custom Project', 0, 'Manually entered price and deliverables.', 0, 'Manually entered price'],
  ] as const;
  for (const [idValue, name, price, description, monthly, priceLabel] of packages) {
    insert('packages', { id: idValue, name, starting_price_cents: price, description, monthly, price_label: priceLabel, deliverables_json: '[]' });
  }

  const clientId = process.env.PORTAL_TEST_CLIENT_ID || (process.env.VERCEL ? 'cli_3tYcH6jF1aD5uB0e' : id('cli_'));
  insert('clients', {
    id: clientId,
    company_name: 'Northshore Botanica',
    contact_name: 'Elena Voss',
    email: 'elena@northshore-botanica.example',
    title: 'Founder',
    created_at: created,
  });

  const projectId = process.env.PORTAL_TEST_PROJECT_ID || (process.env.VERCEL ? 'prj_7mKq9pR2xW4nV8sL' : id('prj_'));
  const expires = new Date(Date.now() + 21 * 86400000).toISOString();
  insert('projects', {
    id: projectId,
    client_id: clientId,
    package_id: 'pkg_website',
    name: 'Northshore Botanica Brand & Website Launch',
    status: 'proposal_ready',
    description: 'A fictional sample engagement for a founder-led botanicals studio ready to launch a five-page website, mini-to-expanded identity, and booking inquiry flow.',
    pages: 5,
    revisions_included: 2,
    timeline: 'Streamlined launch target of 14 days if content, access, and approvals are ready; otherwise 2 to 4 weeks.',
    client_responsibilities: 'Provide brand notes, product photos if available, offer details, and timely feedback.',
    bbls_responsibilities: 'Coordinate brand direction, website design, launch copy, and a practical booking or inquiry setup.',
    price_cents: 390000,
    third_party_costs: 'Domain, hosting, and booking-tool subscriptions billed separately when required.',
    payment_plan_kind: 'two',
    proposal_expires_at: expires,
    created_at: created,
    currency: 'USD',
    discount_cents: 0,
    tax_cents: 0,
    additional_services_cents: 40000,
    third_party_cents: 0,
    deposit_cents: 195000,
    remaining_balance_cents: 195000,
    deposit_percent: 50,
    deposit_mode: 'percent',
    payment_option: 'two',
    client_pricing_notes: 'Commercial Website with launch copy polish. 50% deposit, 50% before final release.',
    internal_notes: 'Fictional sample only. Do not treat as a live client.',
    proposal_status: 'published',
    current_proposal_version: 1,
  });

  const deliverables = [
    ['Brand direction and expanded identity'],
    ['Five-page custom website'],
    ['Launch copy'],
    ['Inquiry / booking setup'],
    ['Launch checklist and technical handoff'],
  ];
  for (const [label] of deliverables) {
    insert('deliverables', { id: id('del_'), project_id: projectId, label, description: label });
  }

  insert('line_items', { id: id('li_'), project_id: projectId, label: 'Commercial Website', amount_cents: 550000, kind: 'included', selected: 1 });
  insert('line_items', { id: id('li_'), project_id: projectId, label: 'Launch copy polish', amount_cents: 40000, kind: 'addon', selected: 1 });

  const body = agreementSections();
  const content = JSON.stringify({ notice: AGREEMENT_NOTICE, sections: body });
  insert('agreement_versions', {
    id: id('agr_'),
    project_id: projectId,
    version: 1,
    title: 'BBLS Service Agreement (template)',
    body_json: content,
    content_hash: sha256(content),
    legal_status: 'template_requires_attorney_review',
    created_at: created,
  });

  const fullPlan = id('plan_');
  const splitPlan = id('plan_');
  const simplePlan = id('plan_');
  const refund = 'PLACEHOLDER: Refundability language must be attorney-reviewed before production use. For this local sample, payments are marked non-refundable after processor confirmation unless BBLS agrees otherwise in writing.';
  insert('payment_plans', { id: fullPlan, project_id: projectId, name: 'Pay in full', kind: 'full', refund_language: refund });
  insert('payment_plans', { id: splitPlan, project_id: projectId, name: 'Three-part split', kind: 'split', refund_language: refund });
  insert('payment_plans', { id: simplePlan, project_id: projectId, name: 'Two-part split', kind: 'split', refund_language: refund });
  insert('installments', { id: id('ins_'), payment_plan_id: fullPlan, project_id: projectId, number: 1, amount_cents: 390000, milestone: 'Pay in full to begin', due_at: created, status: 'due', stripe_checkout_id: null, checkout_expires_at: null, paid_at: null });
  insert('installments', { id: id('ins_'), payment_plan_id: splitPlan, project_id: projectId, number: 1, amount_cents: 195000, milestone: '50% deposit to begin', due_at: created, status: 'due', stripe_checkout_id: null, checkout_expires_at: null, paid_at: null });
  insert('installments', { id: id('ins_'), payment_plan_id: splitPlan, project_id: projectId, number: 2, amount_cents: 97500, milestone: '25% at first design preview', due_at: null, status: 'due', stripe_checkout_id: null, checkout_expires_at: null, paid_at: null });
  insert('installments', { id: id('ins_'), payment_plan_id: splitPlan, project_id: projectId, number: 3, amount_cents: 97500, milestone: '25% before final release', due_at: null, status: 'due', stripe_checkout_id: null, checkout_expires_at: null, paid_at: null });
  insert('installments', { id: id('ins_'), payment_plan_id: simplePlan, project_id: projectId, number: 1, amount_cents: 195000, milestone: '50% deposit', due_at: created, status: 'due', stripe_checkout_id: null, checkout_expires_at: null, paid_at: null });
  insert('installments', { id: id('ins_'), payment_plan_id: simplePlan, project_id: projectId, number: 2, amount_cents: 195000, milestone: '50% before final release', due_at: null, status: 'due', stripe_checkout_id: null, checkout_expires_at: null, paid_at: null });

  mkdirSync(join(paths.uploads, projectId), { recursive: true });
  const previewSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="750" viewBox="0 0 1200 750"><rect width="1200" height="750" fill="#141414"/><text x="80" y="120" fill="#d4b483" font-size="22" font-family="Inter,sans-serif">NORTHSHORE BOTANICA</text><text x="80" y="190" fill="#ffffff" font-size="48" font-family="Inter,sans-serif">Quiet luxury for modern botanicals.</text><text x="80" y="250" fill="#c8c8c8" font-size="20" font-family="Inter,sans-serif">Fictional sample homepage preview · not approved for public use</text><rect x="80" y="320" width="220" height="48" rx="24" fill="#ffffff"/></svg>`;
  const previewPath = join(paths.uploads, `${projectId}/preview-v1.svg`);
  writeFileSync(previewPath, previewSvg);
  const sitePath = join(paths.uploads, `${projectId}/site-v1.html`);
  writeFileSync(sitePath, `<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>Private Client Preview</title><style>body{margin:0;background:#0a0a0a;color:#fff;font-family:Inter,sans-serif;padding:4rem}em{color:#d4b483}</style></head><body><p>Private client website preview</p><h1>Northshore Botanica</h1><p>Fictional five-page starter layout. Not approved for public or commercial use.</p></body></html>`);
  insert('previews', { id: id('prv_'), project_id: projectId, version: 1, kind: 'image', title: 'Homepage design preview', file_path: previewPath, website_path: null, revoked: 0, created_at: created });
  insert('previews', { id: id('prv_'), project_id: projectId, version: 1, kind: 'website', title: 'Private website preview', file_path: null, website_path: sitePath, revoked: 0, created_at: created });

  const lockedPath = join(paths.uploads, `${projectId}/final-brand-notes.txt`);
  writeFileSync(lockedPath, 'Fictional final brand notes. Locked until BBLS releases files.');
  insert('file_releases', { id: id('rel_'), project_id: projectId, deliverable_id: null, file_path: lockedPath, label: 'Final brand notes', released_at: null, released_by: null });

  const snapshot = {
    projectId,
    package_name: 'Commercial Website',
    currency: 'USD',
    base_price_cents: 550000,
    discount_cents: 0,
    additional_services: [{ label: 'Launch copy polish', amount_cents: 40000 }],
    third_party_expenses: [],
    tax_cents: 0,
    total_cents: 390000,
    payment_option: 'two',
    installments: [
      { name: 'Deposit', amount_cents: 195000, percent: 50, due_at: created, milestone: '50% deposit', status: 'due' },
      { name: 'Remaining balance', amount_cents: 195000, percent: 50, due_at: null, milestone: '50% before final release', status: 'due' },
    ],
    deliverables: deliverables.map(([label]) => label),
    client_pricing_notes: 'Commercial Website with launch copy polish. 50% deposit, 50% before final release.',
    proposal_expires_at: expires,
  };
  insert('proposal_versions', {
    id: id('prp_'),
    project_id: projectId,
    version: 1,
    status: 'published',
    total_cents: 390000,
    snapshot_json: JSON.stringify(snapshot),
    created_at: created,
    published_at: created,
  });

  const activeToken = process.env.PORTAL_TEST_TOKEN || (process.env.VERCEL ? 'K8n2vQ4wR7xL1mP9sT3yC6hJ0aF5dB2uEwNXcV7MfSOdOK3' : randomToken());
  const expiredToken = randomToken();
  const revokedToken = randomToken();
  insert('portal_access_tokens', { id: id('tok_'), project_id: projectId, token_hash: sha256(activeToken), expires_at: expires, revoked_at: null, require_verification: 0, created_at: created, token_cipher: encryptSecret(activeToken), last4: activeToken.slice(-4) });
  insert('portal_access_tokens', { id: id('tok_'), project_id: projectId, token_hash: sha256(expiredToken), expires_at: new Date(Date.now() - 86400000).toISOString(), revoked_at: null, require_verification: 0, created_at: created, token_cipher: encryptSecret(expiredToken), last4: expiredToken.slice(-4) });
  insert('portal_access_tokens', { id: id('tok_'), project_id: projectId, token_hash: sha256(revokedToken), expires_at: expires, revoked_at: created, require_verification: 0, created_at: created, token_cipher: encryptSecret(revokedToken), last4: revokedToken.slice(-4) });

  insert('audit_events', { id: id('aud_'), project_id: projectId, actor: 'system', action: 'seeded_sample_project', meta_json: JSON.stringify({ fictional: true }), created_at: created });

  const origin = process.env.APP_ORIGIN || 'http://127.0.0.1:4173';
  const access = {
    active: `${origin}/client/${activeToken}`,
    expired: `${origin}/client/${expiredToken}`,
    revoked: `${origin}/client/${revokedToken}`,
    admin: `${origin}/admin`,
    adminEmail: process.env.ADMIN_EMAIL || 'admin@bbls.studio',
    adminPassword: process.env.ADMIN_PASSWORD || 'S@f@1371',
    expiresAt: expires,
    note: 'Fictional sample only. Tokens are shown once in this local file. No real email is sent.',
  };
  try {
    mkdirSync(join(paths.root, 'data'), { recursive: true });
    writeFileSync(join(paths.root, 'data/local-access.json'), JSON.stringify(access, null, 2));
  } catch {
    // Read-only hosts such as Vercel skip the local file.
  }
  portalEmail({
    template: 'portal_invitation',
    to: 'elena@northshore-botanica.example',
    clientName: 'Elena Voss',
    projectName: 'Northshore Botanica Brand & Website Launch',
    action: 'Review the private proposal',
    portalPath: `/client/${activeToken}`,
  });
  console.log('\nBBLS portal sample links written to data/local-access.json\n', access);
  return access;
}

export function loadLocalAccess() {
  try {
    return JSON.parse(readFileSync(join(paths.root, 'data/local-access.json'), 'utf8'));
  } catch {
    return null;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seedIfNeeded();
  db.close();
}
