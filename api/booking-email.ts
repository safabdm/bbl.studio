/**
 * Transactional booking confirmation only.
 * Intentionally separate from lead outreach — never reads EMAIL_OUTREACH_ENABLED
 * or EMAIL_DRY_RUN, and never sends outreach mail.
 */

export type BookingMailPayload = {
  to: string;
  name: string;
  startIso: string;
  endIso: string;
  timezoneLabel: string;
  durationMinutes: number;
  company?: string;
  note?: string;
  calendarMode: 'google' | 'local';
};

function formatWhen(iso: string, timeZone: string) {
  try {
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
  } catch {
    return iso;
  }
}

export function buildBookingConfirmation(payload: BookingMailPayload, timeZone: string) {
  const when = formatWhen(payload.startIso, timeZone);
  const subject = 'BBL Studio consultation confirmed';
  const text = [
    `Hello ${payload.name},`,
    '',
    'Your free BBL Studio consultation is booked.',
    '',
    `When: ${when}`,
    `Duration: ${payload.durationMinutes} minutes`,
    `Timezone: ${payload.timezoneLabel}`,
    payload.company ? `Company: ${payload.company}` : '',
    payload.note ? `Your note: ${payload.note}` : '',
    '',
    payload.calendarMode === 'google'
      ? 'A calendar invitation has been sent to this email. You will also receive a reminder about 24 hours before.'
      : 'A calendar invitation will be sent once Google Calendar is connected for the studio.',
    '',
    'If you need to reschedule, reply to this email or contact hello@bbl.studio.',
    '',
    'BBL Boutique Brand & Launch Studio',
    'hello@bbl.studio',
    '(949) 524-2324',
    'https://www.bbl.studio',
  ]
    .filter(Boolean)
    .join('\n');

  return { subject, text };
}

/**
 * Sends booking confirmation via Resend when BOOKING_EMAIL_MODE=send and RESEND_API_KEY is set.
 * Default is log-only. Does not touch outreach flags.
 */
export async function sendBookingConfirmation(payload: BookingMailPayload, timeZone: string) {
  const { subject, text } = buildBookingConfirmation(payload, timeZone);
  const mode = (process.env.BOOKING_EMAIL_MODE || 'log').trim().toLowerCase();
  const from = (process.env.BOOKING_EMAIL_FROM || process.env.EMAIL_FROM || 'hello@bbl.studio').trim();
  const apiKey = (process.env.RESEND_API_KEY || '').trim();

  if (mode !== 'send' || !apiKey) {
    console.log(`\n[booking-email:confirmation] mode=${mode || 'log'} to=${payload.to}\n${subject}\n${text}\n`);
    return { sent: false as const, mode: mode === 'send' ? 'missing_key' : 'log' };
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: from.includes('<') ? from : `BBL Studio <${from}>`,
      to: [payload.to],
      subject,
      text,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error('[booking-email] Resend failed', response.status, detail.slice(0, 200));
    return { sent: false as const, mode: 'error' as const };
  }

  return { sent: true as const, mode: 'send' as const };
}
