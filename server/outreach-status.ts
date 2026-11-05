/**
 * Explicit outreach delivery / pipeline status model.
 * Never infer from side effects — Unknown stays Unknown until set.
 */

export const OUTREACH_STATUSES = [
  'queued',
  'submitted',
  'delivered',
  'bounced',
  'replied',
  'interested',
  'booked',
  'won',
  'unknown',
] as const;

export type OutreachStatus = (typeof OUTREACH_STATUSES)[number];

const ALLOWED = new Set<string>(OUTREACH_STATUSES);

/** Normalize raw status; anything unrecognized becomes `unknown` (explicit). */
export function normalizeOutreachStatus(raw: string | null | undefined): OutreachStatus {
  const key = String(raw || '')
    .trim()
    .toLowerCase();
  if (!key) return 'unknown';
  if (ALLOWED.has(key)) return key as OutreachStatus;
  // Common provider aliases → explicit mapped values only when unambiguous.
  if (key === 'sent' || key === 'accepted') return 'submitted';
  if (key === 'delivery' || key === 'delivered_ok') return 'delivered';
  if (key === 'bounce' || key === 'hard_bounce' || key === 'soft_bounce') return 'bounced';
  if (key === 'reply' || key === 'replied_yes') return 'replied';
  return 'unknown';
}

export function isTerminalNegative(status: OutreachStatus): boolean {
  return status === 'bounced';
}

export function isReplyFamily(status: OutreachStatus): boolean {
  return status === 'replied' || status === 'interested' || status === 'booked' || status === 'won';
}

/** Allowed owner transitions (manual). Provider events may jump within this graph. */
export const STATUS_TRANSITIONS: Record<OutreachStatus, OutreachStatus[]> = {
  unknown: ['queued', 'submitted', 'delivered', 'bounced', 'replied', 'interested', 'booked', 'won'],
  queued: ['submitted', 'bounced', 'unknown'],
  submitted: ['delivered', 'bounced', 'replied', 'unknown'],
  delivered: ['bounced', 'replied', 'interested', 'booked', 'won', 'unknown'],
  bounced: ['unknown'],
  replied: ['interested', 'booked', 'won', 'unknown'],
  interested: ['booked', 'won', 'replied', 'unknown'],
  booked: ['won', 'interested', 'unknown'],
  won: ['unknown'],
};

export function canTransition(from: OutreachStatus, to: OutreachStatus): boolean {
  if (from === to) return true;
  return (STATUS_TRANSITIONS[from] || []).includes(to);
}

export function statusLabel(status: OutreachStatus): string {
  if (status === 'unknown') return 'Unknown';
  return status.charAt(0).toUpperCase() + status.slice(1);
}
