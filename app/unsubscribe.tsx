'use client';

import { BblWordmark } from '@/components/bbls-mark';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

type UnsubState =
  | { status: 'loading' }
  | { status: 'success'; already: boolean; email: string }
  | { status: 'error'; message: string };

export default function UnsubscribePage() {
  const [params] = useSearchParams();
  const email = (params.get('email') || '').trim().toLowerCase();
  const leadId = (params.get('lead_id') || '').trim();
  const token = (params.get('token') || '').trim();
  const query = useMemo(() => ({ email, lead_id: leadId, token }), [email, leadId, token]);
  const [state, setState] = useState<UnsubState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!query.email || !query.lead_id || !query.token) {
        if (!cancelled) {
          setState({
            status: 'error',
            message: 'This unsubscribe link is incomplete. Use the link from your email, or contact hello@bbl.studio.',
          });
        }
        return;
      }
      try {
        const response = await fetch('/api/unsubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(query),
        });
        const data = (await response.json()) as {
          ok?: boolean;
          already?: boolean;
          email?: string;
          message?: string;
        };
        if (cancelled) return;
        if (!response.ok || !data.ok) {
          setState({
            status: 'error',
            message: data.message || 'This unsubscribe link is invalid or expired.',
          });
          return;
        }
        setState({
          status: 'success',
          already: Boolean(data.already),
          email: data.email || query.email,
        });
      } catch {
        if (!cancelled) {
          setState({
            status: 'error',
            message: 'We could not complete the unsubscribe request. Please try again, or email hello@bbl.studio.',
          });
        }
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [query]);

  return (
    <main className="unsub-page">
      <a className="skip-link" href="#content">Skip to content</a>
      <div className="unsub-shell" id="content">
        <Link to="/" className="unsub-brand" aria-label="BBL Studio home">
          <BblWordmark />
        </Link>
        {state.status === 'loading' && (
          <section className="unsub-panel" aria-live="polite">
            <h1>Confirming unsubscribe…</h1>
            <p>One moment while we process your request.</p>
          </section>
        )}
        {state.status === 'success' && (
          <section className="unsub-panel" aria-live="polite">
            <h1>{state.already ? 'Already unsubscribed' : 'You are unsubscribed'}</h1>
            <p>
              {state.already
                ? `${state.email} was already removed from BBL Studio outreach.`
                : `${state.email} will no longer receive BBL Studio outreach emails.`}
            </p>
            <p className="unsub-note">If this was a mistake, email hello@bbl.studio and we will help.</p>
          </section>
        )}
        {state.status === 'error' && (
          <section className="unsub-panel" aria-live="assertive">
            <h1>Unable to unsubscribe</h1>
            <p>{state.message}</p>
            <p className="unsub-note">
              Contact <a href="mailto:hello@bbl.studio">hello@bbl.studio</a> and we will remove you manually.
            </p>
          </section>
        )}
        <p className="unsub-foot">
          <Link to="/">Return to bbl.studio</Link>
        </p>
      </div>
    </main>
  );
}
