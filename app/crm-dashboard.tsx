import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Link, NavLink, Route, Routes, useNavigate, useSearchParams } from 'react-router-dom';
import { BblWordmark } from '../components/bbl-mark';
import { api, usePrivateIndexing } from '../lib/portal';
import type {
  CrmBookingItem,
  CrmCampaignSummary,
  CrmEmailHistoryItem,
  CrmInboxItem,
  CrmLead,
  EmailTemplate,
  PersonalizedPreview,
} from '../server/crm-types';
import { AdminHome, AdminPricing, AdminProject } from './portal-screens';
import './crm.css';
import './portal.css';

/* ------------------------------------------------------------------ */
/* Types + helpers                                                     */
/* ------------------------------------------------------------------ */

type Connection = 'not_connected' | 'sync_pending' | 'synced';

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
  connection?: Connection;
  last_synced_at?: string | null;
  metrics_trusted?: boolean;
  message?: string;
  safety: {
    EMAIL_OUTREACH_ENABLED?: boolean;
    EMAIL_DRY_RUN?: boolean;
    MANUAL_SEND_LIVE_ENABLED?: boolean;
    FOLLOWUPS_LIVE?: boolean;
  };
  sync?: { status?: Connection; stale?: boolean; last_synced_at?: string | null };
};

type LeadsResponse = {
  leads: CrmLead[];
  source: string;
  connection?: Connection;
  last_synced_at?: string | null;
  message?: string;
  empty?: boolean;
  metrics_trusted?: boolean;
};

const SELECTION_KEY = 'bbl_crm_selected_ids';

/** Escape to close + simple focus trap for modal/drawer dialogs. */
function useDialogA11y(open: boolean, onClose: () => void, containerRef: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const node = containerRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusables = () => {
      if (!node) return [] as HTMLElement[];
      return Array.from(
        node.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute('disabled') && el.tabIndex !== -1);
    };
    const list = focusables();
    list[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !node) return;
      const items = focusables();
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previouslyFocused?.focus?.();
    };
  }, [open, onClose, containerRef]);
}

function asText(value: unknown, fallback = '') {
  if (value == null) return fallback;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "Oct 8" this year, "Oct 8, 2025" otherwise. */
function fmtDate(value: unknown, withTime = false) {
  const d = parseDate(value);
  if (!d) return '—';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
  if (!withTime) return date;
  return `${date}, ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

function fmtRelative(value: unknown) {
  const d = parseDate(value);
  if (!d) return 'never';
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function isContactable(lead: CrmLead) {
  if (lead.contactable === false) return false;
  const status = String(lead.email_status || '').toUpperCase();
  if (status === 'NOT CONTACTABLE' || status === 'NOT_CONTACTABLE') return false;
  return Boolean(lead.email && lead.email.includes('@'));
}

function isBlocked(lead: CrmLead) {
  return Boolean(lead.suppressed || lead.unsubscribed || lead.bounced === 'YES');
}

function isContacted(lead: CrmLead) {
  const status = String(lead.status || lead.sales_status || '').toLowerCase();
  return lead.email_accepted === 'YES' || Boolean(lead.last_contacted_at) || status === 'contacted';
}

function lastActivity(lead: CrmLead) {
  return lead.last_activity_at || lead.last_contacted_at || null;
}

/** One stage label per lead, derived only from evidence fields. */
function stageOf(lead: CrmLead): { label: string; tone: 'good' | 'warn' | 'muted' | 'accent' } {
  if (lead.booked === 'YES') return { label: 'Booked', tone: 'good' };
  if (lead.replied === 'YES') return { label: 'Replied', tone: 'accent' };
  if (lead.unsubscribed) return { label: 'Unsubscribed', tone: 'muted' };
  if (lead.bounced === 'YES') return { label: 'Bounced', tone: 'warn' };
  if (lead.suppressed) return { label: 'Suppressed', tone: 'muted' };
  if (isContacted(lead)) return { label: 'Contacted', tone: 'muted' };
  if (!isContactable(lead)) return { label: 'No email', tone: 'muted' };
  return { label: 'Ready', tone: 'accent' };
}

function pct(part: number, whole: number) {
  if (!whole) return 0;
  return Math.round((part / whole) * 100);
}

/* ------------------------------------------------------------------ */
/* Shared status (sync + safety), loaded once by the shell             */
/* ------------------------------------------------------------------ */

type CrmStatus = {
  overview: OverviewResponse | null;
  error: string;
  reload: () => void;
};

const StatusContext = createContext<CrmStatus>({ overview: null, error: '', reload: () => undefined });

function useCrmStatus() {
  return useContext(StatusContext);
}

function useLeads() {
  const [data, setData] = useState<LeadsResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    void api<LeadsResponse>('/api/admin/crm/leads')
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load leads.'))
      .finally(() => setLoading(false));
  }, []);
  return { data, leads: data?.leads || [], error, loading };
}

function readSelection(): string[] {
  try {
    const raw = sessionStorage.getItem(SELECTION_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function writeSelection(ids: string[]) {
  try {
    sessionStorage.setItem(SELECTION_KEY, JSON.stringify(ids));
  } catch {
    // storage unavailable — selection stays in memory only
  }
}

/* ------------------------------------------------------------------ */
/* Small UI pieces                                                     */
/* ------------------------------------------------------------------ */

function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <header className="crm-page-head">
      <div>
        <h1>{title}</h1>
        {description ? <p className="crm-lead">{description}</p> : null}
      </div>
      {actions ? <div className="crm-head-actions">{actions}</div> : null}
    </header>
  );
}

function SyncNotice() {
  const { overview } = useCrmStatus();
  const connection = overview?.connection;
  if (!overview || connection === 'synced') return null;
  const label = connection === 'sync_pending' ? 'Sync pending' : 'Not connected';
  return (
    <div className="crm-banner warn" role="status">
      <strong>{label}.</strong>{' '}
      {connection === 'sync_pending'
        ? 'Showing the last snapshot. Counts may be out of date until the Mac pushes again.'
        : 'No CRM snapshot has reached the site yet. Numbers stay blank instead of showing false zeros.'}
    </div>
  );
}

function StagePill({ lead }: { lead: CrmLead }) {
  const stage = stageOf(lead);
  return <span className={`crm-pill ${stage.tone}`}>{stage.label}</span>;
}

/** [field, letter, label, flagUnknown] — booking isn't a provider event, so its Unknown stays quiet. */
const TRACK_FIELDS = [
  ['email_accepted', 'A', 'Accepted by provider', true],
  ['delivered', 'D', 'Delivered', true],
  ['replied', 'R', 'Replied', true],
  ['booked', 'B', 'Booked', false],
] as const;

function TrackingDots({ lead }: { lead: CrmLead }) {
  const contacted = isContacted(lead);
  return (
    <span className="crm-track" aria-label="Email tracking">
      {TRACK_FIELDS.map(([key, letter, label, flagUnknown]) => {
        const raw = String(lead[key] || 'UNKNOWN').toUpperCase();
        // Before any contact, UNKNOWN is just "not applicable" — render it quiet.
        const state = raw === 'YES' ? 'yes' : raw === 'NO' ? 'no' : contacted && flagUnknown ? 'unknown' : 'na';
        const text = state === 'yes' ? 'Yes' : state === 'no' ? 'No' : state === 'unknown' ? 'Unknown (no provider evidence)' : contacted ? 'Not yet' : 'Not contacted';
        return (
          <span key={key} className={`crm-dot ${state}`} title={`${label}: ${text}`}>
            {letter}
            <span className="sr-only"> {label}: {text}</span>
          </span>
        );
      })}
    </span>
  );
}

function TriPill({ value }: { value: string | null | undefined }) {
  const v = (value || 'UNKNOWN').toUpperCase();
  const cls = v === 'YES' ? 'good' : v === 'NO' ? 'muted' : 'warn';
  return <span className={`crm-pill ${cls}`}>{v === 'YES' ? 'Yes' : v === 'NO' ? 'No' : 'Unknown'}</span>;
}

function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="crm-empty">
      <strong>{title}</strong>
      {children ? <p>{children}</p> : null}
    </div>
  );
}

function CheckRow({ ok, label, value }: { ok: boolean | null; label: string; value: ReactNode }) {
  return (
    <div className="crm-check">
      <span className={`crm-check-mark ${ok === null ? 'neutral' : ok ? 'ok' : 'bad'}`} aria-hidden="true" />
      <span className="crm-check-label">{label}</span>
      <span className="crm-check-value">{value}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shell                                                               */
/* ------------------------------------------------------------------ */

const NAV: Array<{ group: string; items: Array<{ to: string; label: string; end?: boolean }> }> = [
  {
    group: 'Pipeline',
    items: [
      { to: '/admin', label: 'Overview', end: true },
      { to: '/admin/daily-review', label: 'Daily Review' },
      { to: '/admin/automation', label: 'Discover Leads' },
      { to: '/admin/lead-queue', label: 'Lead Queue' },
      { to: '/admin/campaigns', label: 'Email Campaigns' },
      { to: '/admin/inbox', label: 'Inbox' },
      { to: '/admin/analytics', label: 'Analytics' },
    ],
  },
  {
    group: 'Studio',
    items: [
      { to: '/admin/freelance', label: 'Freelance' },
      { to: '/admin/projects', label: 'Client portal' },
      { to: '/admin/settings', label: 'Settings' },
    ],
  },
];

function SidebarStatus() {
  const { overview } = useCrmStatus();
  const connection = overview?.connection;
  const synced = connection === 'synced';
  const live = Boolean(overview?.safety?.MANUAL_SEND_LIVE_ENABLED) && overview?.safety?.EMAIL_DRY_RUN === false;
  return (
    <div className="crm-side-status">
      <div className="crm-side-row">
        <span className={`crm-led ${synced ? 'ok' : 'warn'}`} aria-hidden="true" />
        <span>{synced ? 'Synced' : connection === 'sync_pending' ? 'Sync pending' : overview ? 'Not connected' : 'Checking…'}</span>
        <span className="crm-side-meta">{overview ? fmtRelative(overview.last_synced_at) : ''}</span>
      </div>
      <div className="crm-side-row">
        <span className={`crm-led ${live ? 'live' : 'off'}`} aria-hidden="true" />
        <span>{live ? 'Live sending on' : 'Sending off'}</span>
        <span className="crm-side-meta">{live ? '' : 'dry-run'}</span>
      </div>
    </div>
  );
}

function CrmShell({ children }: { children: ReactNode }) {
  usePrivateIndexing('BBL Studio CRM');
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    void api<OverviewResponse>('/api/admin/crm/overview')
      .then((data) => {
        setOverview(data);
        setError('');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load CRM status.'));
  }, []);
  useEffect(load, [load]);

  return (
    <StatusContext.Provider value={{ overview, error, reload: load }}>
      <div className="crm-shell">
        <aside className="crm-side">
          <Link to="/admin" className="crm-brand" aria-label="BBL Studio CRM home">
            <BblWordmark height={22} variant="black" />
          </Link>
          <nav className="crm-side-nav" aria-label="CRM sections">
            {NAV.map((group) => (
              <div className="crm-nav-group" key={group.group}>
                <p className="crm-nav-label">{group.group}</p>
                {group.items.map((item) => (
                  <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => (isActive ? 'active' : undefined)}>
                    {item.label}
                  </NavLink>
                ))}
              </div>
            ))}
          </nav>
          <SidebarStatus />
          <button
            type="button"
            className="crm-logout"
            onClick={() => {
              void api('/api/admin/logout', { method: 'POST', body: '{}' }).catch(() => undefined);
              window.location.replace('/admin/login');
            }}
          >
            Log out
          </button>
        </aside>
        <main className="crm-main">
          <div className="crm-wrap">{children}</div>
        </main>
      </div>
    </StatusContext.Provider>
  );
}

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

function OverviewPage() {
  const { overview, error: statusError } = useCrmStatus();
  const { leads, error, loading } = useLeads();
  const trusted = Boolean(overview?.metrics_trusted) && leads.length > 0;

  const stats = useMemo(() => {
    const contactable = leads.filter(isContactable);
    const contacted = leads.filter(isContacted);
    const yes = (key: 'email_accepted' | 'delivered' | 'replied' | 'booked') => leads.filter((l) => l[key] === 'YES').length;
    const unknownDelivery = contacted.filter((l) => l.delivered !== 'YES' && l.delivered !== 'NO' && l.bounced !== 'YES').length;
    const ready = leads.filter((l) => isContactable(l) && !isContacted(l) && !isBlocked(l)).length;
    return {
      total: leads.length,
      contactable: contactable.length,
      noEmail: leads.length - contactable.length,
      contacted: contacted.length,
      accepted: yes('email_accepted'),
      delivered: yes('delivered'),
      replied: yes('replied'),
      booked: yes('booked'),
      bounced: leads.filter((l) => l.bounced === 'YES').length,
      unknownDelivery,
      ready,
    };
  }, [leads]);

  const funnel: Array<{ label: string; value: number; note?: string }> = [
    { label: 'Leads', value: stats.total },
    { label: 'Contactable', value: stats.contactable, note: `${stats.noEmail} without email` },
    { label: 'Contacted', value: stats.contacted },
    { label: 'Provider accepted', value: stats.accepted },
    { label: 'Delivered', value: stats.delivered, note: stats.unknownDelivery ? `${stats.unknownDelivery} unknown` : undefined },
    { label: 'Replied', value: stats.replied },
    { label: 'Booked', value: stats.booked },
  ];

  const attention: Array<{ text: string; to: string; tone: 'warn' | 'accent' | 'muted' }> = [];
  if (overview && overview.connection !== 'synced') {
    attention.push({ text: 'CRM sync is not current. Run the Mac push before trusting these numbers.', to: '/admin/settings', tone: 'warn' });
  }
  if (trusted && stats.unknownDelivery) {
    attention.push({
      text: `${stats.unknownDelivery} contacted lead${stats.unknownDelivery === 1 ? ' has' : 's have'} no delivery evidence. Check the Resend webhook.`,
      to: '/admin/settings',
      tone: 'warn',
    });
  }
  if (trusted && stats.replied) {
    attention.push({ text: `${stats.replied} repl${stats.replied === 1 ? 'y' : 'ies'} to review.`, to: '/admin/inbox', tone: 'accent' });
  }
  if (trusted && stats.ready) {
    attention.push({ text: `${stats.ready} contactable lead${stats.ready === 1 ? '' : 's'} not yet contacted.`, to: '/admin/leads?view=ready', tone: 'accent' });
  }
  if (trusted && stats.noEmail) {
    attention.push({ text: `${stats.noEmail} leads have no verified email and cannot be contacted.`, to: '/admin/leads?view=no-email', tone: 'muted' });
  }

  const recent = useMemo(
    () =>
      [...leads]
        .filter((l) => parseDate(lastActivity(l)))
        .sort((a, b) => String(lastActivity(b)).localeCompare(String(lastActivity(a))))
        .slice(0, 6),
    [leads],
  );

  return (
    <>
      <PageHeader
        title="Overview"
        description="From lead to booked call. Counts come only from synced data and signed provider events."
        actions={
          <>
            <Link className="crm-btn-secondary" to="/admin/campaigns">New campaign</Link>
            <Link className="crm-btn" to="/admin/leads?view=ready">Review ready leads</Link>
          </>
        }
      />
      <SyncNotice />
      {statusError || error ? <p className="crm-error">{statusError || error}</p> : null}

      <section className="crm-panel" aria-labelledby="funnel-title">
        <div className="crm-panel-head">
          <h2 id="funnel-title">Pipeline</h2>
          <span className="crm-muted">Last activity {fmtDate(overview?.metrics?.last_activity_at)}</span>
        </div>
        <ol className="crm-funnel">
          {funnel.map((step) => (
            <li key={step.label}>
              <span className="crm-funnel-label">{step.label}</span>
              <strong>{trusted ? step.value : loading ? '…' : '—'}</strong>
              <span className="crm-bar" aria-hidden="true">
                <span style={{ width: trusted ? `${Math.max(pct(step.value, stats.total), step.value ? 2 : 0)}%` : '0%' }} />
              </span>
              <span className="crm-funnel-note">{trusted && step.note ? step.note : ' '}</span>
            </li>
          ))}
        </ol>
      </section>

      <div className="crm-grid-2">
        <section className="crm-panel" aria-labelledby="attention-title">
          <div className="crm-panel-head">
            <h2 id="attention-title">Needs attention</h2>
          </div>
          {attention.length ? (
            <ul className="crm-attention">
              {attention.map((item) => (
                <li key={item.text}>
                  <span className={`crm-led ${item.tone === 'warn' ? 'warn' : item.tone === 'accent' ? 'accent' : 'off'}`} aria-hidden="true" />
                  <span>{item.text}</span>
                  <Link to={item.to} className="crm-link">Open</Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="crm-muted crm-pad">Nothing waiting.</p>
          )}
        </section>

        <section className="crm-panel" aria-labelledby="recent-title">
          <div className="crm-panel-head">
            <h2 id="recent-title">Recent activity</h2>
            <Link to="/admin/leads" className="crm-link">All leads</Link>
          </div>
          {recent.length ? (
            <ul className="crm-recent">
              {recent.map((lead) => (
                <li key={String(lead.id)}>
                  <span className="crm-recent-name">{lead.business_name}</span>
                  <StagePill lead={lead} />
                  <span className="crm-muted">{fmtDate(lastActivity(lead))}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="crm-muted crm-pad">{loading ? 'Loading…' : 'No dated activity in the snapshot yet.'}</p>
          )}
        </section>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Leads                                                               */
/* ------------------------------------------------------------------ */

const VIEWS: Array<{ id: string; label: string; test: (l: CrmLead) => boolean }> = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'ready', label: 'Ready', test: (l) => isContactable(l) && !isContacted(l) && !isBlocked(l) },
  { id: 'contacted', label: 'Contacted', test: isContacted },
  { id: 'replied', label: 'Replied', test: (l) => l.replied === 'YES' },
  { id: 'booked', label: 'Booked', test: (l) => l.booked === 'YES' },
  { id: 'no-email', label: 'No email', test: (l) => !isContactable(l) },
];

function LeadDrawer({ lead, onClose, onCompose }: { lead: CrmLead; onClose: () => void; onCompose: () => void }) {
  const dialogRef = useRef<HTMLElement | null>(null);
  useDialogA11y(true, onClose, dialogRef);
  const contactable = isContactable(lead);
  const observation = lead.website_observation || lead.outreach_observation || '';
  const rows: Array<[string, ReactNode]> = [
    ['Contact', lead.contact_name || '—'],
    ['Email', contactable ? lead.email : <span className="crm-muted">No verified email</span>],
    ['Phone', lead.phone || '—'],
    ['Location', lead.location || '—'],
    ['Category', lead.category || '—'],
    ['Website observation', observation || <span className="crm-muted">Missing — excluded from approved outreach</span>],
    ['Outreach status', lead.email_outreach_status || '—'],
    ['Last contacted', fmtDate(lead.last_contacted_at, true)],
    ['Last activity', fmtDate(lead.last_activity_at, true)],
  ];
  return (
    <div className="crm-drawer-backdrop" role="presentation" onClick={onClose}>
      <aside
        ref={dialogRef as React.RefObject<HTMLElement | null>}
        className="crm-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lead-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="crm-drawer-head">
          <div>
            <h2 id="lead-title">{lead.business_name}</h2>
            <StagePill lead={lead} />
          </div>
          <button type="button" className="crm-icon-btn" onClick={onClose} aria-label="Close">×</button>
        </div>
        <dl className="crm-dl">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <h3 className="crm-subhead">Email tracking</h3>
        <dl className="crm-dl">
          <div><dt>Provider accepted</dt><dd><TriPill value={lead.email_accepted} /></dd></div>
          <div><dt>Delivered</dt><dd><TriPill value={lead.delivered} /></dd></div>
          <div><dt>Bounced</dt><dd><TriPill value={lead.bounced} /></dd></div>
          <div><dt>Replied</dt><dd><TriPill value={lead.replied} /></dd></div>
          <div><dt>Booked</dt><dd><TriPill value={lead.booked} /></dd></div>
          <div><dt>Provider message ids</dt><dd>{lead.provider_message_ids?.length || 0}</dd></div>
        </dl>
        {lead.suppressed || lead.unsubscribed ? (
          <p className="crm-banner warn">{lead.unsubscribed ? 'Unsubscribed.' : 'Suppressed.'} Excluded from every send.</p>
        ) : null}
        {lead.notes ? (
          <>
            <h3 className="crm-subhead">Notes</h3>
            <p className="crm-notes">{lead.notes}</p>
          </>
        ) : null}
        <div className="crm-drawer-foot">
          <button type="button" className="crm-btn" disabled={!contactable || isBlocked(lead)} onClick={onCompose}>
            Draft email
          </button>
        </div>
      </aside>
    </div>
  );
}

function LeadsPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { data, leads, error, loading } = useLeads();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'activity' | 'name'>('activity');
  const [selected, setSelected] = useState<string[]>(() => readSelection());
  const [open, setOpen] = useState<CrmLead | null>(null);
  const view = VIEWS.find((v) => v.id === params.get('view')) || VIEWS[0];

  const counts = useMemo(() => Object.fromEntries(VIEWS.map((v) => [v.id, leads.filter(v.test).length])), [leads]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = leads.filter(view.test).filter((lead) =>
      !needle
        ? true
        : [lead.business_name, lead.contact_name, lead.email, lead.location, lead.category]
            .filter(Boolean)
            .some((value) => String(value).toLowerCase().includes(needle)),
    );
    return rows.sort((a, b) =>
      sort === 'name'
        ? a.business_name.localeCompare(b.business_name)
        : String(lastActivity(b) || '').localeCompare(String(lastActivity(a) || '')),
    );
  }, [leads, view, q, sort]);

  const selectable = filtered.filter((l) => isContactable(l) && !isBlocked(l)).map((l) => String(l.id));
  const allSelected = selectable.length > 0 && selectable.every((id) => selected.includes(id));

  function update(next: string[]) {
    setSelected(next);
    writeSelection(next);
  }

  function toggle(id: string) {
    update(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  }

  function compose(ids = selected) {
    writeSelection(ids);
    navigate('/admin/campaigns');
  }

  const connection = data?.connection;

  return (
    <>
      <PageHeader
        title="Leads"
        description="Only leads with a verified email can be selected. Tracking stays Unknown until a provider event confirms it."
      />
      <SyncNotice />
      {error ? <p className="crm-error">{error}</p> : null}

      <div className="crm-toolbar">
        <div className="crm-tabs" role="tablist" aria-label="Lead views">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={v.id === view.id}
              className={v.id === view.id ? 'active' : undefined}
              onClick={() => setParams(v.id === 'all' ? {} : { view: v.id })}
            >
              {v.label}
              <span className="crm-count">{loading ? '' : counts[v.id]}</span>
            </button>
          ))}
        </div>
        <div className="crm-filters">
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search leads" />
          <select value={sort} onChange={(e) => setSort(e.target.value as 'activity' | 'name')} aria-label="Sort leads">
            <option value="activity">Recent activity</option>
            <option value="name">Name A–Z</option>
          </select>
        </div>
      </div>

      {loading ? (
        <div className="crm-skeleton" aria-busy="true" aria-label="Loading leads" />
      ) : !filtered.length ? (
        connection === 'not_connected' ? (
          <Empty title="No snapshot yet">
            The Mac hasn't pushed CRM data. Run <code>scripts/crm-mac-sync/push_crm_sync.py</code> while the lead agent is online.
          </Empty>
        ) : (
          <Empty title="No leads in this view">Try another view or clear the search.</Empty>
        )
      ) : (
        <div className="crm-table-wrap">
          <table className="crm-table">
            <thead>
              <tr>
                <th className="crm-col-check">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    disabled={!selectable.length}
                    onChange={() => update(allSelected ? selected.filter((id) => !selectable.includes(id)) : [...new Set([...selected, ...selectable])])}
                    aria-label="Select all contactable leads in this view"
                  />
                </th>
                <th>Business</th>
                <th>Contact</th>
                <th>Stage</th>
                <th>
                  <span title="A accepted · D delivered · R replied · B booked">Tracking</span>
                </th>
                <th className="crm-col-date">Last activity</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((lead) => {
                const id = String(lead.id);
                const canSelect = isContactable(lead) && !isBlocked(lead);
                return (
                  <tr key={id} className={selected.includes(id) ? 'selected' : undefined} onClick={() => setOpen(lead)}>
                    <td className="crm-col-check" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selected.includes(id)}
                        disabled={!canSelect}
                        onChange={() => toggle(id)}
                        aria-label={`Select ${lead.business_name}`}
                        title={canSelect ? undefined : 'Not contactable'}
                      />
                    </td>
                    <td>
                      <button type="button" className="crm-row-link" onClick={(e) => { e.stopPropagation(); setOpen(lead); }}>
                        {lead.business_name}
                      </button>
                      <div className="crm-muted crm-sub">{lead.location || lead.category || ''}</div>
                    </td>
                    <td>
                      {isContactable(lead) ? (
                        <>
                          {lead.contact_name ? <div>{lead.contact_name}</div> : null}
                          <div className={lead.contact_name ? 'crm-muted crm-sub' : 'crm-muted'}>{lead.email}</div>
                        </>
                      ) : (
                        <span className="crm-muted">No email</span>
                      )}
                    </td>
                    <td><StagePill lead={lead} /></td>
                    <td><TrackingDots lead={lead} /></td>
                    <td className="crm-col-date crm-muted">{fmtDate(lastActivity(lead))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="crm-legend">
            <span className="crm-dot yes">A</span> confirmed <span className="crm-dot unknown">A</span> unknown <span className="crm-dot no">A</span> no
            <span className="crm-legend-sep">·</span> A accepted · D delivered · R replied · B booked
          </p>
        </div>
      )}

      {selected.length ? (
        <div className="crm-bulkbar" role="region" aria-label="Selection">
          <span><strong>{selected.length}</strong> selected</span>
          <button type="button" className="crm-btn-ghost" onClick={() => update([])}>Clear</button>
          <button type="button" className="crm-btn" onClick={() => compose()}>Compose email</button>
        </div>
      ) : null}

      {open ? (
        <LeadDrawer
          lead={open}
          onClose={() => setOpen(null)}
          onCompose={() => compose([...new Set([...selected, String(open.id)])])}
        />
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Campaigns                                                           */
/* ------------------------------------------------------------------ */

const PLACEHOLDERS = ['contact_name', 'business_name', 'website_observation', 'location', 'category', 'signed_unsubscribe_url', 'BUSINESS_POSTAL_ADDRESS'];

type PolicyIssue = { code: string; message: string; severity: 'block' | 'warn' };

function Stepper({ step }: { step: number }) {
  const steps = ['Recipients', 'Compose', 'Preview', 'Confirm'];
  return (
    <ol className="crm-stepper" aria-label="Campaign steps">
      {steps.map((label, i) => (
        <li key={label} className={i < step ? 'done' : i === step ? 'current' : undefined} aria-current={i === step ? 'step' : undefined}>
          <span className="crm-step-num">{i + 1}</span>
          {label}
        </li>
      ))}
    </ol>
  );
}

function CampaignsPage() {
  const { overview } = useCrmStatus();
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [leads, setLeads] = useState<CrmLead[]>([]);
  const [selected, setSelected] = useState<string[]>(() => readSelection());
  const [templateId, setTemplateId] = useState('');
  const [name, setName] = useState('Manual campaign');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [previewToken, setPreviewToken] = useState('');
  const [previews, setPreviews] = useState<PersonalizedPreview[]>([]);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [showConfirm, setShowConfirm] = useState(false);
  const [sendForReal, setSendForReal] = useState(false);
  const [policyIssues, setPolicyIssues] = useState<PolicyIssue[]>([]);
  const [exclusions, setExclusions] = useState<Array<{ id: number | string; reason: string }>>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const confirmRef = useRef<HTMLDivElement | null>(null);
  useDialogA11y(showConfirm, () => setShowConfirm(false), confirmRef);

  useEffect(() => {
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

  const recipients = useMemo(() => {
    const wanted = new Set(selected);
    return leads.filter((l) => wanted.has(String(l.id)));
  }, [leads, selected]);

  function invalidate() {
    setPreviewToken('');
  }

  function removeRecipient(id: string) {
    const next = selected.filter((x) => x !== id);
    setSelected(next);
    writeSelection(next);
    invalidate();
  }

  function applyTemplate(id: string) {
    setTemplateId(id);
    const tpl = templates.find((item) => item.id === id);
    if (!tpl) return;
    setSubject(tpl.subject);
    setBody(tpl.body);
    invalidate();
  }

  function insertPlaceholder(key: string) {
    setBody((prev) => `${prev}{{${key}}}`);
    invalidate();
  }

  async function onPreview() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const data = await api<{
        preview_token: string;
        previews: PersonalizedPreview[];
        policy_issues?: PolicyIssue[];
        exclusions?: Array<{ id: number | string; reason: string }>;
      }>('/api/admin/crm/preview', {
        method: 'POST',
        body: JSON.stringify({ recipient_ids: selected, subject, body }),
      });
      setPreviewToken(data.preview_token);
      setPreviews(data.previews || []);
      setPolicyIssues(data.policy_issues || []);
      setExclusions(data.exclusions || []);
      setPreviewIndex(0);
      setSendForReal(false);
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
        body: JSON.stringify({ name, subject, body, template_id: templateId || null, recipient_ids: selected }),
      });
      setMessage('Draft saved.');
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
      const data = await api<{
        message: string;
        dry_run?: boolean;
        recipient_count?: number;
        excluded?: Array<{ id: number | string; reason: string }>;
        policy_issues?: PolicyIssue[];
      }>('/api/admin/crm/send', {
        method: 'POST',
        body: JSON.stringify({
          campaign_name: name,
          subject,
          body,
          recipient_ids: selected,
          preview_token: previewToken,
          confirmed: true,
          confirm_live: sendForReal,
        }),
      });
      setShowConfirm(false);
      setMessage(data.message || 'Campaign processed.');
      if (data.excluded) setExclusions(data.excluded);
      if (data.policy_issues) setPolicyIssues(data.policy_issues);
      setSendForReal(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Send failed.');
    } finally {
      setBusy(false);
    }
  }

  const step = !selected.length ? 0 : !previewToken ? 1 : showConfirm ? 3 : 2;
  const sample = previews[Math.min(previewIndex, previews.length - 1)];
  const liveCapable = Boolean(overview?.safety?.MANUAL_SEND_LIVE_ENABLED) && overview?.safety?.EMAIL_DRY_RUN === false;
  const policyBlocked = policyIssues.some((i) => i.severity === 'block');
  const includedPreviews = previews.filter((p) => !p.excluded);

  return (
    <>
      <PageHeader
        title="Email Campaigns"
        description="Select recipients, write, preview every personalization, then confirm."
        actions={
          <>
            <button className="crm-btn-ghost" type="button" disabled={busy} onClick={() => void onSaveDraft()}>Save draft</button>
            <button className="crm-btn-secondary" type="button" disabled={busy || !subject} onClick={() => void onSendTest()}>Send test</button>
          </>
        }
      />
      <div className={`crm-banner ${liveCapable ? 'warn' : ''}`} role="note">
        {liveCapable
          ? <><strong>Live sending flags are on.</strong> Check “Send for real” only after owner approval. Prices stay out of cold email.</>
          : <><strong>Dry-run mode.</strong> Live outreach is off. Nothing is sent unless flags + “Send for real” are set.</>}
      </div>
      <Stepper step={step} />
      {message ? <p className="crm-ok" role="status">{message}</p> : null}
      {error ? <p className="crm-error" role="alert">{error}</p> : null}
      {policyIssues.length ? (
        <div className={`crm-banner ${policyBlocked ? 'warn' : ''}`} role="status">
          <strong>Policy {policyBlocked ? 'blocks' : 'notes'}</strong>
          <ul className="crm-confirm-list">
            {policyIssues.map((issue) => (
              <li key={issue.code + issue.message}>
                <span>{issue.severity === 'block' ? 'Block' : 'Warn'}</span>
                <span className="crm-muted">{issue.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {exclusions.length ? (
        <div className="crm-banner" role="status">
          <strong>{exclusions.length} exclusion{exclusions.length === 1 ? '' : 's'}</strong>
          <ul className="crm-confirm-list">
            {exclusions.slice(0, 12).map((row) => (
              <li key={String(row.id)}>
                <span>Lead {String(row.id)}</span>
                <span className="crm-muted">{row.reason}</span>
              </li>
            ))}
            {exclusions.length > 12 ? <li className="crm-muted">+{exclusions.length - 12} more</li> : null}
          </ul>
        </div>
      ) : null}

      <div className="crm-grid-2 crm-compose">
        <section className="crm-panel">
          <div className="crm-panel-head">
            <h2>Recipients <span className="crm-count">{selected.length}</span></h2>
            <Link to="/admin/leads?view=ready" className="crm-link">{selected.length ? 'Edit in Leads' : 'Select in Leads'}</Link>
          </div>
          {recipients.length ? (
            <ul className="crm-chips">
              {recipients.slice(0, 24).map((lead) => (
                <li key={String(lead.id)}>
                  {lead.business_name}
                  <button type="button" onClick={() => removeRecipient(String(lead.id))} aria-label={`Remove ${lead.business_name}`}>×</button>
                </li>
              ))}
              {recipients.length > 24 ? <li className="crm-muted">+{recipients.length - 24} more</li> : null}
            </ul>
          ) : (
            <p className="crm-muted crm-pad">No recipients yet. Pick contactable leads first.</p>
          )}

          <div className="crm-field-row">
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
          </div>
          <div className="crm-field">
            <label htmlFor="camp-subject">Subject</label>
            <input id="camp-subject" value={subject} onChange={(e) => { setSubject(e.target.value); invalidate(); }} />
          </div>
          <div className="crm-field">
            <label htmlFor="camp-body">Message</label>
            <textarea id="camp-body" value={body} onChange={(e) => { setBody(e.target.value); invalidate(); }} />
          </div>
          <div className="crm-placeholders" aria-label="Insert placeholder">
            {PLACEHOLDERS.map((key) => (
              <button key={key} type="button" onClick={() => insertPlaceholder(key)}>{`{{${key}}}`}</button>
            ))}
          </div>
          <div className="crm-actions">
            <button className="crm-btn" type="button" disabled={busy || !selected.length || !subject || !body} onClick={() => void onPreview()}>
              {previewToken ? 'Refresh preview' : 'Preview'}
            </button>
          </div>
        </section>

        <section className="crm-panel">
          <div className="crm-panel-head">
            <h2>Preview</h2>
            {previews.length > 1 ? (
              <div className="crm-pager">
                <button type="button" className="crm-icon-btn" disabled={previewIndex === 0} onClick={() => setPreviewIndex((i) => i - 1)} aria-label="Previous recipient">‹</button>
                <span className="crm-muted">{previewIndex + 1} / {previews.length}</span>
                <button type="button" className="crm-icon-btn" disabled={previewIndex >= previews.length - 1} onClick={() => setPreviewIndex((i) => i + 1)} aria-label="Next recipient">›</button>
              </div>
            ) : null}
          </div>
          {!sample || !previewToken ? (
            <Empty title={previews.length ? 'Preview is out of date' : 'No preview yet'}>
              {previews.length ? 'You changed recipients or copy. Preview again to unlock sending.' : 'Preview personalizes the message for each recipient and unlocks sending.'}
            </Empty>
          ) : (
            <>
              <div className="crm-mail">
                <dl>
                  <div><dt>From</dt><dd>BBL Studio &lt;hello@bbl.studio&gt;</dd></div>
                  <div><dt>To</dt><dd>{sample.email} · {sample.business_name}</dd></div>
                  <div><dt>Subject</dt><dd className="crm-mail-subject">{sample.subject}</dd></div>
                </dl>
                <div className="crm-mail-body">{sample.body}</div>
              </div>
              <div className="crm-actions">
                <button
                  className="crm-btn"
                  type="button"
                  disabled={busy || policyBlocked || !includedPreviews.length}
                  onClick={() => setShowConfirm(true)}
                >
                  Review &amp; send to {includedPreviews.length || previews.length}
                </button>
              </div>
            </>
          )}
        </section>
      </div>

      {showConfirm ? (
        <div className="crm-modal-backdrop" role="presentation" onClick={() => setShowConfirm(false)}>
          <div
            ref={confirmRef}
            className="crm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="confirm-title">Send “{name}”?</h3>
            <dl className="crm-dl compact">
              <div><dt>Subject</dt><dd>{subject}</dd></div>
              <div><dt>Recipients</dt><dd>{includedPreviews.length}</dd></div>
              <div><dt>Mode</dt><dd>{sendForReal && liveCapable ? 'Live (Send for real)' : 'Dry-run (nothing is sent)'}</dd></div>
            </dl>
            <ul className="crm-confirm-list">
              {includedPreviews.slice(0, 12).map((item) => (
                <li key={String(item.lead_id)}><span>{item.business_name}</span><span className="crm-muted">{item.email}</span></li>
              ))}
              {includedPreviews.length > 12 ? <li className="crm-muted">+{includedPreviews.length - 12} more</li> : null}
            </ul>
            <p className="crm-muted">Missing website observations, unsubscribed, suppressed, bounced, and 30-day contacts are excluded. No prices in cold email.</p>
            <label className="crm-field" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={sendForReal}
                disabled={!liveCapable}
                onChange={(e) => setSendForReal(e.target.checked)}
              />
              <span>
                Send for real
                {!liveCapable ? ' (disabled while live flags are off)' : ' — only after owner approval'}
              </span>
            </label>
            <div className="crm-actions end">
              <button className="crm-btn-ghost" type="button" onClick={() => setShowConfirm(false)}>Cancel</button>
              <button className="crm-btn" type="button" disabled={busy || policyBlocked} onClick={() => void onConfirmSend()}>
                {sendForReal && liveCapable ? 'Send campaign' : 'Run dry-run'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Inbox                                                               */
/* ------------------------------------------------------------------ */

function InboxPage() {
  const [items, setItems] = useState<CrmInboxItem[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    void api<{ items: CrmInboxItem[] }>('/api/admin/crm/inbox')
      .then((data) => setItems(data.items || []))
      .catch((err) => {
        setItems([]);
        setError(err instanceof Error ? err.message : 'Inbox unavailable.');
      });
  }, []);
  const sorted = useMemo(
    () => [...(items || [])].sort((a, b) => String(b.received_at || '').localeCompare(String(a.received_at || ''))),
    [items],
  );
  return (
    <>
      <PageHeader title="Inbox" description="Replies matched to leads. Tracking only — nothing here sends a response." />
      <SyncNotice />
      {error ? <p className="crm-error">{error}</p> : null}
      {items === null ? (
        <div className="crm-skeleton" aria-busy="true" aria-label="Loading inbox" />
      ) : !sorted.length ? (
        <Empty title="No replies imported">
          An empty inbox here does not mean nobody replied. Replies to hello@bbl.studio land in Microsoft 365, which is not
          connected to the CRM yet. Check that mailbox directly, including Junk.
        </Empty>
      ) : (
        <div className="crm-table-wrap">
          <table className="crm-table">
            <thead>
              <tr><th>From</th><th>Message</th><th className="crm-col-date">Received</th><th>Source</th></tr>
            </thead>
            <tbody>
              {sorted.map((item) => (
                <tr key={asText(item.id)}>
                  <td>{asText(item.from_email)}</td>
                  <td>
                    <div>{asText(item.subject, '(no subject)')}</div>
                    {item.snippet ? <div className="crm-muted crm-sub crm-clamp">{item.snippet}</div> : null}
                  </td>
                  <td className="crm-col-date crm-muted">{fmtDate(item.received_at, true)}</td>
                  <td><span className="crm-pill muted">{item.source === 'resend_inbound' ? 'Resend' : item.source === 'gmail' ? 'Gmail' : 'Unknown'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Bookings                                                            */
/* ------------------------------------------------------------------ */

function BookingsPage() {
  const [bookings, setBookings] = useState<CrmBookingItem[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    void api<{ bookings: CrmBookingItem[] }>('/api/admin/crm/bookings')
      .then((data) => setBookings(data.bookings || []))
      .catch((err) => {
        setBookings([]);
        setError(err instanceof Error ? err.message : 'Bookings unavailable.');
      });
  }, []);
  const now = Date.now();
  const sorted = useMemo(
    () => [...(bookings || [])].sort((a, b) => String(b.meeting_start || '').localeCompare(String(a.meeting_start || ''))),
    [bookings],
  );
  return (
    <>
      <PageHeader title="Bookings" description="Consultations booked from the site or synced from the Mac." />
      <SyncNotice />
      {error ? <p className="crm-error">{error}</p> : null}
      {bookings === null ? (
        <div className="crm-skeleton" aria-busy="true" aria-label="Loading bookings" />
      ) : !sorted.length ? (
        <Empty title="No bookings in the CRM">Site booking works; bookings appear here once synced into the CRM snapshot.</Empty>
      ) : (
        <div className="crm-table-wrap">
          <table className="crm-table">
            <thead>
              <tr><th>Meeting</th><th>Name</th><th>Email</th><th className="crm-col-date">Booked</th><th>Status</th></tr>
            </thead>
            <tbody>
              {sorted.map((item) => {
                const upcoming = (parseDate(item.meeting_start)?.getTime() || 0) > now;
                return (
                  <tr key={asText(item.id)}>
                    <td>
                      {fmtDate(item.meeting_start, true)}
                      {upcoming ? <span className="crm-pill accent crm-inline">Upcoming</span> : null}
                    </td>
                    <td>{asText(item.name, '—')}</td>
                    <td className="crm-muted">{asText(item.email)}</td>
                    <td className="crm-col-date crm-muted">{fmtDate(item.booked_at)}</td>
                    <td><span className={`crm-pill ${item.status === 'confirmed' ? 'good' : 'muted'}`}>{item.status === 'confirmed' ? 'Confirmed' : 'Unknown'}</span></td>
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

/* ------------------------------------------------------------------ */
/* Analytics                                                           */
/* ------------------------------------------------------------------ */

function AnalyticsPage() {
  const [campaigns, setCampaigns] = useState<CrmCampaignSummary[] | null>(null);
  const [history, setHistory] = useState<CrmEmailHistoryItem[]>([]);
  const [outreach, setOutreach] = useState<{
    empty?: boolean;
    metrics_trusted?: boolean;
    message?: string;
    metrics?: Record<string, number> | null;
  } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    void Promise.all([
      api<{ campaigns: CrmCampaignSummary[]; email_history?: CrmEmailHistoryItem[] }>('/api/admin/crm/campaigns'),
      api<{ empty?: boolean; metrics_trusted?: boolean; message?: string; metrics?: Record<string, number> | null }>(
        '/api/admin/crm/outreach-analytics',
      ),
    ])
      .then(([data, oa]) => {
        setCampaigns(data.campaigns || []);
        setHistory(data.email_history || []);
        setOutreach(oa);
      })
      .catch((err) => {
        setCampaigns([]);
        setError(err instanceof Error ? err.message : 'Analytics unavailable.');
      });
  }, []);

  const live = history.filter((h) => !h.dry_run);
  const tiles = [
    { label: 'Live sends', value: live.length, note: `${history.length - live.length} dry-runs excluded` },
    { label: 'Provider accepted', value: live.filter((h) => h.accepted === 'YES').length, note: `${live.filter((h) => h.accepted !== 'YES').length} unknown` },
    { label: 'Delivered', value: live.filter((h) => h.delivered === 'YES').length, note: `${live.filter((h) => h.delivered === 'UNKNOWN').length} unknown` },
    { label: 'Bounced', value: live.filter((h) => h.bounced === 'YES').length },
    { label: 'Replied', value: live.filter((h) => h.replied === 'YES').length },
  ];
  const rate = (n?: number, d?: number) => (n == null || !d ? '—' : `${pct(n, d)}%`);

  return (
    <>
      <PageHeader title="Analytics" description="KPIs from real data only. Empty when unsynced — never fake zeros. Unknown stays Unknown until a provider event." />
      <SyncNotice />
      {error ? <p className="crm-error">{error}</p> : null}
      {outreach?.empty || !outreach?.metrics_trusted ? (
        <Empty title="No outreach metrics yet">{outreach?.message || 'Queue activity and live sends will appear here.'}</Empty>
      ) : outreach?.metrics ? (
        <div className="crm-tiles">
          {Object.entries(outreach.metrics)
            .filter(([, v]) => typeof v === 'number')
            .map(([label, value]) => (
              <div className="crm-tile" key={label}>
                <span>{label.replace(/_/g, ' ')}</span>
                <strong>{value}</strong>
                <em>trusted</em>
              </div>
            ))}
        </div>
      ) : null}
      {history.length ? (
        <div className="crm-tiles">
          {tiles.map((t) => (
            <div className="crm-tile" key={t.label}>
              <span>{t.label}</span>
              <strong>{t.value}</strong>
              <em>{t.note || ' '}</em>
            </div>
          ))}
        </div>
      ) : null}
      <section className="crm-panel">
        <div className="crm-panel-head"><h2>Campaigns</h2></div>
        {campaigns === null ? (
          <div className="crm-skeleton" aria-busy="true" aria-label="Loading campaigns" />
        ) : !campaigns.length ? (
          <p className="crm-muted crm-pad">No campaign summaries in the snapshot yet.</p>
        ) : (
          <div className="crm-table-wrap flush">
            <table className="crm-table">
              <thead>
                <tr>
                  <th>Campaign</th><th>Status</th><th className="num">Recipients</th><th className="num">Accepted</th>
                  <th className="num">Delivered</th><th className="num">Bounced</th><th className="num">Replied</th><th className="num">Reply rate</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((item) => (
                  <tr key={asText(item.id)}>
                    <td>
                      <div>{asText(item.name || item.id)}</div>
                      <div className="crm-muted crm-sub">{fmtDate(item.sent_at || item.created_at)}</div>
                    </td>
                    <td><span className="crm-pill muted">{asText(item.status, 'unknown').replace('_', ' ')}</span></td>
                    <td className="num">{asText(item.recipient_count, '—')}</td>
                    <td className="num">{asText(item.accepted, '—')}</td>
                    <td className="num">{asText(item.delivered, '—')}</td>
                    <td className="num">{asText(item.bounced, '—')}</td>
                    <td className="num">{asText(item.replied, '—')}</td>
                    <td className="num">{rate(item.replied, item.recipient_count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Daily Review (Mon–Fri top 20)                                       */
/* ------------------------------------------------------------------ */

type Daily20Candidate = {
  id: string;
  business_name: string;
  email: string;
  location?: string | null;
  website?: string | null;
  website_observation?: string | null;
  score_total?: number | null;
  niche_priority?: number;
  preview_subject?: string | null;
  preview_body?: string | null;
  queue_status?: string;
};

type Daily20Response = {
  cohort?: {
    day_key: string;
    weekday: boolean;
    message: string;
    discovered_count: number;
    target_discover: number;
    target_qualify: number;
    qualified: Daily20Candidate[];
  };
  daily_cap?: { effective_cap: number; remaining: number; sent_today: number; day_key: string };
  drafts_approved?: number;
  send_window?: { label?: string };
  mail_app_interim?: string;
  message?: string;
};

function DailyReviewPage() {
  const [data, setData] = useState<Daily20Response | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState<Daily20Candidate | null>(null);

  const load = useCallback(() => {
    void api<Daily20Response>('/api/admin/crm/daily-20')
      .then((d) => {
        setData(d);
        setError('');
        const ids = (d.cohort?.qualified || []).map((q) => q.id);
        setSelected((prev) => prev.filter((id) => ids.includes(id)));
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Daily review unavailable.'));
  }, []);

  useEffect(load, [load]);

  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPreview(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [preview]);

  const qualified = data?.cohort?.qualified || [];
  const selectAllQualified = () => setSelected(qualified.map((q) => q.id));

  const bulkApprove = async (all = false) => {
    setBusy(all ? 'all' : 'sel');
    setNote('');
    try {
      const res = await api<{ message?: string; approved?: string[]; blocked?: unknown[] }>(
        '/api/admin/crm/daily-20/approve',
        {
          method: 'POST',
          body: JSON.stringify(
            all ? { select_all_qualified: true } : { lead_ids: selected },
          ),
        },
      );
      setNote(res.message || `Approved ${res.approved?.length || 0}.`);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Approve failed.');
    } finally {
      setBusy('');
    }
  };

  const cap = data?.daily_cap;

  return (
    <>
      <PageHeader
        title="Daily Review"
        description="Mon–Fri cohort: qualify best 20 (OC first). Observation-gated previews. Live send stays OFF until owner approval."
        actions={
          <>
            <button type="button" className="crm-btn-secondary" disabled={Boolean(busy)} onClick={load}>Refresh</button>
            <button type="button" className="crm-btn-secondary" disabled={!qualified.length || Boolean(busy)} onClick={selectAllQualified}>
              Select All Qualified
            </button>
            <button type="button" className="crm-btn" disabled={!selected.length || Boolean(busy)} onClick={() => void bulkApprove(false)}>
              {busy === 'sel' ? 'Approving…' : `Approve selected (${selected.length})`}
            </button>
          </>
        }
      />
      {error ? <p className="crm-error">{error}</p> : null}
      {note ? <p className="crm-ok">{note}</p> : null}
      <div className="crm-tiles">
        <div className="crm-tile">
          <span>Day (PT)</span>
          <strong>{data?.cohort?.day_key || '—'}</strong>
          <em>{data?.cohort?.weekday ? 'weekday' : 'weekend idle'}</em>
        </div>
        <div className="crm-tile">
          <span>Discovered pool</span>
          <strong>{data?.cohort?.discovered_count ?? '—'}</strong>
          <em>target ≥{data?.cohort?.target_discover ?? 30}</em>
        </div>
        <div className="crm-tile">
          <span>Qualified</span>
          <strong>{qualified.length}</strong>
          <em>cap {data?.cohort?.target_qualify ?? 20}</em>
        </div>
        <div className="crm-tile">
          <span>Daily send counter</span>
          <strong>{cap ? `${cap.sent_today}/${cap.effective_cap}` : '—'}</strong>
          <em>{cap ? `${cap.remaining} left · ${cap.day_key}` : 'LA midnight reset'}</em>
        </div>
      </div>
      {data?.cohort?.message ? <p className="crm-banner">{data.cohort.message}</p> : null}
      {data?.send_window?.label ? (
        <p className="crm-muted crm-pad">Send window: {data.send_window.label}. Queued is never marked sent until provider confirm.</p>
      ) : null}

      <section className="crm-panel">
        <div className="crm-panel-head">
          <h2>Review queue</h2>
          <button type="button" className="crm-btn-secondary" disabled={Boolean(busy) || !qualified.length} onClick={() => void bulkApprove(true)}>
            {busy === 'all' ? 'Approving…' : 'Approve all qualified'}
          </button>
        </div>
        {!qualified.length ? (
          <Empty title="No qualified leads today">Run Discover Leads or sync CRM. Need website + public email + real observation.</Empty>
        ) : (
          <div className="crm-table-wrap">
            <table className="crm-table">
              <thead>
                <tr>
                  <th aria-label="Select" />
                  <th>Name</th>
                  <th>Location</th>
                  <th>Website</th>
                  <th>Email</th>
                  <th>Score</th>
                  <th>Findings</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {qualified.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.includes(row.id)}
                        onChange={() =>
                          setSelected((prev) =>
                            prev.includes(row.id) ? prev.filter((x) => x !== row.id) : [...prev, row.id],
                          )
                        }
                        aria-label={`Select ${row.business_name}`}
                      />
                    </td>
                    <td>{row.business_name}</td>
                    <td>{row.location || '—'}</td>
                    <td>
                      {row.website ? (
                        <a className="crm-link" href={row.website} target="_blank" rel="noreferrer">
                          site
                        </a>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>{row.email}</td>
                    <td>{row.score_total ?? '—'}</td>
                    <td className="crm-muted">{row.website_observation || '—'}</td>
                    <td className="crm-col-action">
                      <button type="button" className="crm-btn-secondary" onClick={() => setPreview(row)}>Preview</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {preview ? (
        <div className="crm-drawer-backdrop" role="presentation" onClick={() => setPreview(null)}>
          <aside className="crm-drawer" role="dialog" aria-modal="true" aria-label="Email preview" onClick={(e) => e.stopPropagation()}>
            <div className="crm-panel-head">
              <h2>{preview.business_name}</h2>
              <button type="button" className="crm-btn-secondary" onClick={() => setPreview(null)}>Close</button>
            </div>
            <p className="crm-subhead">Subject</p>
            <p>{preview.preview_subject}</p>
            <p className="crm-subhead">Body</p>
            <pre className="crm-code">{preview.preview_body}</pre>
            <div className="crm-head-actions">
              <button
                type="button"
                className="crm-btn"
                disabled={Boolean(busy)}
                onClick={() => {
                  setSelected([preview.id]);
                  void bulkApprove(false);
                  setPreview(null);
                }}
              >
                Approve
              </button>
              <Link className="crm-btn-secondary" to="/admin/campaigns">Edit in Email Campaigns</Link>
            </div>
          </aside>
        </div>
      ) : null}
      {data?.mail_app_interim ? <p className="crm-muted crm-pad">{data.mail_app_interim}</p> : null}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Lead Queue (Neon discovery + Mac CRM bridge)                        */
/* ------------------------------------------------------------------ */

type QueueItem = {
  id: string;
  business_name: string;
  email: string;
  location?: string | null;
  category?: string | null;
  website_observation?: string | null;
  score_total?: number | null;
  scores?: Record<string, number> | null;
  evidence?: Array<{ field: string; signal: string; detail: string; source: string }>;
  sources: string[];
  queue_status: string;
  outreach_status: string;
  reject_reason?: string | null;
  contactable?: boolean;
};

function LeadQueuePage() {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [excludedCount, setExcludedCount] = useState(0);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [drawer, setDrawer] = useState<QueueItem | null>(null);
  const [busy, setBusy] = useState('');
  const [rejectReason, setRejectReason] = useState('');

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    void api<{ items: QueueItem[]; excluded_count?: number; message?: string }>(
      `/api/admin/crm/lead-queue?${params.toString()}`,
    )
      .then((data) => {
        setItems(data.items || []);
        setExcludedCount(data.excluded_count || 0);
        setMessage(data.message || '');
        setError('');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Lead queue unavailable.'));
  }, [q]);

  useEffect(load, [load]);

  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawer(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer]);

  const act = async (action: string, leadId: string, reason?: string) => {
    setBusy(action);
    try {
      await api('/api/admin/crm/lead-queue/action', {
        method: 'POST',
        body: JSON.stringify({ lead_id: leadId, action, reason }),
      });
      if (action === 'draft_email') {
        await api('/api/admin/crm/email-studio/draft', {
          method: 'POST',
          body: JSON.stringify({ lead_id: leadId, regenerate: true }),
        });
      }
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed.');
    } finally {
      setBusy('');
    }
  };

  const toggle = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  return (
    <>
      <PageHeader
        title="Lead Queue"
        description="One queue from Neon discovery + Mac CRM snapshot. Deduped by domain, email, and place_id. Suppressed / unsubscribed / contacted in 30 days are excluded."
      />
      {error ? <p className="crm-error">{error}</p> : null}
      {message ? <p className="crm-banner">{message}{excludedCount ? ` · ${excludedCount} excluded` : ''}</p> : null}
      <div className="crm-toolbar crm-pad">
        <input
          className="crm-input"
          placeholder="Search business, email, city…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search lead queue"
        />
        <span className="crm-muted">{selected.length} selected</span>
      </div>
      <section className="crm-panel">
        {!items.length ? (
          <Empty title="Queue empty">{message || 'Sync CRM or run Discover Leads.'}</Empty>
        ) : (
          <div className="crm-table-wrap">
            <table className="crm-table">
              <thead>
                <tr>
                  <th aria-label="Select" />
                  <th>Business</th>
                  <th>Email</th>
                  <th>Score</th>
                  <th>Queue</th>
                  <th>Outreach</th>
                  <th>Source</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <input type="checkbox" checked={selected.includes(item.id)} onChange={() => toggle(item.id)} aria-label={`Select ${item.business_name}`} />
                    </td>
                    <td>
                      <button type="button" className="crm-link" onClick={() => setDrawer(item)}>{item.business_name}</button>
                      <div className="crm-sub">{item.location || '—'} · {item.category || '—'}</div>
                    </td>
                    <td>{item.email || <span className="crm-faint">no email</span>}</td>
                    <td>{item.score_total ?? '—'}</td>
                    <td>{item.queue_status}</td>
                    <td>{item.outreach_status}</td>
                    <td>{item.sources.filter((s) => s !== 'merged').join(' + ')}</td>
                    <td className="crm-col-action">
                      <button type="button" className="crm-btn-secondary" disabled={Boolean(busy)} onClick={() => void act('approve', item.id)}>Approve</button>
                      <button type="button" className="crm-btn-secondary" disabled={Boolean(busy)} onClick={() => void act('save_for_later', item.id)}>Save</button>
                      <button type="button" className="crm-btn-secondary" disabled={Boolean(busy)} onClick={() => void act('draft_email', item.id)}>Draft</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {drawer ? (
        <div className="crm-drawer-backdrop" role="presentation" onClick={() => setDrawer(null)}>
          <aside
            className="crm-drawer"
            role="dialog"
            aria-modal="true"
            aria-label={`${drawer.business_name} details`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="crm-panel-head">
              <h2>{drawer.business_name}</h2>
              <button type="button" className="crm-btn-secondary" onClick={() => setDrawer(null)}>Close</button>
            </div>
            <p className="crm-muted">{drawer.website_observation || 'No verified website observation yet.'}</p>
            {drawer.scores ? (
              <div className="crm-pad">
                <p className="crm-subhead">Score breakdown</p>
                <ul className="crm-checklist">
                  {Object.entries(drawer.scores).map(([k, v]) => (
                    <li key={k}>{k}: {v}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {drawer.evidence?.length ? (
              <div className="crm-pad">
                <p className="crm-subhead">Evidence</p>
                <ul className="crm-checklist">
                  {drawer.evidence.map((ev, i) => (
                    <li key={`${ev.signal}-${i}`}><strong>{ev.signal}</strong> — {ev.detail} <span className="crm-faint">({ev.source})</span></li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="crm-field">
              <label htmlFor="reject-reason">Reject reason</label>
              <input id="reject-reason" className="crm-input" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
            </div>
            <div className="crm-head-actions">
              <button type="button" className="crm-btn" disabled={Boolean(busy)} onClick={() => void act('approve', drawer.id)}>Approve</button>
              <button
                type="button"
                className="crm-btn-secondary"
                disabled={Boolean(busy) || !rejectReason.trim()}
                onClick={() => void act('reject', drawer.id, rejectReason.trim())}
              >
                Reject
              </button>
              <button type="button" className="crm-btn-secondary" disabled={Boolean(busy)} onClick={() => void act('draft_email', drawer.id)}>Draft email</button>
            </div>
          </aside>
        </div>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Automation (discovery) — nav label: Discover Leads                  */
/* ------------------------------------------------------------------ */

type DiscoveryDash = {
  ok?: boolean;
  message?: string;
  live_email_send?: boolean;
  config?: {
    places_configured?: boolean;
    discovery_enabled?: boolean;
    max_per_run?: number;
    cron_secret_configured?: boolean;
  };
  automation?: {
    paused?: boolean;
    paused_reason?: string | null;
    last_run_at?: string | null;
    last_success_at?: string | null;
    total_discovered?: number;
    total_qualified?: number;
    total_needs_email?: number;
  };
  counts?: {
    total?: number;
    qualified?: number;
    needs_email?: number;
    discovered?: number;
  };
  enrichment?: {
    attempted?: number;
    found_public?: number;
    not_found?: number;
    last_run_at?: string | null;
  };
  recent_runs?: Array<{
    id: string;
    status: string;
    trigger: string;
    started_at: string;
    finished_at?: string | null;
    discovered: number;
    qualified: number;
    message: string;
    fail_closed?: boolean;
  }>;
  qualified_preview?: Array<{
    id: string;
    business_name: string;
    city?: string | null;
    category?: string | null;
    website?: string | null;
    score_total: number;
    public_email?: string | null;
    fit_summary?: string;
    source_url?: string | null;
    status: string;
  }>;
};

function AutomationPage() {
  const [data, setData] = useState<DiscoveryDash | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');

  const load = useCallback(() => {
    void api<DiscoveryDash>('/api/admin/crm/discovery')
      .then((d) => {
        setData(d);
        setError('');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load automation.'));
  }, []);

  useEffect(load, [load]);

  const act = async (label: string, path: string, body?: Record<string, unknown>) => {
    setBusy(label);
    setNote('');
    try {
      const res = await api<DiscoveryDash & { message?: string; run?: { message?: string } }>(path, {
        method: 'POST',
        body: JSON.stringify(body || {}),
      });
      setNote(res.message || res.run?.message || `${label} done.`);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : `${label} failed.`);
    } finally {
      setBusy('');
    }
  };

  const counts = data?.counts;
  const auto = data?.automation;
  const cfg = data?.config;
  const runs = data?.recent_runs || [];
  const qualified = data?.qualified_preview || [];

  return (
    <>
      <PageHeader
        title="Discover Leads"
        description="Places discovery + qualification for owner approval. Live outreach email stays off."
        actions={
          <>
            <button
              type="button"
              className="crm-btn"
              disabled={Boolean(busy)}
              onClick={() => void act('Run discovery', '/api/admin/crm/discovery/run', { ignore_pause: true, max_results: cfg?.max_per_run || 8 })}
            >
              {busy === 'Run discovery' ? 'Running…' : 'Run Discovery Now'}
            </button>
            {auto?.paused ? (
              <button type="button" className="crm-btn-secondary" disabled={Boolean(busy)} onClick={() => void act('Resume', '/api/admin/crm/discovery/resume')}>
                Resume
              </button>
            ) : (
              <button type="button" className="crm-btn-secondary" disabled={Boolean(busy)} onClick={() => void act('Pause', '/api/admin/crm/discovery/pause', { reason: 'Paused from Discover Leads UI' })}>
                Pause
              </button>
            )}
          </>
        }
      />

      {error ? <p className="crm-error">{error}</p> : null}
      {note ? <p className="crm-ok">{note}</p> : null}

      <div className="crm-banner warn">
        <strong>Live email send: OFF.</strong> Discovery only writes Neon rows and scores from public evidence. Owner approval is required before any outreach.
      </div>

      <div className="crm-grid-2">
        <section className="crm-panel">
          <div className="crm-panel-head"><h2>Status</h2></div>
          <div className="crm-checks">
            <CheckRow ok={cfg?.places_configured === true} label="Google Places" value={cfg?.places_configured ? 'Configured' : 'Missing key — fail closed'} />
            <CheckRow ok={cfg?.discovery_enabled === true} label="Discovery enabled" value={cfg?.discovery_enabled ? 'On' : 'Off / blocked'} />
            <CheckRow ok={auto?.paused !== true} label="Scheduler" value={auto?.paused ? `Paused${auto.paused_reason ? `: ${auto.paused_reason}` : ''}` : 'Active'} />
            <CheckRow ok={cfg?.cron_secret_configured === true} label="Cron secret" value={cfg?.cron_secret_configured ? 'Set' : 'Missing'} />
            <CheckRow ok={data?.live_email_send !== true} label="Live email send" value="Off" />
            <CheckRow ok={Boolean(auto?.last_run_at)} label="Last run" value={`${fmtDate(auto?.last_run_at, true)} · ${fmtRelative(auto?.last_run_at)}`} />
          </div>
          {data?.message ? <p className="crm-muted crm-pad">{data.message}</p> : null}
        </section>
        <section className="crm-panel">
          <div className="crm-panel-head"><h2>Real counts</h2></div>
          {!data ? (
            <p className="crm-muted">Loading…</p>
          ) : (
            <ul className="crm-funnel" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
              <li><span className="crm-funnel-label">Discovered</span><strong>{counts?.total ?? 0}</strong></li>
              <li><span className="crm-funnel-label">Qualified</span><strong>{counts?.qualified ?? 0}</strong></li>
              <li><span className="crm-funnel-label">Needs email</span><strong>{counts?.needs_email ?? 0}</strong></li>
              <li><span className="crm-funnel-label">Enrich found</span><strong>{data.enrichment?.found_public ?? 0}</strong></li>
            </ul>
          )}
          <p className="crm-muted crm-pad">Zeros mean empty Neon tables — never demo fixtures.</p>
        </section>
      </div>

      <section className="crm-panel">
        <div className="crm-panel-head">
          <h2>Logs</h2>
          <button type="button" className="crm-btn-ghost" onClick={load}>Refresh</button>
        </div>
        {!runs.length ? (
          <Empty title="No discovery runs yet">When Places is configured, cron or Run Discovery Now writes real run logs here.</Empty>
        ) : (
          <div className="crm-table-wrap">
            <table className="crm-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Trigger</th>
                  <th>Status</th>
                  <th className="num">New</th>
                  <th className="num">Qualified</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <td>{fmtDate(run.started_at, true)}</td>
                    <td>{run.trigger}</td>
                    <td><span className={`crm-pill ${run.status === 'completed' ? 'good' : run.fail_closed || run.status === 'skipped' || run.status === 'paused' ? 'warn' : run.status === 'failed' ? 'muted' : 'accent'}`}>{run.status}</span></td>
                    <td className="num">{run.discovered}</td>
                    <td className="num">{run.qualified}</td>
                    <td>{run.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="crm-panel">
        <div className="crm-panel-head">
          <h2>Review qualified</h2>
          <button
            type="button"
            className="crm-btn-secondary"
            disabled={Boolean(busy) || !counts?.needs_email}
            onClick={() => void act('Enrich emails', '/api/admin/crm/discovery/enrich', { limit: 10 })}
          >
            Enrich public emails
          </button>
        </div>
        {!qualified.length ? (
          <Empty title="No qualified opportunities">Qualified leads appear after a real discovery cycle scores public evidence above threshold.</Empty>
        ) : (
          <div className="crm-table-wrap">
            <table className="crm-table">
              <thead>
                <tr>
                  <th>Business</th>
                  <th>City</th>
                  <th>Category</th>
                  <th className="num">Score</th>
                  <th>Email</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {qualified.map((lead) => (
                  <tr key={lead.id}>
                    <td>
                      <strong>{lead.business_name}</strong>
                      {lead.fit_summary ? <div className="crm-sub">{lead.fit_summary}</div> : null}
                    </td>
                    <td>{asText(lead.city, '—')}</td>
                    <td>{asText(lead.category, '—')}</td>
                    <td className="num">{lead.score_total}</td>
                    <td>{asText(lead.public_email, '—')}</td>
                    <td>
                      {lead.source_url ? (
                        <a className="crm-link" href={lead.source_url} target="_blank" rel="noreferrer">Places</a>
                      ) : lead.website ? (
                        <a className="crm-link" href={lead.website} target="_blank" rel="noreferrer">Site</a>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Freelance (paste → score → proposal draft; no scrape / auto-submit) */
/* ------------------------------------------------------------------ */

type ScoredFreelance = {
  id: string;
  title: string;
  score: number;
  tier: string;
  reasons: string[];
  proposal_draft: string;
  auto_submit: false;
  status: string;
};

function FreelancePage() {
  const [paste, setPaste] = useState('');
  const [jobs, setJobs] = useState<ScoredFreelance[]>([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [selectedDraft, setSelectedDraft] = useState<ScoredFreelance | null>(null);
  const draftRef = useRef<HTMLDivElement | null>(null);
  useDialogA11y(Boolean(selectedDraft), () => setSelectedDraft(null), draftRef);

  async function onImport() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const data = await api<{ jobs: ScoredFreelance[]; message?: string; auto_submit?: boolean }>(
        '/api/admin/crm/freelance/import',
        { method: 'POST', body: JSON.stringify({ paste }) },
      );
      setJobs(data.jobs || []);
      setMessage(data.message || 'Drafts ready for owner review. Nothing was submitted.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Freelance"
        description="Paste jobs you copied while logged in. Score + proposal draft only — no scraping, no auto-submit, no outreach email."
      />
      <div className="crm-banner" role="note">
        <strong>Authorized paste only.</strong> Quotes stay private until you approve. Marketplace bids are never auto-sent.
      </div>
      {message ? <p className="crm-ok" role="status">{message}</p> : null}
      {error ? <p className="crm-error" role="alert">{error}</p> : null}
      <section className="crm-panel">
        <div className="crm-panel-head"><h2>Paste import</h2></div>
        <div className="crm-field">
          <label htmlFor="freelance-paste">Job paste (optional Title/Budget/Location header, then ---)</label>
          <textarea
            id="freelance-paste"
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            rows={12}
            placeholder={'Title: Med spa website\nBudget: $2k\nLocation: Remote US\n---\nNeed booking + modern site…'}
          />
        </div>
        <div className="crm-actions">
          <button className="crm-btn" type="button" disabled={busy || !paste.trim()} onClick={() => void onImport()}>
            Score &amp; draft proposals
          </button>
        </div>
      </section>
      {jobs.length ? (
        <section className="crm-panel">
          <div className="crm-panel-head"><h2>Results</h2></div>
          <div className="crm-table-wrap flush">
            <table className="crm-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th className="num">Score</th>
                  <th>Tier</th>
                  <th>Draft</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id}>
                    <td>
                      <div>{job.title}</div>
                      <div className="crm-muted crm-sub">{job.reasons.slice(0, 2).join(' · ')}</div>
                    </td>
                    <td className="num">{job.score}</td>
                    <td><span className="crm-pill muted">{job.tier}</span></td>
                    <td>
                      <button type="button" className="crm-link" onClick={() => setSelectedDraft(job)}>
                        View draft
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      {selectedDraft ? (
        <div className="crm-modal-backdrop" role="presentation" onClick={() => setSelectedDraft(null)}>
          <div
            ref={draftRef}
            className="crm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="freelance-draft-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="freelance-draft-title">{selectedDraft.title}</h3>
            <p className="crm-muted">Status: {selectedDraft.status} · auto_submit: false</p>
            <pre className="crm-code" style={{ whiteSpace: 'pre-wrap' }}>{selectedDraft.proposal_draft}</pre>
            <div className="crm-actions end">
              <button className="crm-btn" type="button" onClick={() => setSelectedDraft(null)}>Close</button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

function SettingsPage() {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [sender, setSender] = useState<Record<string, unknown> | null>(null);
  const [cap, setCap] = useState<Record<string, unknown> | null>(null);
  const [failed, setFailed] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(() => {
    void Promise.all([
      api<Record<string, unknown>>('/api/admin/crm/settings'),
      api<Record<string, unknown>>('/api/admin/crm/sender'),
      api<Record<string, unknown>>('/api/admin/crm/daily-cap'),
    ])
      .then(([settings, senderSnap, daily]) => {
        setData(settings);
        setSender(senderSnap);
        setCap(daily);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, []);

  useEffect(load, [load]);

  const safety = (data?.safety || {}) as Record<string, unknown>;
  const mac = (data?.mac_side_required || []) as string[];
  const persistence = (data?.persistence || {}) as Record<string, unknown>;
  const connection = asText(data?.connection, 'not_connected');
  const graph = (sender?.graph || {}) as Record<string, unknown>;
  const onOff = (v: unknown) => (v === true ? 'On' : 'Off');

  const connectOutlook = async () => {
    setBusy('outlook');
    setNote('');
    try {
      const res = await api<{ authorize_url?: string; message?: string }>('/api/admin/crm/outlook/connect', { method: 'POST', body: '{}' });
      if (res.authorize_url) window.location.href = res.authorize_url;
      else setNote(res.message || 'Connect started.');
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Could not start Outlook connect.');
    } finally {
      setBusy('');
    }
  };

  const setActive = async (active_sender: string) => {
    setBusy('sender');
    try {
      const res = await api<Record<string, unknown>>('/api/admin/crm/sender', {
        method: 'POST',
        body: JSON.stringify({ active_sender }),
      });
      setSender(res);
      setNote(`Active sender: ${active_sender}`);
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Could not set sender.');
    } finally {
      setBusy('');
    }
  };

  const applyCapSuggestion = async () => {
    setBusy('cap');
    try {
      const res = await api<Record<string, unknown>>('/api/admin/crm/daily-cap', {
        method: 'POST',
        body: JSON.stringify({ apply_suggestion: true }),
      });
      setCap(res);
      setNote('Suggested daily cap applied (owner click).');
      load();
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'No suggestion to apply.');
    } finally {
      setBusy('');
    }
  };

  return (
    <>
      <PageHeader title="Settings" description="Integrations, Outlook/Graph connect, daily cap, and send safety. Env names only — no Mail.app path." />
      {failed ? <p className="crm-error">Could not load settings.</p> : null}
      {note ? <p className="crm-ok">{note}</p> : null}
      <div className="crm-grid-2">
        <section className="crm-panel">
          <div className="crm-panel-head"><h2>Integrations</h2></div>
          <div className="crm-checks">
            <CheckRow ok={connection === 'synced'} label="Mac → site sync" value={connection === 'synced' ? 'Connected' : connection === 'sync_pending' ? 'Pending' : 'Not connected'} />
            <CheckRow ok={data?.stale === false} label="Last sync" value={`${fmtDate(data?.last_synced_at, true)} · ${fmtRelative(data?.last_synced_at)}`} />
            <CheckRow ok={Boolean(data?.sync_secret_configured)} label="Sync secret" value={data?.sync_secret_configured ? 'Set' : 'Missing'} />
            <CheckRow ok={Boolean(data?.durable_db_configured)} label="Database" value={asText(persistence.backend, '—').replace('_', ' ')} />
            <CheckRow ok={Boolean(data?.resend_webhook_secret)} label="Resend webhook" value={data?.resend_webhook_secret ? 'Secret set' : 'Not configured'} />
            <CheckRow ok={Boolean(graph.connected)} label="Outlook (Graph)" value={graph.connected ? asText(graph.account_email, 'Connected') : graph.configured ? 'Configured — not connected' : 'Needs Azure app env'} />
          </div>
          <div className="crm-head-actions crm-pad">
            <button type="button" className="crm-btn" disabled={Boolean(busy)} onClick={() => void connectOutlook()}>
              {busy === 'outlook' ? 'Connecting…' : 'Connect Outlook'}
            </button>
            <button type="button" className="crm-btn-secondary" disabled={Boolean(busy)} onClick={() => void setActive('graph')}>Use Graph</button>
            <button type="button" className="crm-btn-secondary" disabled={Boolean(busy)} onClick={() => void setActive('resend')}>Use Resend</button>
            <button type="button" className="crm-btn-secondary" disabled={Boolean(busy)} onClick={() => void setActive('none')}>Sender off</button>
          </div>
          <p className="crm-muted crm-pad">
            Active sender: <strong>{asText(sender?.active_sender, 'none')}</strong>. Graph/Resend are primary here.
            Mac interim: Mail.app may be used by the operator when authorized — does not replace Graph connect.
          </p>
        </section>
        <section className="crm-panel">
          <div className="crm-panel-head"><h2>Send safety + daily cap</h2></div>
          <div className="crm-checks">
            <CheckRow ok={safety.EMAIL_OUTREACH_ENABLED !== true} label="Automated outreach" value={onOff(safety.EMAIL_OUTREACH_ENABLED)} />
            <CheckRow ok={safety.EMAIL_DRY_RUN !== false} label="Dry-run" value={safety.EMAIL_DRY_RUN === false ? 'Off' : 'On'} />
            <CheckRow ok={safety.MANUAL_SEND_LIVE_ENABLED !== true} label="Manual live send" value={onOff(safety.MANUAL_SEND_LIVE_ENABLED)} />
            <CheckRow ok={safety.FOLLOWUPS_LIVE !== true} label="Automatic follow-ups" value={onOff(safety.FOLLOWUPS_LIVE)} />
            <CheckRow ok={true} label="Daily cap (effective)" value={`${asText(cap?.effective_cap, '20')} · remaining ${asText(cap?.remaining, '—')}`} />
          </div>
          {((cap?.state as Record<string, unknown> | undefined)?.suggested_cap != null) ? (
            <div className="crm-head-actions crm-pad">
              <p className="crm-muted">Suggested cap: {String((cap?.state as Record<string, unknown>).suggested_cap)} (never auto-applied)</p>
              <button type="button" className="crm-btn-secondary" disabled={Boolean(busy)} onClick={() => void applyCapSuggestion()}>Apply suggested cap</button>
            </div>
          ) : null}
          <p className="crm-muted crm-pad">Green means safe. Cap raises require an owner click. Change live flags in Vercel only when ready.</p>
        </section>
      </div>
      {mac.length ? (
        <section className="crm-panel">
          <div className="crm-panel-head"><h2>Setup checklist</h2></div>
          <ol className="crm-checklist">
            {mac.map((item) => <li key={item}>{item}</li>)}
          </ol>
        </section>
      ) : null}
      <details className="crm-panel crm-details">
        <summary>Push-sync contract (Mac → website)</summary>
        <pre className="crm-code">{JSON.stringify(data?.contract || {}, null, 2)}</pre>
      </details>
    </>
  );
}

/* ------------------------------------------------------------------ */

export function CrmDashboard() {
  return (
    <CrmShell>
      <Routes>
        {/* Relative paths: this <Routes> is mounted under <Route path="/admin/*"> in main.tsx. */}
        <Route index element={<OverviewPage />} />
        <Route path="daily-review" element={<DailyReviewPage />} />
        <Route path="leads" element={<LeadQueuePage />} />
        <Route path="lead-queue" element={<LeadQueuePage />} />
        <Route path="campaigns" element={<CampaignsPage />} />
        <Route path="inbox" element={<InboxPage />} />
        <Route path="bookings" element={<BookingsPage />} />
        <Route path="analytics" element={<AnalyticsPage />} />
        <Route path="automation" element={<AutomationPage />} />
        <Route path="freelance" element={<FreelancePage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="projects" element={<AdminHome />} />
        <Route path="projects/:projectId" element={<AdminProject />} />
        <Route path="projects/:projectId/pricing" element={<AdminPricing />} />
        <Route path="*" element={<OverviewPage />} />
      </Routes>
    </CrmShell>
  );
}
