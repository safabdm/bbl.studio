/**
 * Owner email handoff helpers — mailto + .eml for Mail.app / Outlook on the web.
 * Does not send mail; CRM live Resend stays gated separately.
 */

export const OWA_URL = 'https://outlook.office.com/mail/';
export const MAIL_FROM_DISPLAY = 'BBL Studio <hello@bbl.studio>';
export const MAIL_FROM_ADDRESS = 'hello@bbl.studio';

/** Microsoft 365 work/school licenses often omit Outlook for Mac — use OWA or Mail.app. */
export const OUTLOOK_MAC_LICENSE_NOTE =
  'Outlook for Mac is unavailable on this Microsoft 365 license. Use Outlook on the web or Mail.app (hello@bbl.studio) instead — do not require the desktop Outlook app.';

export type MailDraft = {
  to: string;
  subject: string;
  body: string;
  business_name?: string;
};

/** Encode for mailto query values (RFC 6068). */
export function encodeMailtoParam(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, '%20');
}

/**
 * Build a mailto: URL. Long bodies may hit OS/browser limits —
 * prefer .eml download when body length is large.
 */
export function buildMailtoUrl(draft: MailDraft): string {
  const to = String(draft.to || '').trim();
  const subject = encodeMailtoParam(String(draft.subject || ''));
  const body = encodeMailtoParam(String(draft.body || ''));
  return `mailto:${to}?subject=${subject}&body=${body}`;
}

function foldHeader(name: string, value: string): string {
  const raw = `${name}: ${String(value || '').replace(/[\r\n]+/g, ' ').trim()}`;
  if (raw.length <= 78) return raw;
  // Soft-fold long subjects for .eml readability.
  const parts: string[] = [];
  let rest = raw;
  while (rest.length > 78) {
    parts.push(rest.slice(0, 76));
    rest = ` ${rest.slice(76)}`;
  }
  parts.push(rest);
  return parts.join('\r\n');
}

function emlSafeFilename(name: string, index: number): string {
  const base = String(name || `lead-${index + 1}`)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${String(index + 1).padStart(2, '0')}-${base || 'draft'}.eml`;
}

/** RFC 822–style plain-text .eml for Mail.app / any desktop client. */
export function buildEml(draft: MailDraft, opts?: { from?: string; date?: Date }): string {
  const from = opts?.from || MAIL_FROM_DISPLAY;
  const date = (opts?.date || new Date()).toUTCString();
  const to = String(draft.to || '').trim();
  const subject = String(draft.subject || '').trim();
  const body = String(draft.body || '').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  return [
    foldHeader('From', from),
    foldHeader('To', to),
    foldHeader('Subject', subject),
    `Date: ${date}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    'X-Unsent: 1',
    '',
    body,
    '',
  ].join('\r\n');
}

export function draftFilename(draft: MailDraft, index: number): string {
  return emlSafeFilename(draft.business_name || draft.to, index);
}

/** Trigger a browser download of one .eml file. */
export function downloadEml(draft: MailDraft, index = 0): void {
  const content = buildEml(draft);
  const blob = new Blob([content], { type: 'message/rfc822' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = draftFilename(draft, index);
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Sequential downloads for a pack (browsers may prompt once). */
export function downloadEmlPack(drafts: MailDraft[]): void {
  drafts.forEach((draft, i) => {
    window.setTimeout(() => downloadEml(draft, i), i * 120);
  });
}
