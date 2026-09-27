'use client';

import { BblWordmark } from '@/components/bbls-mark';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';

type Slot = {
  start: string;
  end: string;
  date: string;
  timeLabel: string;
  endLabel: string;
};

type Availability = {
  ok: boolean;
  timezone: string;
  timezoneLabel: string;
  durationMinutes: number;
  minNoticeHours: number;
  dates: string[];
  selectedDate: string;
  slots: Slot[];
  calendar?: { configured: boolean; mode: 'google' | 'local' };
};

type FormState = {
  name: string;
  email: string;
  company: string;
  phone: string;
  note: string;
  website: string;
};

type ConfirmState = {
  start: string;
  end: string;
  timeLabel: string;
  endLabel: string;
  date: string;
  durationMinutes: number;
  timezoneLabel: string;
  message: string;
  calendarMode: 'google' | 'local';
};

function formatDateHeading(ymd: string, timeZone: string) {
  if (!ymd) return '';
  const [y, m, d] = ymd.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d, 17, 0, 0));
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(probe);
}

function formatConfirmWhen(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(iso));
}

const emptyForm: FormState = {
  name: '',
  email: '',
  company: '',
  phone: '',
  note: '',
  website: '',
};

export default function BookPage() {
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [selectedDate, setSelectedDate] = useState('');
  const [selectedSlot, setSelectedSlot] = useState<Slot | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [loadingDates, setLoadingDates] = useState(true);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  const loadAvailability = useCallback(async (date?: string) => {
    const isInitial = !date;
    if (isInitial) setLoadingDates(true);
    else setLoadingSlots(true);
    setError('');
    try {
      const query = date ? `?date=${encodeURIComponent(date)}` : '';
      const response = await fetch(`/api/book/availability${query}`);
      const data = (await response.json()) as Availability & { message?: string };
      if (!response.ok || !data.ok) {
        setError(data.message || 'Could not load available times.');
        return;
      }
      setAvailability(data);
      setSelectedDate(data.selectedDate || '');
      setSelectedSlot((current) => {
        if (!current) return null;
        return data.slots.some((slot) => slot.start === current.start) ? current : null;
      });
    } catch {
      setError('Could not load available times. Please refresh and try again.');
    } finally {
      setLoadingDates(false);
      setLoadingSlots(false);
    }
  }, []);

  useEffect(() => {
    void loadAvailability();
  }, [loadAvailability]);

  const timezoneLabel = availability?.timezoneLabel || 'Pacific Time (PT)';
  const durationMinutes = availability?.durationMinutes || 30;
  const minNoticeHours = availability?.minNoticeHours || 48;

  const dateOptions = useMemo(() => availability?.dates || [], [availability]);

  async function onSelectDate(ymd: string) {
    setSelectedDate(ymd);
    setSelectedSlot(null);
    await loadAvailability(ymd);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedSlot) {
      setError('Please select a date and time.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const response = await fetch('/api/book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start: selectedSlot.start,
          name: form.name,
          email: form.email,
          company: form.company,
          phone: form.phone,
          note: form.note,
          website: form.website,
        }),
      });
      const data = (await response.json()) as {
        ok?: boolean;
        message?: string;
        booking?: ConfirmState & { calendarMode: 'google' | 'local' };
      };
      if (!response.ok || !data.ok || !data.booking) {
        setError(data.message || 'Booking could not be completed.');
        if (response.status === 409 && selectedDate) await loadAvailability(selectedDate);
        return;
      }
      setConfirm({
        ...data.booking,
        message: data.message || 'Your consultation is booked.',
      });
    } catch {
      setError('Booking could not be completed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="book-page">
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      <div className="book-shell" id="content">
        <Link to="/" className="book-brand" aria-label="BBL Studio home">
          <BblWordmark />
        </Link>

        {confirm ? (
          <section className="book-panel" aria-live="polite">
            <p className="book-eyebrow">Confirmed</p>
            <h1>You are booked.</h1>
            <p className="book-lead">{confirm.message}</p>
            <dl className="book-summary">
              <div>
                <dt>When</dt>
                <dd>{formatConfirmWhen(confirm.start, availability?.timezone || 'America/Los_Angeles')}</dd>
              </div>
              <div>
                <dt>Duration</dt>
                <dd>{confirm.durationMinutes} minutes</dd>
              </div>
              <div>
                <dt>Timezone</dt>
                <dd>{confirm.timezoneLabel}</dd>
              </div>
            </dl>
            {confirm.calendarMode === 'local' && (
              <p className="book-note">
                Calendar invitations activate after Google Calendar is connected for the studio. We still have your
                reservation.
              </p>
            )}
            <p className="book-note">
              Questions? Email <a href="mailto:hello@bbl.studio">hello@bbl.studio</a> or call{' '}
              <a href="tel:+19495242324">(949) 524-2324</a>.
            </p>
          </section>
        ) : (
          <section className="book-panel">
            <p className="book-eyebrow">Free consultation</p>
            <h1>Book a consultation</h1>
            <p className="book-lead">
              Choose an available time for a focused conversation about your website. All times are shown in{' '}
              <strong>{timezoneLabel}</strong>. Consultations last {durationMinutes} minutes and require at least{' '}
              {minNoticeHours} hours notice.
            </p>

            {availability && availability.calendar && !availability.calendar.configured && (
              <p className="book-note" role="status">
                Live calendar sync is finishing setup. Email{' '}
                <a href="mailto:hello@bbl.studio">hello@bbl.studio</a> or call{' '}
                <a href="tel:+19495242324">(949) 524-2324</a> to schedule meanwhile.
              </p>
            )}

            {loadingDates && !availability ? (
              <p className="book-status" aria-live="polite">
                Loading available dates…
              </p>
            ) : (
              <>
                <div className="book-step">
                  <h2>1. Select a date</h2>
                  {dateOptions.length === 0 ? (
                    <p className="book-note">No dates are open right now. Email hello@bbl.studio to schedule.</p>
                  ) : (
                    <div className="book-chip-row" role="list">
                      {dateOptions.map((ymd) => (
                        <button
                          key={ymd}
                          type="button"
                          role="listitem"
                          className={`book-chip${selectedDate === ymd ? ' is-selected' : ''}`}
                          aria-pressed={selectedDate === ymd}
                          onClick={() => void onSelectDate(ymd)}
                        >
                          {formatDateHeading(ymd, availability?.timezone || 'America/Los_Angeles')}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="book-step">
                  <h2>2. Select a time</h2>
                  <p className="book-tz-hint">Times in {timezoneLabel}</p>
                  {loadingSlots ? (
                    <p className="book-status">Loading times…</p>
                  ) : !selectedDate ? (
                    <p className="book-note">Select a date to see open times.</p>
                  ) : (availability?.slots.length || 0) === 0 ? (
                    <p className="book-note">No open times on this date. Try another day.</p>
                  ) : (
                    <div className="book-chip-row" role="list">
                      {availability!.slots.map((slot) => (
                        <button
                          key={slot.start}
                          type="button"
                          role="listitem"
                          className={`book-chip${selectedSlot?.start === slot.start ? ' is-selected' : ''}`}
                          aria-pressed={selectedSlot?.start === slot.start}
                          onClick={() => setSelectedSlot(slot)}
                        >
                          {slot.timeLabel}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <form className="book-form" onSubmit={onSubmit} noValidate>
                  <h2>3. Your details</h2>
                  <div className="book-form-grid">
                    <label>
                      Full name
                      <input
                        name="name"
                        autoComplete="name"
                        required
                        value={form.name}
                        onChange={(event) => setForm({ ...form, name: event.target.value })}
                      />
                    </label>
                    <label>
                      Email
                      <input
                        name="email"
                        type="email"
                        autoComplete="email"
                        required
                        value={form.email}
                        onChange={(event) => setForm({ ...form, email: event.target.value })}
                      />
                    </label>
                    <label>
                      Company <span className="book-optional">(optional)</span>
                      <input
                        name="company"
                        autoComplete="organization"
                        value={form.company}
                        onChange={(event) => setForm({ ...form, company: event.target.value })}
                      />
                    </label>
                    <label>
                      Phone <span className="book-optional">(optional)</span>
                      <input
                        name="phone"
                        type="tel"
                        autoComplete="tel"
                        value={form.phone}
                        onChange={(event) => setForm({ ...form, phone: event.target.value })}
                      />
                    </label>
                  </div>
                  <label>
                    Short note <span className="book-optional">(optional)</span>
                    <textarea
                      name="note"
                      rows={3}
                      maxLength={800}
                      placeholder="What are you looking to build?"
                      value={form.note}
                      onChange={(event) => setForm({ ...form, note: event.target.value })}
                    />
                  </label>
                  <label className="book-honeypot" aria-hidden="true">
                    Website
                    <input
                      name="website"
                      tabIndex={-1}
                      autoComplete="off"
                      value={form.website}
                      onChange={(event) => setForm({ ...form, website: event.target.value })}
                    />
                  </label>
                  {selectedSlot && (
                    <p className="book-selected">
                      Selected: {formatDateHeading(selectedSlot.date, availability?.timezone || 'America/Los_Angeles')}{' '}
                      at {selectedSlot.timeLabel} ({timezoneLabel})
                    </p>
                  )}
                  {error && (
                    <p className="book-error" role="alert">
                      {error}
                    </p>
                  )}
                  <button className="book-submit" type="submit" disabled={submitting || !selectedSlot}>
                    {submitting ? 'Booking…' : 'Book Consultation'}
                  </button>
                </form>
              </>
            )}
          </section>
        )}

        <p className="book-foot">
          <Link to="/">Return to bbl.studio</Link>
          {' · '}
          <a href="mailto:hello@bbl.studio">hello@bbl.studio</a>
        </p>
      </div>
    </main>
  );
}
