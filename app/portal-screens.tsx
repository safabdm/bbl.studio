import { FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import './portal.css';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { BblWordmark } from '../components/bbl-mark';
import { PACKAGE_PRESETS } from '../server/packages';
import { api, money, usePrivateIndexing } from '../lib/portal';

type PreviewRecord = { id: string; title: string; kind: string; version: number; imageUrl?: string | null; siteUrl?: string | null };
type LinkRecord = { id: string; last4?: string; status: string; expires_at: string | null; url?: string | null; publicUrl?: string | null };

async function sharePreviewLink(url: string) {
  try {
    if (navigator.share) {
      await navigator.share({ title: 'BBL private preview', text: 'Open this private BBL preview. Do not forward it.', url });
      return 'Preview link opened in share sheet.';
    }
  } catch {
    // User cancelled native share; fall through to copy.
  }
  await navigator.clipboard.writeText(url);
  return `Preview link copied: ${url}`;
}
const PLAN_LABELS: Record<string, string> = {
  full: 'Paid in full before work begins',
  two: 'Deposit, then remaining balance',
  three: 'Three payments (50 / 25 / 25)',
  custom: 'Custom schedule',
};

function asCell(value: unknown, fallback = '—') {
  if (value == null) return fallback;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function humanize(value: unknown) {
  const text = asCell(value, '').replace(/_/g, ' ').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '—';
}

function fmtDay(value: unknown) {
  if (!value) return 'Not set';
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? 'Not set' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Dollar input bound to a cents value. */
function MoneyField({ id, label, cents, onChange, hint }: { id: string; label: string; cents: number; onChange: (cents: number) => void; hint?: string }) {
  return (
    <div className="portal-field">
      <label htmlFor={id}>{label}</label>
      <div className="portal-money">
        <input
          id={id}
          type="number"
          min="0"
          step="0.01"
          inputMode="decimal"
          value={Number.isFinite(cents) ? cents / 100 : 0}
          onChange={(event) => onChange(Math.round(Number(event.target.value || 0) * 100))}
        />
      </div>
      {hint ? <span className="portal-hint">{hint}</span> : null}
    </div>
  );
}

type Installment = { id?: string; name?: string; amount_cents: number; percent?: number | null; milestone: string; due_at?: string | null; status?: string };
type PricingState = {
  project: Record<string, unknown>;
  packages: { id: string; name: string; starting_price_cents: number; price_label: string; deliverables: string[] }[];
  deliverables: string[];
  additional_services: { label: string; amount_cents: number }[];
  third_party_expenses: { label: string; amount_cents: number }[];
  installments: Installment[];
  signed: boolean;
  links: LinkRecord[];
  changeOrders: { id: string; reason: string; additional_cents: number; status: string }[];
};

/**
 * Admin project pages render inside CrmShell (shared left CRM sidebar).
 * No duplicate top nav — back links live in-page when needed.
 */
function AdminPortalBody({ title, children, back }: { title: string; children: ReactNode; back?: string }) {
  usePrivateIndexing(title);
  return (
    <div className="crm-portal-body">
      {back ? (
        <p className="crm-portal-back">
          <Link to={back} className="crm-link">← Back</Link>
        </p>
      ) : null}
      {children}
    </div>
  );
}

export function AdminLogin() {
  const navigate = useNavigate();
  const [error, setError] = useState('');
  usePrivateIndexing('BBL Admin');
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api('/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({
          email: String(form.get('email') || ''),
          password: String(form.get('password') || ''),
        }),
      });
      navigate('/admin');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in. Check the admin email and studio password.');
    }
  }
  return (
    <div className="portal-shell">
      <div className="portal-login">
        <div className="brand"><BblWordmark height={26} variant="black" /></div>
        <h1>Sign in</h1>
        <p className="portal-lead">CRM, projects and private client links.</p>
        <form className="portal-card" onSubmit={onSubmit}>
          <div className="portal-field">
            <label htmlFor="admin-email">Email</label>
            <input id="admin-email" name="email" type="email" autoComplete="username" defaultValue="hello@bbl.studio" required />
          </div>
          <div className="portal-field">
            <label htmlFor="admin-password">Password</label>
            <input id="admin-password" name="password" type="password" autoComplete="current-password" required />
          </div>
          {error ? <p className="portal-error" role="alert">{error}</p> : null}
          <div className="portal-actions">
            <button className="solid-pill" type="submit">Sign in</button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function RequireAdmin({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api('/api/admin/me')
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch(() => {
        window.location.replace('/admin/login');
      });
    return () => {
      cancelled = true;
    };
  }, []);
  if (!ready) return null;
  return children;
}

export function AdminHome() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Record<string, unknown>[]>([]);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [showForm, setShowForm] = useState(true);
  usePrivateIndexing('BBL Client Portal');

  useEffect(() => {
    api<{ projects: Record<string, unknown>[] }>('/api/admin/projects')
      .then((data) => setProjects(data.projects || []))
      .catch(() => window.location.replace('/admin/login'));
  }, [navigate]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((project) => {
      const hay = [
        project.company_name,
        project.name,
        project.package_name,
        project.contact_name,
        project.email,
        project.status,
      ]
        .map((v) => asCell(v, '').toLowerCase())
        .join(' ');
      return hay.includes(q);
    });
  }, [projects, query]);

  async function createClient(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const created = await api<{ projectId: string }>('/api/admin/clients', {
        method: 'POST',
        body: JSON.stringify({
          company_name: form.get('company_name'),
          contact_name: form.get('contact_name'),
          email: form.get('email'),
          title: form.get('title'),
          project_name: form.get('project_name'),
          package_id: form.get('package_id'),
        }),
      });
      navigate(`/admin/projects/${created.projectId}/pricing`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create client.');
    }
  }

  return (
    <AdminPortalBody title="BBL Client Portal">
      <div className="crm-page-head">
        <div>
          <p className="crm-kicker">Studio</p>
          <h1>Client Portal</h1>
          <p className="crm-lead">Manage clients, projects, and proposals from one place.</p>
        </div>
      </div>

      <div className="crm-toolbar">
        <div className="crm-filters">
          <input
            type="search"
            placeholder="Search clients or projects…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search clients or projects"
          />
        </div>
        <button className="crm-btn" type="button" onClick={() => setShowForm(true)}>
          New Client
        </button>
      </div>

      <div className="crm-grid-2 crm-portal-layout">
        <section className="crm-panel">
          <div className="crm-panel-head">
            <h2>Projects <span className="crm-count">{filtered.length}</span></h2>
          </div>
          {filtered.length ? (
            <div className="crm-table-wrap flush">
              <table className="crm-table">
                <thead>
                  <tr>
                    <th>Client</th>
                    <th>Project</th>
                    <th>Package</th>
                    <th>Status</th>
                    <th>Last updated</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((project) => (
                    <tr key={asCell(project.id, '')}>
                      <td>{asCell(project.company_name)}</td>
                      <td>{asCell(project.name)}</td>
                      <td>{asCell(project.package_name)}</td>
                      <td><span className="crm-pill muted">{humanize(project.status)}</span></td>
                      <td className="crm-col-date">{fmtDay(project.updated_at || project.created_at)}</td>
                      <td>
                        <Link className="crm-btn-secondary" to={`/admin/projects/${asCell(project.id, '')}`}>Open</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="crm-muted crm-pad">
              {projects.length ? 'No projects match this search.' : 'No projects yet. Create the first client on the right.'}
            </p>
          )}
        </section>

        {showForm ? (
          <form className="crm-panel" onSubmit={createClient}>
            <div className="crm-panel-head">
              <h2>New Client</h2>
            </div>
            <div className="crm-field"><label htmlFor="company_name">Company</label><input id="company_name" name="company_name" required /></div>
            <div className="crm-field-row">
              <div className="crm-field"><label htmlFor="contact_name">Contact name</label><input id="contact_name" name="contact_name" required /></div>
              <div className="crm-field"><label htmlFor="title">Title</label><input id="title" name="title" /></div>
            </div>
            <div className="crm-field"><label htmlFor="email">Email</label><input id="email" name="email" type="email" required /></div>
            <div className="crm-field"><label htmlFor="project_name">Project name</label><input id="project_name" name="project_name" required /></div>
            <div className="crm-field">
              <label htmlFor="package_id">Package</label>
              <select id="package_id" name="package_id" defaultValue="pkg_website">
                {PACKAGE_PRESETS.filter((item) => item.id !== 'pkg_custom').map((item) => (
                  <option key={item.id} value={item.id}>{item.name}. {item.price_label}</option>
                ))}
                <option value="pkg_custom">Custom Project</option>
              </select>
            </div>
            {error ? <p className="crm-error" role="alert">{error}</p> : null}
            <div className="crm-actions">
              <button className="crm-btn" type="submit">Create and set pricing →</button>
            </div>
          </form>
        ) : null}
      </div>
    </AdminPortalBody>
  );
}

export function AdminProject() {
  const { projectId = '' } = useParams();
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [message, setMessage] = useState('');
  const [expires, setExpires] = useState('');
  const navigate = useNavigate();
  const project = data?.project as Record<string, unknown> | undefined;
  const links = (data?.links as LinkRecord[]) || [];
  const active = links.find((item) => item.status === 'active');

  async function reload() {
    const next = await api(`/api/admin/projects/${projectId}`);
    setData(next);
    const nextActive = ((next.links as LinkRecord[]) || []).find((item) => item.status === 'active');
    if (nextActive?.expires_at) setExpires(nextActive.expires_at.slice(0, 10));
  }

  useEffect(() => {
    reload().catch(() => window.location.replace('/admin/login'));
  }, [projectId]);

  async function run(path: string, body: unknown = {}) {
    const result = await api<Record<string, unknown>>(path, { method: 'POST', body: JSON.stringify(body) });
    setMessage(String(result.message || 'Done.'));
    if (result.link && typeof result.link === 'object') {
      const link = result.link as { url?: string };
      if (link.url) await navigator.clipboard.writeText(link.url).catch(() => undefined);
      setMessage(`Private link ready: ${link.url}`);
    }
    await reload();
    return result;
  }

  return (
    <AdminPortalBody title="BBL project" back="/admin/projects">
      <p className="crm-kicker">{String(project?.company_name || 'Project')}</p>
      <h1>{String(project?.name || 'Loading…')}</h1>
      <div className="portal-meta">
        {project?.contact_name ? <span>{String(project.contact_name)}</span> : null}
        {project?.email ? <span>{String(project.email)}</span> : null}
        {project?.status ? <span className="portal-pill">{humanize(project.status)}</span> : null}
      </div>
      {message ? <p className="portal-ok" role="status">{message}</p> : null}
      <div className="portal-grid">
        <section className="portal-card">
          <h2>Private client link</h2>
          <p className="portal-muted">Anyone with this link can open the client view. It doesn't show the client name or project id in the URL.</p>
          <div className="portal-field">
            <label htmlFor="share-link">Link</label>
            <input id="share-link" readOnly value={active?.url || ''} placeholder="No active link yet" onFocus={(event) => event.currentTarget.select()} />
          </div>
          <div className="portal-actions">
            <button
              className="solid-pill"
              type="button"
              onClick={async () => {
                let url = active?.url;
                if (!url) {
                  const created = await run(`/api/admin/projects/${projectId}/link`, { expiresAt: expires ? new Date(`${expires}T23:59:59.000Z`).toISOString() : undefined });
                  url = (created.link as { url?: string } | undefined)?.url;
                }
                if (!url) return;
                setMessage(await sharePreviewLink(url));
              }}
            >
              {active?.url ? 'Share link' : 'Create & share link'}
            </button>
            <button className="glass-pill" type="button" disabled={!active?.url} onClick={() => active?.url && navigator.clipboard.writeText(active.url).then(() => setMessage('Link copied.'))}>Copy</button>
            <a className="glass-pill" href={active?.url || '#'} target="_blank" rel="noreferrer" aria-disabled={!active?.url}>Open</a>
            <button className="glass-pill" type="button" onClick={() => run(`/api/admin/projects/${projectId}/invite`)}>Email invitation</button>
          </div>

          <div className="portal-section">
            <p className="portal-section-title">Link settings</p>
            <div className="portal-fields-2">
              <div className="portal-field">
                <label htmlFor="expires">Expires on</label>
                <input id="expires" type="date" value={expires} onChange={(event) => setExpires(event.target.value)} />
              </div>
            </div>
            <div className="portal-actions">
              <button className="glass-pill" type="button" disabled={!expires || !active} onClick={() => api(`/api/admin/projects/${projectId}/link`, { method: 'PATCH', body: JSON.stringify({ expiresAt: new Date(`${expires}T23:59:59.000Z`).toISOString() }) }).then(reload).then(() => setMessage('Expiration updated.'))}>Save expiration</button>
              {!active ? (
                <button className="glass-pill" type="button" onClick={() => run(`/api/admin/projects/${projectId}/link`, { expiresAt: expires ? new Date(`${expires}T23:59:59.000Z`).toISOString() : undefined })}>Generate link</button>
              ) : null}
              <button className="text-btn" type="button" onClick={() => run(`/api/admin/projects/${projectId}/link/regenerate`, { expiresAt: expires ? new Date(`${expires}T23:59:59.000Z`).toISOString() : undefined })}>Regenerate</button>
              <button className="text-btn danger" type="button" disabled={!active} onClick={() => active && api(`/api/admin/tokens/${active.id}/revoke`, { method: 'POST', body: '{}' }).then(reload).then(() => setMessage('Link revoked.'))}>Revoke</button>
            </div>
          </div>

          {links.length ? (
            <div className="portal-section">
              <p className="portal-section-title">Link history</p>
              <ul className="portal-list">
                {links.map((item) => (
                  <li key={item.id}>
                    <span>…{item.last4} <span className={`portal-pill ${item.status === 'active' ? 'good' : ''}`}>{humanize(item.status)}</span></span>
                    <span className="portal-muted">{item.expires_at ? `Expires ${fmtDay(item.expires_at)}` : 'No expiry'}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
        <section className="portal-card">
          <h2>Proposal &amp; pricing</h2>
          <p className="portal-muted">Set the package, price and payment plan, then publish to the client view.</p>
          <div className="portal-actions">
            <Link className="solid-pill" to={`/admin/projects/${projectId}/pricing`}>Edit pricing</Link>
            <Link className="glass-pill" to={`/admin/projects/${projectId}/preview`}>Preview as client</Link>
          </div>
        </section>
      </div>
    </AdminPortalBody>
  );
}

export function AdminPricing() {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState<PricingState | null>(null);
  const [form, setForm] = useState({
    package_id: 'pkg_website',
    package_name: 'Commercial Website',
    base_price_cents: 350000,
    discount_cents: 0,
    tax_cents: 0,
    currency: 'USD',
    proposal_expires_at: '',
    deposit_percent: 50,
    deposit_required_cents: 0,
    deposit_mode: 'percent' as 'percent' | 'amount',
    payment_option: 'two',
    client_pricing_notes: '',
    internal_notes: '',
    deliverables: '',
    additional: '',
    third: '',
    customRows: 'Deposit,50,Deposit before work begins\nRemaining,50,Before final release',
  });
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api<PricingState>(`/api/admin/projects/${projectId}/pricing`)
      .then((data) => {
        setState(data);
        const project = data.project;
        setForm((current) => ({
          ...current,
          package_id: String(project.package_id || 'pkg_website'),
          package_name: String(project.package_preset_name || project.package_name || 'Growth'),
          base_price_cents: Number(project.price_cents || 0) - Number(project.additional_services_cents || 0) - Number(project.third_party_cents || 0) - Number(project.tax_cents || 0) + Number(project.discount_cents || 0),
          discount_cents: Number(project.discount_cents || 0),
          tax_cents: Number(project.tax_cents || 0),
          currency: String(project.currency || 'USD'),
          proposal_expires_at: String(project.proposal_expires_at || '').slice(0, 10),
          deposit_percent: Number(project.deposit_percent || 50),
          deposit_required_cents: Number(project.deposit_cents || 0),
          deposit_mode: (project.deposit_mode === 'amount' ? 'amount' : 'percent'),
          payment_option: String(project.payment_option || 'two'),
          client_pricing_notes: String(project.client_pricing_notes || ''),
          internal_notes: String(project.internal_notes || ''),
          deliverables: (data.deliverables || []).join('\n'),
          additional: (data.additional_services || []).map((item) => `${item.label},${item.amount_cents / 100}`).join('\n'),
          third: (data.third_party_expenses || []).map((item) => `${item.label},${item.amount_cents / 100}`).join('\n'),
        }));
      })
      .catch(() => window.location.replace('/admin/login'));
  }, [projectId, navigate]);

  const payload = useMemo(() => {
    const parsePairs = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
      const [label, amount] = line.split(',');
      return { label: (label || '').trim(), amount_cents: Math.round(Number(amount || 0) * 100) };
    });
    const additional_services = parsePairs(form.additional);
    const third_party_expenses = parsePairs(form.third);
    const custom = form.customRows.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
      const [name, amount, milestone] = line.split(',');
      const numeric = Number(amount || 0);
      const amount_cents = numeric > 1000 ? Math.round(numeric) : Math.round(numeric * 100);
      return { name: (name || 'Installment').trim(), amount_cents, milestone: (milestone || name || '').trim(), percent: null, due_at: null, status: 'due' };
    });
    return {
      package_id: form.package_id,
      package_name: form.package_name,
      base_price_cents: Number(form.base_price_cents),
      discount_cents: Number(form.discount_cents),
      tax_cents: Number(form.tax_cents),
      currency: form.currency,
      proposal_expires_at: form.proposal_expires_at ? new Date(`${form.proposal_expires_at}T23:59:59.000Z`).toISOString() : null,
      deposit_percent: Number(form.deposit_percent),
      deposit_required_cents: Number(form.deposit_required_cents),
      deposit_mode: form.deposit_mode,
      payment_option: form.payment_option,
      client_pricing_notes: form.client_pricing_notes,
      internal_notes: form.internal_notes,
      deliverables: form.deliverables.split('\n').map((item) => item.trim()).filter(Boolean),
      additional_services,
      third_party_expenses,
      installments: custom,
    };
  }, [form]);

  const total = payload.base_price_cents - payload.discount_cents + payload.additional_services.reduce((sum, item) => sum + item.amount_cents, 0) + payload.third_party_expenses.reduce((sum, item) => sum + item.amount_cents, 0) + payload.tax_cents;

  function applyPreset(id: string) {
    const preset = state?.packages.find((item) => item.id === id);
    if (!preset) return;
    setForm((current) => ({
      ...current,
      package_id: preset.id,
      package_name: preset.name,
      base_price_cents: preset.starting_price_cents,
      deliverables: (preset.deliverables || []).join('\n'),
    }));
  }

  async function save(kind: 'draft' | 'publish') {
    setError('');
    setMessage('');
    try {
      const path = kind === 'publish' ? `/api/admin/projects/${projectId}/pricing/publish` : `/api/admin/projects/${projectId}/pricing`;
      const result = await api(path, { method: kind === 'publish' ? 'POST' : 'PUT', body: JSON.stringify(payload) });
      setMessage(kind === 'publish' ? `Published. Total ${money(Number(result.total || total), form.currency)}.` : 'Draft saved. The client was not notified.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save pricing.');
    }
  }

  return (
    <AdminPortalBody title="BBL pricing" back={`/admin/projects/${projectId}`}>
      <p className="crm-kicker">Proposal</p>
      <h1>Pricing</h1>
      <p className="portal-lead">Picking a package fills the price and deliverables. Everything stays editable until you publish.</p>
      {error ? <p className="portal-error" role="alert">{error}</p> : null}
      {message ? <p className="portal-ok" role="status">{message}</p> : null}
      {state?.signed ? <p className="portal-banner">This proposal is signed. Price changes must go through a change order.</p> : null}
      <div className="portal-grid">
        <form className="portal-stack" onSubmit={(event) => { event.preventDefault(); save('draft'); }}>
          <section className="portal-card">
            <h2>Package &amp; price</h2>
            <div className="portal-field">
              <label htmlFor="package_id">Package</label>
              <select id="package_id" value={form.package_id} onChange={(event) => applyPreset(event.target.value)}>
                {PACKAGE_PRESETS.map((item) => (
                  <option key={item.id} value={item.id}>{item.name}. {item.price_label}</option>
                ))}
              </select>
            </div>
            <div className="portal-fields-2">
              <MoneyField id="base" label="Base price" cents={form.base_price_cents} onChange={(cents) => setForm({ ...form, base_price_cents: cents })} />
              <MoneyField id="discount" label="Discount" cents={form.discount_cents} onChange={(cents) => setForm({ ...form, discount_cents: cents })} />
              <MoneyField id="tax" label="Tax" cents={form.tax_cents} onChange={(cents) => setForm({ ...form, tax_cents: cents })} hint="Only when applicable" />
              <div className="portal-field"><label htmlFor="currency">Currency</label><input id="currency" value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value })} /></div>
            </div>
            <div className="portal-fields-2">
              <div className="portal-field">
                <label htmlFor="additional">Additional services</label>
                <textarea id="additional" value={form.additional} onChange={(event) => setForm({ ...form, additional: event.target.value })} placeholder="Copywriting, 800" />
                <span className="portal-hint">One per line: label, dollars</span>
              </div>
              <div className="portal-field">
                <label htmlFor="third">Third-party expenses</label>
                <textarea id="third" value={form.third} onChange={(event) => setForm({ ...form, third: event.target.value })} placeholder="Stock photography, 120" />
                <span className="portal-hint">One per line: label, dollars</span>
              </div>
            </div>
          </section>

          <section className="portal-card">
            <h2>Payment</h2>
            <div className="portal-fields-2">
              <div className="portal-field">
                <label htmlFor="plan">Payment plan</label>
                <select id="plan" value={form.payment_option} onChange={(event) => setForm({ ...form, payment_option: event.target.value })}>
                  <option value="full">Full payment. 100% before work begins</option>
                  <option value="two">Two payments. Deposit plus remaining balance</option>
                  <option value="three">Three payments. 50 / 25 / 25</option>
                  <option value="custom">Custom payment plan</option>
                </select>
              </div>
              <div className="portal-field"><label htmlFor="expires">Proposal expires</label><input id="expires" type="date" value={form.proposal_expires_at} onChange={(event) => setForm({ ...form, proposal_expires_at: event.target.value })} /></div>
              <div className="portal-field">
                <label htmlFor="deposit-pct">Deposit %</label>
                <input id="deposit-pct" type="number" min="1" max="99" value={form.deposit_percent} onChange={(event) => setForm({ ...form, deposit_percent: Number(event.target.value), deposit_mode: 'percent' })} />
                <span className="portal-hint">{form.deposit_mode === 'percent' ? 'In use' : 'Set to use a percentage'}</span>
              </div>
              <MoneyField
                id="deposit-amt"
                label="Or fixed deposit"
                cents={form.deposit_required_cents}
                onChange={(cents) => setForm({ ...form, deposit_required_cents: cents, deposit_mode: 'amount' })}
                hint={form.deposit_mode === 'amount' ? 'In use' : 'Set to use a fixed amount'}
              />
            </div>
            <div className="portal-field">
              <label htmlFor="custom-rows">Custom installments</label>
              <textarea id="custom-rows" value={form.customRows} onChange={(event) => setForm({ ...form, customRows: event.target.value })} />
              <span className="portal-hint">One per line: name, amount, milestone. Must add up to the total.</span>
            </div>
          </section>

          <section className="portal-card">
            <h2>Scope &amp; notes</h2>
            <div className="portal-field">
              <label htmlFor="deliverables">Deliverables</label>
              <textarea id="deliverables" value={form.deliverables} onChange={(event) => setForm({ ...form, deliverables: event.target.value })} />
              <span className="portal-hint">One per line. The client sees these.</span>
            </div>
            <div className="portal-field"><label htmlFor="client-notes">Note to client</label><textarea id="client-notes" value={form.client_pricing_notes} onChange={(event) => setForm({ ...form, client_pricing_notes: event.target.value })} /></div>
            <div className="portal-field">
              <label htmlFor="internal-notes">Internal notes</label>
              <textarea id="internal-notes" value={form.internal_notes} onChange={(event) => setForm({ ...form, internal_notes: event.target.value })} />
              <span className="portal-hint">Never shown to the client.</span>
            </div>
          </section>
          <button type="submit" hidden>Save</button>
        </form>

        <aside className="portal-card portal-sticky">
          <h2>Summary</h2>
          <div className="portal-total">
            <span>Contract total</span>
            <strong>{money(total, form.currency)}</strong>
          </div>
          <ul className="portal-list">
            <li><span>Deposit</span><strong>{form.deposit_mode === 'percent' ? `${form.deposit_percent}%` : money(form.deposit_required_cents, form.currency)}</strong></li>
            <li><span>Remaining balance</span><strong>{money(total - (form.deposit_mode === 'amount' ? form.deposit_required_cents : Math.round(total * form.deposit_percent / 100)), form.currency)}</strong></li>
          </ul>
          <div className="portal-actions">
            <button className="solid-pill accent" type="button" onClick={() => save('publish')}>Publish to client</button>
            <button className="glass-pill" type="button" onClick={() => save('draft')}>Save draft</button>
          </div>
          <div className="portal-actions">
            <Link className="text-btn" to={`/admin/projects/${projectId}/preview`}>Preview as client</Link>
            <button className="text-btn" type="button" onClick={() => state?.links.find((item) => item.url)?.url && sharePreviewLink(state.links.find((item) => item.url)!.url!).then(setMessage)}>Share link</button>
            <button className="text-btn" type="button" onClick={() => state?.links.find((item) => item.url)?.url && navigator.clipboard.writeText(state.links.find((item) => item.url)!.url!).then(() => setMessage('Link copied.'))}>Copy link</button>
          </div>
          <p className="portal-muted" style={{ marginTop: '1rem' }}>Installments must equal the total or publishing fails. Saving a draft doesn't notify the client.</p>
        </aside>
      </div>
    </AdminPortalBody>
  );
}

export function ClientPortal({ preview = false }: { preview?: boolean }) {
  const { token = '', projectId = '' } = useParams();
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState('');
  usePrivateIndexing('BBL Client Portal');

  useEffect(() => {
    async function load() {
      try {
        if (preview) {
          setData(await api(`/api/admin/projects/${projectId}/client-preview`));
          return;
        }
        await api('/api/portal/open', { method: 'POST', body: JSON.stringify({ token }) });
        setData(await api('/api/portal/session'));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'This private link is unavailable.');
      }
    }
    load();
  }, [token, preview, projectId]);

  const installments = (data?.installments as Installment[]) || [];
  const deliverables = (data?.deliverables as string[]) || [];
  const changeOrders = (data?.pendingChangeOrders as { id: string; reason: string; additional_cents: number }[]) || [];
  const previews = (data?.previews as PreviewRecord[]) || [];

  return (
    <div className="portal-shell">
      <header className="portal-nav">
        <span className="brand"><BblWordmark height={22} variant="black" /></span>
        <span className="portal-tag">Private proposal</span>
      </header>
      <div className="portal-wrap">
        {preview ? <p className="portal-banner">Client preview. Nothing is published, changed or sent from this view.</p> : null}
        {error ? <p className="portal-error" role="alert">{error}</p> : null}
        <p className="portal-kicker">Prepared for {String(data?.company || 'you')}</p>
        <h1>{String(data?.projectName || 'Your proposal')}</h1>
        <p className="portal-lead">{String(data?.clientPricingNotes || 'A private proposal prepared for this engagement.')}</p>
        <div className="portal-grid">
          <div className="portal-stack">
            <section className="portal-card">
              <h2>What's included</h2>
              {deliverables.length ? (
                <ul className="portal-checks">
                  {deliverables.map((item) => <li key={item}>{item}</li>)}
                </ul>
              ) : (
                <p className="portal-muted">The scope will appear here once the proposal is published.</p>
              )}
            </section>

            {previews.length ? (
              <section className="portal-card">
                <h2>Private preview</h2>
                <p className="portal-muted">For review only. Not approved for public or commercial use.</p>
                {previews.map((item) => (
                  <div key={item.id} className="portal-preview">
                    {item.imageUrl ? <img src={item.imageUrl} alt={item.title} /> : null}
                    <p>
                      {item.title}
                      {item.siteUrl ? <> · <a href={item.siteUrl} target="_blank" rel="noreferrer">Open website preview</a></> : null}
                    </p>
                  </div>
                ))}
              </section>
            ) : null}

            {changeOrders.length ? (
              <section className="portal-card">
                <h2>Change order</h2>
                <ul className="portal-list">
                  {changeOrders.map((item) => (
                    <li key={item.id}>
                      <span>{item.reason}</span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '.75rem' }}>
                        <strong>+{money(item.additional_cents)}</strong>
                        {!preview ? <button className="solid-pill" type="button" onClick={() => api(`/api/portal/change-orders/${item.id}/accept`, { method: 'POST', body: '{}' }).then(() => window.location.reload())}>Accept</button> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>

          <aside className="portal-card portal-sticky">
            <h2>Investment</h2>
            <div className="portal-total">
              <span>Total</span>
              <strong>{money(Number(data?.total_cents), String(data?.currency || 'USD'))}</strong>
            </div>
            <ul className="portal-list">
              <li><span>Payment plan</span><strong>{PLAN_LABELS[String(data?.paymentOption || '')] || humanize(data?.paymentOption)}</strong></li>
              <li><span>Offer valid until</span><strong>{fmtDay(data?.expiresAt)}</strong></li>
            </ul>
            {installments.length ? (
              <>
                <h3>Payment schedule</h3>
                <ol className="portal-timeline">
                  {installments.map((item, index) => (
                    <li key={item.id || index} className={item.status === 'paid' ? 'paid' : undefined}>
                      <span className="portal-step">{item.status === 'paid' ? '✓' : index + 1}</span>
                      <span>
                        {item.name || item.milestone}
                        {item.milestone && item.name && item.milestone !== item.name ? <small>{item.milestone}</small> : null}
                      </span>
                      <strong>{money(item.amount_cents, String(data?.currency || 'USD'))}</strong>
                    </li>
                  ))}
                </ol>
              </>
            ) : null}
            {!preview && data?.proposalAvailable ? (
              <div className="portal-actions">
                <button className="solid-pill accent" style={{ width: '100%' }} type="button" onClick={() => api('/api/portal/accept-proposal', { method: 'POST', body: '{}' }).then(() => window.location.reload())}>Accept proposal</button>
              </div>
            ) : null}
            <p className="portal-muted" style={{ marginTop: '1rem' }}>Questions? Email hello@bbl.studio.</p>
          </aside>
        </div>
      </div>
    </div>
  );
}
