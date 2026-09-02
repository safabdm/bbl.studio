import { FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import './portal.css';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { BblsMark } from '../components/bbls-mark';
import { PACKAGE_PRESETS } from '../server/packages';
import { api, money, usePrivateIndexing } from '../lib/portal';

type PreviewRecord = { id: string; title: string; kind: string; version: number; imageUrl?: string | null; siteUrl?: string | null };
type LinkRecord = { id: string; last4?: string; status: string; expires_at: string | null; url?: string | null; publicUrl?: string | null };

async function sharePreviewLink(url: string) {
  try {
    if (navigator.share) {
      await navigator.share({ title: 'BBLS private preview', text: 'Open this private BBLS preview. Do not forward it.', url });
      return 'Preview link opened in share sheet.';
    }
  } catch {
    // User cancelled native share; fall through to copy.
  }
  await navigator.clipboard.writeText(url);
  return `Preview link copied: ${url}`;
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

function Shell({ title, children, back }: { title: string; children: ReactNode; back?: string }) {
  usePrivateIndexing(title);
  return (
    <div className="portal-shell">
      <header className="portal-nav">
        <Link to="/admin" className="brand" aria-label="BBLS admin home">
          <BblsMark size={22} />
          <span>bbls admin</span>
        </Link>
        <nav className="portal-actions" aria-label="Admin">
          {back ? <Link className="glass-pill" to={back}>Back</Link> : null}
          <button
            className="glass-pill"
            type="button"
            onClick={() => {
              void api('/api/admin/logout', { method: 'POST', body: '{}' }).catch(() => undefined);
              window.location.replace('/admin/login');
            }}
          >
            Log out
          </button>
        </nav>
      </header>
      <div className="portal-wrap">{children}</div>
    </div>
  );
}

export function AdminLogin() {
  const navigate = useNavigate();
  const [error, setError] = useState('');
  usePrivateIndexing('BBLS Admin');
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
      setError(err instanceof Error ? err.message : 'Could not sign in. Use admin@bbls.studio and the current studio password.');
    }
  }
  return (
    <div className="portal-shell">
      <div className="portal-login">
        <p className="portal-kicker">Private administrator access</p>
        <h1>BBLS Admin</h1>
        <p className="portal-lead">Sign in to manage clients, pricing, and private project links.</p>
        <form className="portal-card" onSubmit={onSubmit}>
          <div className="portal-field">
            <label htmlFor="admin-email">Email</label>
            <input id="admin-email" name="email" type="email" autoComplete="username" defaultValue="admin@bbls.studio" required />
          </div>
          <div className="portal-field">
            <label htmlFor="admin-password">Password</label>
            <input id="admin-password" name="password" type="password" autoComplete="current-password" required />
          </div>
          {error ? <p className="portal-error" role="alert">{error}</p> : null}
          <div className="portal-actions">
            <button className="solid-pill" type="submit">Enter dashboard</button>
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
  useEffect(() => {
    api<{ projects: Record<string, unknown>[] }>('/api/admin/projects')
      .then((data) => setProjects(data.projects || []))
      .catch(() => window.location.replace('/admin/login'));
  }, [navigate]);

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
    <Shell title="BBLS Admin">
      <p className="portal-kicker">Boutique Brand & Launch Studio</p>
      <h1>Projects</h1>
      <p className="portal-lead">Create a client, set pricing, then generate a private link.</p>
      <div className="portal-grid">
        <section className="portal-card">
          <h2>Open a project</h2>
          <table className="portal-table">
            <thead>
              <tr><th>Client</th><th>Project</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {projects.map((project) => (
                <tr key={String(project.id)}>
                  <td>{String(project.company_name)}</td>
                  <td>{String(project.name)}</td>
                  <td>{String(project.status)}</td>
                  <td>
                    <Link className="glass-pill" to={`/admin/projects/${project.id}`}>Open</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <form className="portal-card" onSubmit={createClient}>
          <h2>Create a client</h2>
          <div className="portal-field"><label htmlFor="company_name">Company</label><input id="company_name" name="company_name" required /></div>
          <div className="portal-field"><label htmlFor="contact_name">Contact name</label><input id="contact_name" name="contact_name" required /></div>
          <div className="portal-field"><label htmlFor="email">Email</label><input id="email" name="email" type="email" required /></div>
          <div className="portal-field"><label htmlFor="title">Title</label><input id="title" name="title" /></div>
          <div className="portal-field"><label htmlFor="project_name">Project name</label><input id="project_name" name="project_name" required /></div>
          <div className="portal-field">
            <label htmlFor="package_id">Package preset</label>
            <select id="package_id" name="package_id" defaultValue="pkg_website">
              {PACKAGE_PRESETS.filter((item) => item.id !== 'pkg_custom').map((item) => (
                <option key={item.id} value={item.id}>{item.name}. {item.price_label}</option>
              ))}
              <option value="pkg_custom">Custom Project</option>
            </select>
          </div>
          {error ? <p className="portal-error" role="alert">{error}</p> : null}
          <div className="portal-actions"><button className="solid-pill" type="submit">Create and set pricing</button></div>
        </form>
      </div>
    </Shell>
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
    <Shell title="BBLS project" back="/admin">
      <p className="portal-kicker">{String(project?.company_name || 'Project')}</p>
      <h1>{String(project?.name || 'Loading')}</h1>
      <p className="portal-lead">{String(project?.contact_name || '')} · {String(project?.email || '')} · {String(project?.status || '')}</p>
      {message ? <p className="portal-ok">{message}</p> : null}
      <div className="portal-grid">
        <section className="portal-card">
          <h2>Private client link</h2>
          <p className="portal-muted">Send this private preview link. Anyone with it can open the client preview; it does not include the client name or project id.</p>
          <div className="portal-field">
            <label htmlFor="share-link">Share preview link</label>
            <input id="share-link" readOnly value={active?.url || ''} placeholder="Generate a private link first" onFocus={(event) => event.currentTarget.select()} />
          </div>
          <div className="portal-field">
            <label htmlFor="expires">Expiration date</label>
            <input id="expires" type="date" value={expires} onChange={(event) => setExpires(event.target.value)} />
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
              Share Preview Link
            </button>
            <button className="glass-pill" type="button" disabled={!active?.url} onClick={() => active?.url && navigator.clipboard.writeText(active.url).then(() => setMessage('Preview link copied.'))}>Copy Link</button>
            <a className="glass-pill" href={active?.url || '#'} target="_blank" rel="noreferrer">Open Client Preview</a>
            <button className="glass-pill" type="button" onClick={() => run(`/api/admin/projects/${projectId}/link`, { expiresAt: expires ? new Date(`${expires}T23:59:59.000Z`).toISOString() : undefined })}>Generate Private Link</button>
            <button className="glass-pill" type="button" onClick={() => api(`/api/admin/projects/${projectId}/link`, { method: 'PATCH', body: JSON.stringify({ expiresAt: new Date(`${expires}T23:59:59.000Z`).toISOString() }) }).then(reload)}>Set Expiration Date</button>
            <button className="glass-pill" type="button" onClick={() => run(`/api/admin/projects/${projectId}/link/regenerate`, { expiresAt: expires ? new Date(`${expires}T23:59:59.000Z`).toISOString() : undefined })}>Regenerate Link</button>
            <button className="glass-pill" type="button" onClick={() => active && api(`/api/admin/tokens/${active.id}/revoke`, { method: 'POST', body: '{}' }).then(reload)}>Revoke Link</button>
            <button className="glass-pill" type="button" onClick={() => run(`/api/admin/projects/${projectId}/invite`)}>Send Invitation Email</button>
          </div>
          <ul className="portal-list">
            {links.map((item) => (
              <li key={item.id}><span>…{item.last4} · {item.status}</span><span>{item.expires_at ? new Date(item.expires_at).toLocaleDateString() : 'No expiry'}</span></li>
            ))}
          </ul>
        </section>
        <section className="portal-card">
          <h2>Pricing and proposal</h2>
          <p className="portal-muted">Set package, discounts, taxes, and payment plan before publishing.</p>
          <div className="portal-actions">
            <Link className="solid-pill" to={`/admin/projects/${projectId}/pricing`}>Open pricing</Link>
            <Link className="glass-pill" to={`/admin/projects/${projectId}/preview`}>Preview as Client</Link>
          </div>
        </section>
      </div>
    </Shell>
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
    <Shell title="BBLS pricing" back={`/admin/projects/${projectId}`}>
      <p className="portal-kicker">Per-project pricing</p>
      <h1>Set the proposal</h1>
      <p className="portal-lead">Choosing a preset fills the default price and deliverables. Everything stays editable before you publish.</p>
      {error ? <p className="portal-error" role="alert">{error}</p> : null}
      {message ? <p className="portal-ok">{message}</p> : null}
      <div className="portal-grid">
        <form className="portal-card" onSubmit={(event) => { event.preventDefault(); save('draft'); }}>
          <div className="portal-field">
            <label htmlFor="package_id">Package name</label>
            <select id="package_id" value={form.package_id} onChange={(event) => applyPreset(event.target.value)}>
              {PACKAGE_PRESETS.map((item) => (
                <option key={item.id} value={item.id}>{item.name}. {item.price_label}</option>
              ))}
            </select>
          </div>
          <div className="portal-field"><label htmlFor="base">Base price (cents)</label><input id="base" type="number" min="0" value={form.base_price_cents} onChange={(event) => setForm({ ...form, base_price_cents: Number(event.target.value) })} /></div>
          <div className="portal-field"><label htmlFor="discount">Custom discount (cents)</label><input id="discount" type="number" min="0" value={form.discount_cents} onChange={(event) => setForm({ ...form, discount_cents: Number(event.target.value) })} /></div>
          <div className="portal-field"><label htmlFor="additional">Additional services (label, dollars)</label><textarea id="additional" value={form.additional} onChange={(event) => setForm({ ...form, additional: event.target.value })} /></div>
          <div className="portal-field"><label htmlFor="third">Third-party expenses (label, dollars)</label><textarea id="third" value={form.third} onChange={(event) => setForm({ ...form, third: event.target.value })} /></div>
          <div className="portal-field"><label htmlFor="tax">Taxes when applicable (cents)</label><input id="tax" type="number" min="0" value={form.tax_cents} onChange={(event) => setForm({ ...form, tax_cents: Number(event.target.value) })} /></div>
          <div className="portal-field"><label htmlFor="currency">Currency</label><input id="currency" value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value })} /></div>
          <div className="portal-field"><label htmlFor="expires">Proposal expiration date</label><input id="expires" type="date" value={form.proposal_expires_at} onChange={(event) => setForm({ ...form, proposal_expires_at: event.target.value })} /></div>
          <div className="portal-field">
            <label htmlFor="plan">Payment-plan type</label>
            <select id="plan" value={form.payment_option} onChange={(event) => setForm({ ...form, payment_option: event.target.value })}>
              <option value="full">Full payment. 100% before work begins</option>
              <option value="two">Two payments. Deposit plus remaining balance</option>
              <option value="three">Three payments. 50 / 25 / 25</option>
              <option value="custom">Custom payment plan</option>
            </select>
          </div>
          <div className="portal-field"><label htmlFor="deposit-pct">Deposit percent</label><input id="deposit-pct" type="number" min="1" max="99" value={form.deposit_percent} onChange={(event) => setForm({ ...form, deposit_percent: Number(event.target.value), deposit_mode: 'percent' })} /></div>
          <div className="portal-field"><label htmlFor="deposit-amt">Deposit required (cents)</label><input id="deposit-amt" type="number" min="0" value={form.deposit_required_cents} onChange={(event) => setForm({ ...form, deposit_required_cents: Number(event.target.value), deposit_mode: 'amount' })} /></div>
          <div className="portal-field"><label htmlFor="custom-rows">Custom installments (name, amount, milestone)</label><textarea id="custom-rows" value={form.customRows} onChange={(event) => setForm({ ...form, customRows: event.target.value })} /></div>
          <div className="portal-field"><label htmlFor="deliverables">Deliverables</label><textarea id="deliverables" value={form.deliverables} onChange={(event) => setForm({ ...form, deliverables: event.target.value })} /></div>
          <div className="portal-field"><label htmlFor="client-notes">Client-visible pricing notes</label><textarea id="client-notes" value={form.client_pricing_notes} onChange={(event) => setForm({ ...form, client_pricing_notes: event.target.value })} /></div>
          <div className="portal-field"><label htmlFor="internal-notes">Internal notes</label><textarea id="internal-notes" value={form.internal_notes} onChange={(event) => setForm({ ...form, internal_notes: event.target.value })} /></div>
          <div className="portal-actions">
            <button className="glass-pill" type="submit">Save Draft</button>
            <button className="solid-pill" type="button" onClick={() => save('publish')}>Publish to Client Portal</button>
            <button className="glass-pill" type="button" onClick={() => state?.links.find((item) => item.url)?.url && sharePreviewLink(state.links.find((item) => item.url)!.url!).then(setMessage)}>Share Preview Link</button>
            <Link className="glass-pill" to={`/admin/projects/${projectId}/preview`}>Preview as Client</Link>
            <button className="glass-pill" type="button" onClick={() => state?.links.find((item) => item.url)?.url && navigator.clipboard.writeText(state.links.find((item) => item.url)!.url!)}>Copy Private Link</button>
          </div>
        </form>
        <aside className="portal-card">
          <h2>Contract summary</h2>
          <ul className="portal-list">
            <li><span>Final contract total</span><strong>{money(total, form.currency)}</strong></li>
            <li><span>Deposit required</span><strong>{form.deposit_mode === 'percent' ? `${form.deposit_percent}%` : money(form.deposit_required_cents, form.currency)}</strong></li>
            <li><span>Remaining balance</span><strong>{money(total - (form.deposit_mode === 'amount' ? form.deposit_required_cents : Math.round(total * form.deposit_percent / 100)), form.currency)}</strong></li>
          </ul>
          <p className="portal-muted">Installments must equal the final total. Publishing fails if they do not. Internal notes stay off the client view.</p>
          {state?.signed ? <p className="portal-error">This proposal is signed. Price changes must go through a change order.</p> : null}
        </aside>
      </div>
    </Shell>
  );
}

export function ClientPortal({ preview = false }: { preview?: boolean }) {
  const { token = '', projectId = '' } = useParams();
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState('');
  usePrivateIndexing('BBLS Client Portal');

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
        <span className="brand"><BblsMark size={22} /><span>bbls</span></span>
        <span className="portal-muted">Private client portal</span>
      </header>
      <div className="portal-wrap">
        {preview ? <p className="portal-banner">Preview as Client. This does not publish, change status, or send a notification.</p> : null}
        {error ? <p className="portal-error" role="alert">{error}</p> : null}
        <p className="portal-kicker">{String(data?.company || 'BBLS')}</p>
        <h1>{String(data?.projectName || 'Your proposal')}</h1>
        <p className="portal-lead">{String(data?.clientPricingNotes || 'A private proposal prepared for this engagement.')}</p>
        <div className="portal-grid">
          <section className="portal-card">
            <h2>Investment</h2>
            <ul className="portal-list">
              <li><span>Final contract total</span><strong>{money(Number(data?.total_cents), String(data?.currency || 'USD'))}</strong></li>
              <li><span>Payment plan</span><strong>{String(data?.paymentOption || '')}</strong></li>
              <li><span>Proposal expires</span><strong>{data?.expiresAt ? new Date(String(data.expiresAt)).toLocaleDateString() : 'Not set'}</strong></li>
            </ul>
            <h3 style={{ marginTop: '1.4rem' }}>Schedule</h3>
            <ul className="portal-list">
              {installments.map((item, index) => (
                <li key={item.id || index}><span>{item.name || item.milestone}</span><strong>{money(item.amount_cents, String(data?.currency || 'USD'))}</strong></li>
              ))}
            </ul>
            {!preview && data?.proposalAvailable ? (
              <div className="portal-actions">
                <button className="solid-pill" type="button" onClick={() => api('/api/portal/accept-proposal', { method: 'POST', body: '{}' }).then(() => window.location.reload())}>Accept this proposal</button>
              </div>
            ) : null}
          </section>
          <section className="portal-card">
            <h2>Included</h2>
            <ul className="portal-list">
              {deliverables.map((item) => <li key={item}><span>{item}</span></li>)}
            </ul>
            {previews.length ? (
              <div>
                <h3 style={{ marginTop: '1.4rem' }}>Private preview</h3>
                <p className="portal-muted">This preview is for review only. It is not approved for public or commercial use.</p>
                {previews.map((item) => (
                  <div key={item.id} style={{ marginTop: '1rem' }}>
                    <p className="portal-muted">{item.title}</p>
                    {item.imageUrl ? <img src={item.imageUrl} alt={item.title} style={{ width: '100%', borderRadius: '10px' }} /> : null}
                    {item.siteUrl ? <a className="solid-pill" href={item.siteUrl} target="_blank" rel="noreferrer" style={{ marginTop: '.75rem' }}>Open website preview</a> : null}
                  </div>
                ))}
              </div>
            ) : null}
            {changeOrders.length ? (
              <div>
                <h3>Change order</h3>
                {changeOrders.map((item) => (
                  <p key={item.id} className="portal-muted">{item.reason} · {money(item.additional_cents)}
                    {!preview ? <button className="solid-pill" type="button" onClick={() => api(`/api/portal/change-orders/${item.id}/accept`, { method: 'POST', body: '{}' }).then(() => window.location.reload())}>Accept change order</button> : null}
                  </p>
                ))}
              </div>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
}
