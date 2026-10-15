import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { BblsMark } from '../components/bbls-mark';
import { api, usePrivateIndexing } from '../lib/portal';
import type {
  CrmBookingItem,
  CrmCampaignSummary,
  CrmInboxItem,
  CrmLead,
  EmailTemplate,
  PersonalizedPreview,
} from '../server/crm-types';
import './crm.css';
import './portal.css';

function asText(value: unknown, fallback = '') {
  if (value == null) return fallback;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

type OverviewResponse = {
  metrics: {
    total_leads: number;
    new_leads: number;
    contacted_leads: number;
    emails_sent: number;
    emails_delivered: number;
    emails_bounced: number;
    replies: number;
    booked: number;
    conversion_rate: number | null;
    last_activity_at?: string | null;
  } | null;
  source: string;
  connection?: 'not_connected' | 'sync_pending' | 'synced';
  last_synced_at?: string | null;
  metrics_trusted?: boolean;
  message?: string;
  safety: {
    EMAIL_OUTREACH_ENABLED?: boolean;
    EMAIL_DRY_RUN?: boolean;
    MANUAL_SEND_LIVE_ENABLED?: boolean;
    FOLLOWUPS_LIVE?: boolean;
  };
};

type LeadsResponse = {
  leads: CrmLead[];
  source: string;
  connection?: 'not_connected' | 'sync_pending' | 'synced';
  last_synced_at?: string | null;
  message?: string;
  empty?: boolean;
  metrics_trusted?: boolean;
};

function connectionBanner(connection?: string, message?: string) {
  if (!connection && !message) return null;
  if (connection === 'synced' && !message) return null;
  const label =
    connection === 'not_connected'
      ? 'Not connected'
      : connection === 'sync_pending'
        ? 'Sync pending'
        : connection === 'synced'
          ? 'Connected'
          : null;
  const cls = connection === 'synced' ? 'crm-banner' : 'crm-banner warn';
  return (
    <div className={cls}>
      {label ? <strong>{label}. </strong> : null}
      {message || ''}
    </div>
  );
}

function metricDisplay(trusted: boolean | undefined, value: number | string | null | undefined, suffix = '') {
  if (!trusted || value == null || value === '') return '—';
  return `${value}${suffix}`;
}

function StatusPill({ value }: { value: string | null | undefined }) {
  const v = (value || 'UNKNOWN').toUpperCase();
  const cls = v === 'YES' ? 'yes' : v === 'NO' ? 'no' : 'unknown';
  return <span className={`crm-status ${cls}`}>{v}</span>;
}

function CrmShell({ children }: { children: ReactNode }) {
  usePrivateIndexing('BBL Studio CRM');
  return (
    <div className="crm-shell">
      <header className="crm-nav">
        <Link to="/admin" className="crm-nav-brand" aria-label="BBL Studio CRM home">
          <BblsMark size={22} />
          <span>BBL Studio CRM</span>
        </Link>
        <nav className="crm-nav-links" aria-label="CRM sections">
          <NavLink to="/admin" end className={({ isActive }) => (isActive ? 'active' : undefined)}>Overview</NavLink>
          <NavLink to="/admin/leads" className={({ isActive }) => (isActive ? 'active' : undefined)}>Leads</NavLink>
          <NavLink to="/admin/campaigns" className={({ isActive }) => (isActive ? 'active' : undefined)}>Email Campaigns</NavLink>
          <NavLink to="/admin/inbox" className={({ isActive }) => (isActive ? 'active' : undefined)}>Inbox / Replies</NavLink>
          <NavLink to="/admin/bookings" className={({ isActive }) => (isActive ? 'active' : undefined)}>Bookings</NavLink>
          <NavLink to="/admin/analytics" className={({ isActive }) => (isActive ? 'active' : undefined)}>Analytics</NavLink>
          <NavLink to="/admin/settings" className={({ isActive }) => (isActive ? 'active' : undefined)}>Settings</NavLink>
          <NavLink to="/admin/projects" className={({ isActive }) => (isActive ? 'active' : undefined)}>Client portal</NavLink>
          <button
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
      <div className="crm-wrap">{children}</div>
    </div>
  );
}

function OverviewPage() {
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    void api<OverviewResponse>('/api/admin/crm/overview')
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load overview.'));
  }, []);
  const m = data?.metrics;
  const trusted = Boolean(data?.metrics_trusted);
  return (
    <>
      <p className="crm-kicker">Owner dashboard</p>
      <h1>Overview</h1>
      <p className="crm-lead">Manual email marketing only. Automated outreach stays off. Mac pushes CRM snapshots outbound; delivery truth comes from signed Resend webhooks.</p>
      {connectionBanner(data?.connection, data?.message)}
      {error ? <p className="crm-error">{error}</p> : null}
      <div className="crm-metrics">
        {[
          ['Total leads', metricDisplay(trusted, m?.total_leads)],
          ['New', metricDisplay(trusted, m?.new_leads)],
          ['Contacted', metricDisplay(trusted, m?.contacted_leads)],
          ['Emails sent', metricDisplay(trusted, m?.emails_sent)],
          ['Delivered', metricDisplay(trusted, m?.emails_delivered)],
          ['Bounced', metricDisplay(trusted, m?.emails_bounced)],
          ['Replies', metricDisplay(trusted, m?.replies)],
          ['Booked', metricDisplay(trusted, m?.booked)],
          ['Conversion', metricDisplay(trusted, m?.conversion_rate, '%')],
        ].map(([label, value]) => (
          <div className="crm-metric" key={String(label)}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      {!trusted ? (
        <p className="crm-muted" style={{ marginTop: '0.85rem' }}>
          Counts show as em dashes until a successful Mac sync. Zeros appear only after real synced data.
        </p>
      ) : null}
      <div className="crm-panel">
        <h2>Safety</h2>
        <p className="crm-muted" style={{ marginTop: '.75rem' }}>
          EMAIL_OUTREACH_ENABLED={asText(data?.safety?.EMAIL_OUTREACH_ENABLED, 'false')} · EMAIL_DRY_RUN={asText(data?.safety?.EMAIL_DRY_RUN, 'true')} · MANUAL_SEND_LIVE_ENABLED={asText(data?.safety?.MANUAL_SEND_LIVE_ENABLED, 'false')} · FOLLOWUPS_LIVE={asText(data?.safety?.FOLLOWUPS_LIVE, 'false')}
        </p>
        <div className="crm-actions">
          <Link className="crm-btn" to="/admin/leads">Go to Leads</Link>
          <Link className="crm-btn-secondary" to="/admin/campaigns">Compose campaign</Link>
        </div>
      </div>
    </>
  );
}

function LeadsPage() {
  const navigate = useNavigate();
  const [leads, setLeads] = useState<CrmLead[]>([]);
  const [connection, setConnection] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    void api<LeadsResponse>(`/api/admin/crm/leads?${params.toString()}`)
      .then((data) => {
        setLeads(data.leads || []);
        setConnection(data.connection || data.source || '');
        setMessage(data.message || '');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load leads.'));
  }, [status]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return leads;
    return leads.filter((lead) =>
      [lead.business_name, lead.contact_name, lead.email, lead.location, lead.category]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    );
  }, [leads, q]);

  const allFilteredIds = filtered.map((lead) => String(lead.id));
  const allSelected = allFilteredIds.length > 0 && allFilteredIds.every((id) => selected.includes(id));

  function toggle(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function composeSelected() {
    sessionStorage.setItem('bbl_crm_selected_ids', JSON.stringify(selected));
    navigate('/admin/campaigns');
  }

  return (
    <>
      <p className="crm-kicker">Lead management</p>
      <h1>Leads</h1>
      <p className="crm-lead">Select contacts, then compose. Unverified delivery fields show UNKNOWN. No fabricated lead rows.</p>
      {connectionBanner(connection, message)}
      {error ? <p className="crm-error">{error}</p> : null}
      <div className="crm-toolbar">
        <div className="crm-filters">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, email, location" aria-label="Search leads" />
          <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
            <option value="">All statuses</option>
            <option value="new">New</option>
            <option value="contacted">Contacted</option>
            <option value="replied">Replied</option>
            <option value="booked">Booked</option>
          </select>
        </div>
        <div className="crm-selected">
          <strong>{selected.length}</strong> selected
        </div>
      </div>
      <div className="crm-actions">
        <button className="crm-btn-secondary" type="button" onClick={() => setSelected(allSelected ? [] : allFilteredIds)}>
          {allSelected ? 'Deselect filtered' : 'Select filtered'}
        </button>
        <button className="crm-btn-secondary" type="button" onClick={() => setSelected([])}>Clear selection</button>
        <button className="crm-btn" type="button" disabled={!selected.length} onClick={composeSelected}>Compose email</button>
      </div>
      {!filtered.length ? (
        <div className="crm-empty">
          {connection === 'not_connected'
            ? 'Not connected — Mac has not pushed a CRM snapshot yet. This is not a zero-lead database; run scripts/crm-mac-sync/push_crm_sync.py when the Mac worker is online.'
            : connection === 'sync_pending'
              ? 'Sync pending — waiting for a successful Mac push (or last sync is stale). Leads will appear here after POST /api/crm/sync succeeds.'
              : 'No leads match this filter. Synced CRM data is present; try clearing filters.'}
        </div>
      ) : (
        <div className="crm-table-wrap">
          <table className="crm-table">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={() => setSelected(allSelected ? [] : allFilteredIds)}
                    aria-label="Select all filtered"
                  />
                </th>
                <th>Business</th>
                <th>Email</th>
                <th>Status</th>
                <th>Accepted</th>
                <th>Delivered</th>
                <th>Bounced</th>
                <th>Replied</th>
                <th>Booked</th>
                <th>Last activity</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((lead) => {
                const id = String(lead.id);
                return (
                  <tr key={id}>
                    <td>
                      <input type="checkbox" checked={selected.includes(id)} onChange={() => toggle(id)} aria-label={`Select ${lead.business_name}`} />
                    </td>
                    <td>
                      <div>{lead.business_name}</div>
                      <div className="crm-muted">{lead.location || lead.category || ''}</div>
                    </td>
                    <td>{lead.email}</td>
                    <td>{lead.status || lead.sales_status || '—'}</td>
                    <td><StatusPill value={lead.email_accepted} /></td>
                    <td><StatusPill value={lead.delivered} /></td>
                    <td><StatusPill value={lead.bounced} /></td>
                    <td><StatusPill value={lead.replied} /></td>
                    <td><StatusPill value={lead.booked} /></td>
                    <td>{lead.last_activity_at || lead.last_contacted_at || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function CampaignsPage() {
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [leads, setLeads] = useState<CrmLead[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [name, setName] = useState('Manual campaign');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [previewToken, setPreviewToken] = useState('');
  const [previews, setPreviews] = useState<PersonalizedPreview[]>([]);
  const [showConfirm, setShowConfirm] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const stored = sessionStorage.getItem('bbl_crm_selected_ids');
    if (stored) {
      try {
        setSelected(JSON.parse(stored) as string[]);
      } catch {
        // ignore
      }
    }
    void Promise.all([
      api<{ templates: EmailTemplate[]; message?: string }>('/api/admin/crm/campaigns'),
      api<LeadsResponse>('/api/admin/crm/leads'),
    ])
      .then(([campaigns, leadData]) => {
        setTemplates(campaigns.templates || []);
        setLeads(leadData.leads || []);
        if (campaigns.templates?.[0]) {
          setTemplateId(campaigns.templates[0].id);
          setSubject(campaigns.templates[0].subject);
          setBody(campaigns.templates[0].body);
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load campaigns.'));
  }, []);

  function applyTemplate(id: string) {
    setTemplateId(id);
    const tpl = templates.find((item) => item.id === id);
    if (!tpl) return;
    setSubject(tpl.subject);
    setBody(tpl.body);
    setPreviewToken('');
  }

  async function onPreview() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const data = await api<{ preview_token: string; previews: PersonalizedPreview[] }>('/api/admin/crm/preview', {
        method: 'POST',
        body: JSON.stringify({
          recipient_ids: selected,
          subject,
          body,
          leads,
        }),
      });
      setPreviewToken(data.preview_token);
      setPreviews(data.previews || []);
      setMessage(`Preview ready for ${data.previews?.length || 0} recipient(s). Review, then confirm send.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preview failed.');
    } finally {
      setBusy(false);
    }
  }

  async function onSaveDraft() {
    setBusy(true);
    setError('');
    try {
      await api('/api/admin/crm/drafts', {
        method: 'POST',
        body: JSON.stringify({
          name,
          subject,
          body,
          template_id: templateId || null,
          recipient_ids: selected,
        }),
      });
      setMessage('Draft saved locally on this host.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save draft.');
    } finally {
      setBusy(false);
    }
  }

  async function onSendTest() {
    setBusy(true);
    setError('');
    try {
      const data = await api<{ message: string }>('/api/admin/crm/send-test', {
        method: 'POST',
        body: JSON.stringify({ subject, body }),
      });
      setMessage(data.message || 'Test dry-run complete. No email sent.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Test send failed.');
    } finally {
      setBusy(false);
    }
  }

  async function onConfirmSend() {
    setBusy(true);
    setError('');
    try {
      const data = await api<{ message: string; dry_run?: boolean; recipient_count?: number }>('/api/admin/crm/send', {
        method: 'POST',
        body: JSON.stringify({
          campaign_name: name,
          subject,
          body,
          recipient_ids: selected,
          preview_token: previewToken,
          confirmed: true,
          confirm_live: false,
          leads,
        }),
      });
      setShowConfirm(false);
      setMessage(data.message || 'Campaign processed.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Send failed.');
    } finally {
      setBusy(false);
    }
  }

  const sample = previews[0];

  return (
    <>
      <p className="crm-kicker">Manual campaigns</p>
      <h1>Email Campaigns</h1>
      <p className="crm-lead">Flow: select → compose → preview → confirm → send. Dry-run by default. Live ESP send stays off unless MANUAL_SEND_LIVE_ENABLED is explicitly enabled.</p>
      <div className="crm-banner warn">Zero live campaign emails in this phase. Send Test and Send Campaign are dry-run only.</div>
      {message ? <p className="crm-ok">{message}</p> : null}
      {error ? <p className="crm-error">{error}</p> : null}
      <div className="crm-grid-2">
        <div className="crm-panel">
          <h2>Composer</h2>
          <p className="crm-selected" style={{ marginTop: '.75rem' }}>
            <strong>{selected.length}</strong> recipients selected
          </p>
          <div className="crm-field">
            <label htmlFor="camp-name">Campaign name</label>
            <input id="camp-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="crm-field">
            <label htmlFor="camp-template">Template</label>
            <select id="camp-template" value={templateId} onChange={(e) => applyTemplate(e.target.value)}>
              {templates.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
              ))}
            </select>
          </div>
          <div className="crm-field">
            <label htmlFor="camp-subject">Subject</label>
            <input id="camp-subject" value={subject} onChange={(e) => { setSubject(e.target.value); setPreviewToken(''); }} />
          </div>
          <div className="crm-field">
            <label htmlFor="camp-body">Body</label>
            <textarea id="camp-body" value={body} onChange={(e) => { setBody(e.target.value); setPreviewToken(''); }} />
          </div>
          <p className="crm-muted">Placeholders: {'{{contact_name}}'}, {'{{business_name}}'}, {'{{email}}'}, {'{{location}}'}, {'{{category}}'}</p>
          <div className="crm-actions">
            <button className="crm-btn-secondary" type="button" disabled={busy} onClick={() => void onSaveDraft()}>Save Draft</button>
            <button className="crm-btn-secondary" type="button" disabled={busy || !selected.length} onClick={() => void onPreview()}>Preview Email</button>
            <button className="crm-btn-secondary" type="button" disabled={busy} onClick={() => void onSendTest()}>Send Test</button>
            <button className="crm-btn-secondary" type="button" disabled={!previewToken} onClick={() => setShowConfirm(true)}>Review Recipients</button>
            <button className="crm-btn" type="button" disabled={busy || !previewToken || !selected.length} onClick={() => setShowConfirm(true)}>Send Campaign</button>
          </div>
        </div>
        <div className="crm-panel">
          <h2>Preview</h2>
          {!sample ? (
            <div className="crm-empty">Preview a campaign to personalize the first recipient and unlock the confirm gate.</div>
          ) : (
            <>
              <p className="crm-muted" style={{ marginTop: '.75rem' }}>To: {sample.email} · {sample.business_name}</p>
              <p style={{ margin: '.75rem 0 0', fontWeight: 500 }}>{sample.subject}</p>
              <div className="crm-preview" style={{ marginTop: '.75rem' }}>{sample.body}</div>
            </>
          )}
        </div>
      </div>
      {showConfirm ? (
        <div className="crm-modal-backdrop" role="presentation" onClick={() => setShowConfirm(false)}>
          <div className="crm-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onClick={(e) => e.stopPropagation()}>
            <h3 id="confirm-title">Confirm campaign send</h3>
            <p className="crm-muted" style={{ marginTop: '.75rem' }}>
              Campaign <strong style={{ color: '#fff' }}>{name}</strong> · subject <strong style={{ color: '#fff' }}>{subject}</strong> · <strong style={{ color: '#fff' }}>{selected.length}</strong> selected
            </p>
            <ul>
              {previews.slice(0, 12).map((item) => (
                <li key={String(item.lead_id)}>{item.business_name} — {item.email}</li>
              ))}
              {previews.length > 12 ? <li>…and {previews.length - 12} more</li> : null}
            </ul>
            <p className="crm-banner warn" style={{ marginTop: '1rem' }}>
              This will run as a dry-run. No live emails will be sent while MANUAL_SEND_LIVE_ENABLED is off.
            </p>
            <div className="crm-actions">
              <button className="crm-btn-secondary" type="button" onClick={() => setShowConfirm(false)}>Cancel</button>
              <button className="crm-btn" type="button" disabled={busy} onClick={() => void onConfirmSend()}>Confirm dry-run send</button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function InboxPage() {
  const [items, setItems] = useState<CrmInboxItem[]>([]);
  const [connection, setConnection] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    void api<{ items: CrmInboxItem[]; message?: string; connection?: string }>('/api/admin/crm/inbox')
      .then((data) => {
        setItems(data.items || []);
        setConnection(data.connection || '');
        setMessage(data.message || '');
      })
      .catch(() => setMessage('Inbox unavailable until CRM sync / reply path is configured.'));
  }, []);
  return (
    <>
      <p className="crm-kicker">Replies</p>
      <h1>Inbox / Replies</h1>
      <p className="crm-lead">No auto-replies. Replies arrive via Mac sync and/or Resend inbound webhooks (tracking only).</p>
      {connectionBanner(connection, message)}
      {!items.length ? (
        <div className="crm-empty">
          {connection === 'not_connected' || connection === 'sync_pending'
            ? 'Not connected / sync pending — reply inbox stays empty until CRM sync (and optional inbound webhooks) are live.'
            : 'No replies in the sync cache yet. Reply detection needs Resend inbound or Gmail OAuth readonly on Mac — never auto-replies.'}
        </div>
      ) : (
        <div className="crm-table-wrap">
          <table className="crm-table">
            <thead>
              <tr><th>From</th><th>Subject</th><th>Received</th><th>Source</th></tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={asText(item.id)}>
                  <td>{asText(item.from_email)}</td>
                  <td>{asText(item.subject || item.snippet, '—')}</td>
                  <td>{asText(item.received_at, '—')}</td>
                  <td>{asText(item.source, 'unknown')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function BookingsPage() {
  const [bookings, setBookings] = useState<CrmBookingItem[]>([]);
  const [connection, setConnection] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    void api<{ bookings: CrmBookingItem[]; message?: string; connection?: string }>('/api/admin/crm/bookings')
      .then((data) => {
        setBookings(data.bookings || []);
        setConnection(data.connection || '');
        setMessage(data.message || '');
      })
      .catch(() => setMessage('Bookings unavailable until CRM sync.'));
  }, []);
  return (
    <>
      <p className="crm-kicker">Consultations</p>
      <h1>Bookings</h1>
      <p className="crm-lead">Confirmed bookings only. Site booking stays live; site→Mac reverse notify remains deferred. Mac may push BOOKED rows in the sync snapshot.</p>
      {connectionBanner(connection, message)}
      {!bookings.length ? (
        <div className="crm-empty">
          {connection === 'not_connected' || connection === 'sync_pending'
            ? 'Not connected / sync pending — booking rows are not shown as zero until Mac sync succeeds.'
            : 'No confirmed CRM bookings in the sync cache. Site booking works; reverse sync host is still deferred.'}
        </div>
      ) : (
        <div className="crm-table-wrap">
          <table className="crm-table">
            <thead>
              <tr><th>Name</th><th>Email</th><th>Meeting</th><th>Booked at</th><th>Status</th></tr>
            </thead>
            <tbody>
              {bookings.map((item) => (
                <tr key={asText(item.id)}>
                  <td>{asText(item.name, '—')}</td>
                  <td>{asText(item.email)}</td>
                  <td>{asText(item.meeting_start, '—')}</td>
                  <td>{asText(item.booked_at, '—')}</td>
                  <td>{asText(item.status, 'confirmed')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function AnalyticsPage() {
  const [campaigns, setCampaigns] = useState<CrmCampaignSummary[]>([]);
  const [connection, setConnection] = useState('');
  const [message, setMessage] = useState('');
  const [historyCount, setHistoryCount] = useState(0);
  useEffect(() => {
    void api<{
      campaigns: CrmCampaignSummary[];
      message?: string;
      connection?: string;
      email_history?: unknown[];
    }>('/api/admin/crm/campaigns')
      .then((data) => {
        setCampaigns(data.campaigns || []);
        setConnection(data.connection || '');
        setMessage(data.message || '');
        setHistoryCount(data.email_history?.length || 0);
      })
      .catch(() => setMessage('Campaign analytics unavailable until CRM sync.'));
  }, []);
  return (
    <>
      <p className="crm-kicker">Performance</p>
      <h1>Analytics</h1>
      <p className="crm-lead">Per-campaign accepted / delivered / bounced / replied / booked. Historical delivery stays UNKNOWN without webhook events. Synced email history (incl. the 9 cohort sends) appears after Mac push.</p>
      {connectionBanner(connection, message)}
      {historyCount ? (
        <p className="crm-muted" style={{ marginTop: '0.85rem' }}>
          Email history rows in sync cache: <strong style={{ color: '#fff' }}>{historyCount}</strong>
        </p>
      ) : null}
      {!campaigns.length ? (
        <div className="crm-empty">
          {connection === 'not_connected' || connection === 'sync_pending'
            ? 'Not connected / sync pending — campaign metrics stay blank until Mac sync.'
            : 'No campaign metrics in the sync cache yet. Local dry-run sends are logged under data/crm-send-log.json on this host.'}
        </div>
      ) : (
        <div className="crm-table-wrap">
          <table className="crm-table">
            <thead>
              <tr>
                <th>Campaign</th><th>Status</th><th>Recipients</th><th>Accepted</th><th>Delivered</th><th>Bounced</th><th>Replied</th><th>Booked</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((item) => (
                <tr key={asText(item.id)}>
                  <td>{asText(item.name || item.id)}</td>
                  <td>{asText(item.status, 'unknown')}</td>
                  <td>{asText(item.recipient_count, '—')}</td>
                  <td>{asText(item.accepted, '—')}</td>
                  <td>{asText(item.delivered, '—')}</td>
                  <td>{asText(item.bounced, '—')}</td>
                  <td>{asText(item.replied, '—')}</td>
                  <td>{asText(item.booked, '—')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function SettingsPage() {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    void api<Record<string, unknown>>('/api/admin/crm/settings').then(setData).catch(() => setData(null));
  }, []);
  const safety = (data?.safety || {}) as Record<string, unknown>;
  const mac = (data?.mac_side_required || []) as string[];
  const persistence = (data?.persistence || {}) as Record<string, unknown>;
  return (
    <>
      <p className="crm-kicker">Configuration</p>
      <h1>Settings</h1>
      <p className="crm-lead">Owner-only admin auth. CRM data arrives via authenticated Mac→website push sync — the Mac is never exposed publicly.</p>
      <div className="crm-panel">
        <h2>Connection</h2>
        <ul className="crm-muted" style={{ marginTop: '.75rem' }}>
          <li>Status: {asText(data?.connection, 'not_connected')}</li>
          <li>Last synced: {asText(data?.last_synced_at, '(never)')}</li>
          <li>Stale: {String(data?.stale)}</li>
          <li>CRM_SYNC_SECRET set: {String(data?.sync_secret_configured)}</li>
          <li>Resend webhook secret set: {String(data?.resend_webhook_secret)}</li>
          <li>Optional forward URL: {asText(data?.lead_agent_resend_webhook_url, '(not set)')}</li>
          <li>Store: {asText(persistence.store, '—')}</li>
        </ul>
      </div>
      <div className="crm-panel">
        <h2>Safety flags</h2>
        <ul className="crm-muted" style={{ marginTop: '.75rem' }}>
          <li>EMAIL_OUTREACH_ENABLED: {String(safety.EMAIL_OUTREACH_ENABLED)}</li>
          <li>EMAIL_DRY_RUN: {String(safety.EMAIL_DRY_RUN)}</li>
          <li>MANUAL_SEND_LIVE_ENABLED: {String(safety.MANUAL_SEND_LIVE_ENABLED)}</li>
          <li>FOLLOWUPS_LIVE: {String(safety.FOLLOWUPS_LIVE ?? false)}</li>
        </ul>
      </div>
      <div className="crm-panel">
        <h2>Mac sync remaining</h2>
        <ul className="crm-muted" style={{ marginTop: '.75rem' }}>
          {mac.map((item) => <li key={item}>{item}</li>)}
        </ul>
      </div>
      <div className="crm-panel">
        <h2>Push-sync contract (Mac → website)</h2>
        <pre className="crm-preview" style={{ marginTop: '.75rem' }}>{JSON.stringify(data?.contract || {}, null, 2)}</pre>
      </div>
    </>
  );
}

export function CrmDashboard() {
  return (
    <CrmShell>
      <Routes>
        <Route path="/admin" element={<OverviewPage />} />
        <Route path="/admin/leads" element={<LeadsPage />} />
        <Route path="/admin/campaigns" element={<CampaignsPage />} />
        <Route path="/admin/inbox" element={<InboxPage />} />
        <Route path="/admin/bookings" element={<BookingsPage />} />
        <Route path="/admin/analytics" element={<AnalyticsPage />} />
        <Route path="/admin/settings" element={<SettingsPage />} />
      </Routes>
    </CrmShell>
  );
}

