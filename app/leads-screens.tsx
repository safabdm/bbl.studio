import { type ReactNode, useEffect, useMemo, useState } from 'react';
import './portal.css';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { BblsMark } from '../components/bbls-mark';
import { api, usePrivateIndexing } from '../lib/portal';

type Lead = {
  id: string;
  business_name: string;
  category: string;
  city: string;
  website: string | null;
  yelp_url: string | null;
  instagram_url: string | null;
  google_maps_url: string | null;
  public_email: string | null;
  public_phone: string | null;
  online_presence: string;
  lead_status: string;
  score: number;
  why_need_website: string;
  booking_token: string | null;
};

type Notification = {
  id: string;
  title: string;
  body: string;
  lead_id: string | null;
  read_at: string | null;
  created_at: string;
};

type LeadSummary = {
  total?: number;
  unreadNotifications?: number;
  upcomingAppointments?: number;
};

function formText(form: FormData, key: string) {
  const value = form.get(key);
  return typeof value === 'string' ? value : '';
}

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
          <Link className="glass-pill" to="/admin/leads">Leads</Link>
          <Link className="glass-pill" to="/admin">Projects</Link>
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

function presenceLabel(value: string) {
  return value.replaceAll('_', ' ');
}

function External({ href, label }: { href: string | null; label: string }) {
  if (!href) return <span className="portal-muted">—</span>;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="lead-link">
      {label}
    </a>
  );
}

export function AdminLeads() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [summary, setSummary] = useState<LeadSummary>({});
  const [categories, setCategories] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const status = searchParams.get('status') || '';
  const category = searchParams.get('category') || '';
  const q = searchParams.get('q') || '';

  useEffect(() => {
    let cancelled = false;
    const query = new URLSearchParams();
    if (status) query.set('status', status);
    if (category) query.set('category', category);
    if (q) query.set('q', q);
    Promise.all([
      api<{ leads: Lead[]; summary: LeadSummary; categories: string[] }>(`/api/admin/leads?${query.toString()}`),
      api<{ notifications: Notification[] }>('/api/admin/leads/notifications'),
    ])
      .then(([data, notes]) => {
        if (cancelled) return;
        setLeads(data.leads || []);
        setSummary(data.summary || {});
        setCategories(data.categories || []);
        setNotifications(notes.notifications || []);
      })
      .catch(() => {
        window.location.replace('/admin/login');
      });
    return () => {
      cancelled = true;
    };
  }, [status, category, q, navigate]);

  async function reload() {
    const query = new URLSearchParams();
    if (status) query.set('status', status);
    if (category) query.set('category', category);
    if (q) query.set('q', q);
    const data = await api<{ leads: Lead[]; summary: LeadSummary; categories: string[] }>(`/api/admin/leads?${query.toString()}`);
    setLeads(data.leads || []);
    setSummary(data.summary || {});
    setCategories(data.categories || []);
    const notes = await api<{ notifications: Notification[] }>('/api/admin/leads/notifications');
    setNotifications(notes.notifications || []);
  }

  const unread = useMemo(() => notifications.filter((item) => !item.read_at), [notifications]);

  async function seed(force = false) {
    try {
      const result = await api<{ seeded: number; total: number }>('/api/admin/leads/seed', {
        method: 'POST',
        body: JSON.stringify({ force }),
      });
      setMessage(`Seeded ${result.seeded} Orange County leads (total ${result.total}).`);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not seed leads.');
    }
  }

  return (
    <Shell title="BBLS Leads · Orange County">
      <p className="portal-kicker">Lead generation agent · Orange County, CA only</p>
      <h1>OC leads</h1>
      <p className="portal-lead">
        Beauty, wellness, and boutique retail businesses scored for website opportunity.
        Outreach drafts are created for approved leads — nothing is auto-sent.
      </p>
      {message ? <p className="portal-ok">{message}</p> : null}
      {error ? <p className="portal-error" role="alert">{error}</p> : null}

      {unread.length ? (
        <section className="portal-banner lead-alert" aria-live="polite">
          <strong>Owner alert · {unread.length} unread booking notification{unread.length === 1 ? '' : 's'}</strong>
          <ul className="portal-list">
            {unread.slice(0, 5).map((item) => (
              <li key={item.id}>
                <span>
                  <strong>{item.title}</strong>
                  <br />
                  <span className="portal-muted">{item.body}</span>
                </span>
                <button
                  className="glass-pill"
                  type="button"
                  onClick={() =>
                    api(`/api/admin/leads/notifications/${item.id}/read`, { method: 'POST', body: '{}' })
                      .then(reload)
                      .catch(() => undefined)
                  }
                >
                  Mark read
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="lead-stats">
        <div className="portal-card"><p className="portal-kicker">Total</p><p className="lead-stat">{summary.total ?? 0}</p></div>
        <div className="portal-card"><p className="portal-kicker">Unread alerts</p><p className="lead-stat">{summary.unreadNotifications ?? 0}</p></div>
        <div className="portal-card"><p className="portal-kicker">Upcoming demos</p><p className="lead-stat">{summary.upcomingAppointments ?? 0}</p></div>
      </div>

      <form
        className="lead-filters"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const next = new URLSearchParams();
          const nextStatus = formText(form, 'status');
          const nextCategory = formText(form, 'category');
          const nextQ = formText(form, 'q');
          if (nextStatus) next.set('status', nextStatus);
          if (nextCategory) next.set('category', nextCategory);
          if (nextQ) next.set('q', nextQ);
          setSearchParams(next);
        }}
      >
        <div className="portal-field">
          <label htmlFor="lead-q">Search</label>
          <input id="lead-q" name="q" defaultValue={q} placeholder="Business, city, email" />
        </div>
        <div className="portal-field">
          <label htmlFor="lead-status">Status</label>
          <select id="lead-status" name="status" defaultValue={status}>
            <option value="">All</option>
            {['new', 'reviewed', 'approved', 'draft_ready', 'booked', 'declined', 'closed'].map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
        </div>
        <div className="portal-field">
          <label htmlFor="lead-category">Category</label>
          <select id="lead-category" name="category" defaultValue={category}>
            <option value="">All</option>
            {categories.map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
        </div>
        <div className="portal-actions">
          <button className="solid-pill" type="submit">Filter</button>
          <button className="glass-pill" type="button" onClick={() => seed(false)}>Load OC seed</button>
          <button className="glass-pill" type="button" onClick={() => seed(true)}>Reseed OC catalog</button>
        </div>
      </form>

      <section className="portal-card lead-table-wrap">
        <h2>Dashboard</h2>
        <div className="lead-scroll">
          <table className="portal-table lead-table">
            <thead>
              <tr>
                <th>Business</th>
                <th>Category</th>
                <th>City</th>
                <th>Website</th>
                <th>Yelp</th>
                <th>Instagram</th>
                <th>Email</th>
                <th>Phone</th>
                <th>Presence</th>
                <th>Status</th>
                <th>Why they may need a site</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => (
                <tr key={lead.id}>
                  <td>
                    <Link to={`/admin/leads/${lead.id}`}><strong>{lead.business_name}</strong></Link>
                    <div className="portal-muted">Score {lead.score}</div>
                  </td>
                  <td>{lead.category}</td>
                  <td>{lead.city}</td>
                  <td><External href={lead.website} label="Site" /></td>
                  <td><External href={lead.yelp_url} label="Yelp" /></td>
                  <td><External href={lead.instagram_url} label="IG" /></td>
                  <td>{lead.public_email || '—'}</td>
                  <td>{lead.public_phone || '—'}</td>
                  <td>{presenceLabel(lead.online_presence)}</td>
                  <td>{lead.lead_status}</td>
                  <td className="lead-why">{lead.why_need_website}</td>
                  <td>
                    <Link className="glass-pill" to={`/admin/leads/${lead.id}`}>Open</Link>
                  </td>
                </tr>
              ))}
              {!leads.length ? (
                <tr>
                  <td colSpan={12} className="portal-muted">No leads yet. Load the Orange County seed catalog.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </Shell>
  );
}

export function AdminLeadDetail() {
  const { leadId = '' } = useParams();
  const [lead, setLead] = useState<Lead | null>(null);
  const [drafts, setDrafts] = useState<{ id: string; subject: string; body: string; to_email: string; created_at: string }[]>([]);
  const [appointments, setAppointments] = useState<Record<string, unknown>[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [draftPreview, setDraftPreview] = useState<{ subject: string; body: string; book_url?: string } | null>(null);

  async function reload() {
    const data = await api<{
      lead: Lead;
      drafts: typeof drafts;
      appointments: Record<string, unknown>[];
    }>(`/api/admin/leads/${leadId}`);
    setLead(data.lead);
    setDrafts(data.drafts || []);
    setAppointments(data.appointments || []);
  }

  useEffect(() => {
    let cancelled = false;
    api<{
      lead: Lead;
      drafts: { id: string; subject: string; body: string; to_email: string; created_at: string }[];
      appointments: Record<string, unknown>[];
    }>(`/api/admin/leads/${leadId}`)
      .then((data) => {
        if (cancelled) return;
        setLead(data.lead);
        setDrafts(data.drafts || []);
        setAppointments(data.appointments || []);
      })
      .catch(() => {
        window.location.replace('/admin/login');
      });
    return () => {
      cancelled = true;
    };
  }, [leadId]);

  async function setStatus(nextStatus: string) {
    try {
      await api(`/api/admin/leads/${leadId}/status`, { method: 'POST', body: JSON.stringify({ status: nextStatus }) });
      setMessage(`Status → ${nextStatus}`);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update status.');
    }
  }

  async function createDraft() {
    try {
      const result = await api<{
        draft: { subject: string; body: string; book_url: string };
        message: string;
      }>(`/api/admin/leads/${leadId}/draft-email`, { method: 'POST', body: '{}' });
      setDraftPreview(result.draft);
      setMessage(result.message);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create draft.');
    }
  }

  if (!lead) {
    return (
      <Shell title="Lead" back="/admin/leads">
        <p className="portal-muted">Loading lead…</p>
      </Shell>
    );
  }

  const bookUrl = lead.booking_token ? `${window.location.origin}/book/${lead.booking_token}` : null;

  return (
    <Shell title={`${lead.business_name} · Lead`} back="/admin/leads">
      <p className="portal-kicker">{lead.city} · Orange County · score {lead.score}</p>
      <h1>{lead.business_name}</h1>
      <p className="portal-lead">{lead.why_need_website}</p>
      {message ? <p className="portal-ok">{message}</p> : null}
      {error ? <p className="portal-error" role="alert">{error}</p> : null}

      <div className="portal-grid">
        <section className="portal-card">
          <h2>Lead profile</h2>
          <ul className="portal-list">
            <li><span>Category</span><span>{lead.category}</span></li>
            <li><span>City</span><span>{lead.city}</span></li>
            <li><span>Website</span><span><External href={lead.website} label={lead.website || 'None'} /></span></li>
            <li><span>Yelp</span><span><External href={lead.yelp_url} label="Open" /></span></li>
            <li><span>Instagram</span><span><External href={lead.instagram_url} label="Open" /></span></li>
            <li><span>Google Maps</span><span><External href={lead.google_maps_url} label="Open" /></span></li>
            <li><span>Public email</span><span>{lead.public_email || '—'}</span></li>
            <li><span>Public phone</span><span>{lead.public_phone || '—'}</span></li>
            <li><span>Online presence</span><span>{presenceLabel(lead.online_presence)}</span></li>
            <li><span>Status</span><span>{lead.lead_status}</span></li>
          </ul>
          <div className="portal-actions">
            <button className="glass-pill" type="button" onClick={() => setStatus('reviewed')}>Mark reviewed</button>
            <button className="solid-pill" type="button" onClick={() => setStatus('approved')}>Approve</button>
            <button className="glass-pill" type="button" onClick={() => setStatus('declined')}>Decline</button>
            <button className="glass-pill" type="button" onClick={() => setStatus('closed')}>Close</button>
          </div>
        </section>

        <section className="portal-card">
          <h2>Outreach draft</h2>
          <p className="portal-muted">
            Approved leads get a personalized email inviting a 15-minute video call.
            No price. Demo is shown on the call only. Drafts are never auto-sent.
          </p>
          <div className="portal-actions">
            <button className="solid-pill" type="button" onClick={createDraft}>Create email draft</button>
            {bookUrl ? (
              <button
                className="glass-pill"
                type="button"
                onClick={() => navigator.clipboard.writeText(bookUrl).then(() => setMessage('Booking link copied.'))}
              >
                Copy booking link
              </button>
            ) : null}
          </div>
          {draftPreview ? (
            <div className="lead-draft">
              <p className="portal-kicker">Latest draft (not sent)</p>
              <h3>{draftPreview.subject}</h3>
              <pre>{draftPreview.body}</pre>
              <button
                className="glass-pill"
                type="button"
                onClick={() =>
                  navigator.clipboard
                    .writeText(`${draftPreview.subject}\n\n${draftPreview.body}`)
                    .then(() => setMessage('Draft copied to clipboard.'))
                }
              >
                Copy draft
              </button>
            </div>
          ) : null}
          {drafts.length ? (
            <ul className="portal-list">
              {drafts.map((draft) => (
                <li key={draft.id}>
                  <span>{draft.subject}</span>
                  <span>{new Date(draft.created_at).toLocaleString()}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      </div>

      <section className="portal-card" style={{ marginTop: '1.25rem' }}>
        <h2>Appointments</h2>
        <p className="portal-muted">Bookings require 24+ hours notice. Owner is notified in-app (and via webhook/email log when configured).</p>
        <ul className="portal-list">
          {appointments.map((item) => (
            <li key={String(item.id)}>
              <span>
                {String(item.contact_name)} · {String(item.contact_email)}
              </span>
              <span>{new Date(String(item.scheduled_at)).toLocaleString()}</span>
            </li>
          ))}
          {!appointments.length ? <li><span className="portal-muted">No appointments yet.</span><span /></li> : null}
        </ul>
      </section>
    </Shell>
  );
}

export function PublicBook() {
  const { token = '' } = useParams();
  const [business, setBusiness] = useState('');
  const [city, setCity] = useState('');
  const [slots, setSlots] = useState<string[]>([]);
  const [slot, setSlot] = useState('');
  const [done, setDone] = useState('');
  const [error, setError] = useState('');
  usePrivateIndexing('Book a BBLS demo');

  useEffect(() => {
    api<{ business_name: string; city: string; slots: string[] }>(`/api/book/${token}`)
      .then((data) => {
        setBusiness(data.business_name);
        setCity(data.city);
        setSlots(data.slots || []);
        setSlot(data.slots?.[0] || '');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Booking link unavailable.'));
  }, [token]);

  async function onSubmit(event: { preventDefault(): void; currentTarget: HTMLFormElement }) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const result = await api<{ message: string; scheduled_at: string }>(`/api/book/${token}`, {
        method: 'POST',
        body: JSON.stringify({
          slotIso: slot,
          name: formText(form, 'name'),
          email: formText(form, 'email'),
          notes: formText(form, 'notes'),
        }),
      });
      setDone(result.message);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not book.');
    }
  }

  return (
    <div className="portal-shell">
      <div className="portal-login" style={{ width: 'min(34rem, calc(100% - 2rem))' }}>
        <p className="portal-kicker">BBL Studio · Orange County</p>
        <h1>15-minute demo call</h1>
        <p className="portal-lead">
          {business ? `Personalized website walkthrough for ${business}${city ? ` in ${city}` : ''}.` : 'Loading booking…'}
          {' '}The demo is shown live on the call — not sent beforehand.
        </p>
        {done ? (
          <div className="portal-card">
            <p className="portal-ok">{done}</p>
            <p className="portal-muted">We will confirm the video link by email. Appointments are always at least 24 hours out.</p>
          </div>
        ) : (
          <form className="portal-card" onSubmit={onSubmit}>
            <div className="portal-field">
              <label htmlFor="book-name">Your name</label>
              <input id="book-name" name="name" required />
            </div>
            <div className="portal-field">
              <label htmlFor="book-email">Email</label>
              <input id="book-email" name="email" type="email" required />
            </div>
            <div className="portal-field">
              <label htmlFor="book-slot">Time (PT, 24h+ advance)</label>
              <select id="book-slot" value={slot} onChange={(event) => setSlot(event.target.value)} required>
                {slots.map((item) => (
                  <option key={item} value={item}>
                    {new Date(item).toLocaleString('en-US', {
                      timeZone: 'America/Los_Angeles',
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </option>
                ))}
              </select>
            </div>
            <div className="portal-field">
              <label htmlFor="book-notes">Notes (optional)</label>
              <textarea id="book-notes" name="notes" />
            </div>
            {error ? <p className="portal-error" role="alert">{error}</p> : null}
            <div className="portal-actions">
              <button className="solid-pill" type="submit">Book video call</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
