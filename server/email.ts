import { db, run } from './db';
import { id, nowIso } from './crypto';

type Template =
  | 'portal_invitation'
  | 'verification_code'
  | 'proposal_ready'
  | 'agreement_accepted'
  | 'payment_received'
  | 'payment_due'
  | 'preview_ready'
  | 'revision_request_received'
  | 'approval_received'
  | 'final_files_released';

const contact = `BBLS Boutique Brand & Launch Studio\nhello@bbls.studio\n(949) 524-2324\nhttps://bbls.studio`;

export function logEmail(template: Template, to: string, subject: string, body: string) {
  run(
    `INSERT INTO email_log (id, template, to_email, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [id('em_'), template, to, subject, body, nowIso()],
  );
  console.log(`\n[email:${template}] to=${to}\n${subject}\n${body}\n`);
}

export function portalEmail(opts: {
  template: Template;
  to: string;
  clientName: string;
  projectName: string;
  action: string;
  portalPath: string;
  extra?: string;
}) {
  const origin = process.env.APP_ORIGIN || 'http://127.0.0.1:4173';
  const subject = `BBLS project update: ${opts.projectName}`;
  const body = [
    `Hello ${opts.clientName},`,
    '',
    `Project: ${opts.projectName}`,
    `Action required: ${opts.action}`,
    opts.extra || '',
    '',
    `Open your private BBLS portal: ${origin}${opts.portalPath}`,
    'This link is intended only for the named client. Please do not forward it.',
    '',
    contact,
  ].filter(Boolean).join('\n');
  logEmail(opts.template, opts.to, subject, body);
}

export function recentEmails(limit = 20) {
  return db.prepare(`SELECT * FROM email_log ORDER BY created_at DESC LIMIT ?`).all(limit);
}
