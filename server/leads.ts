import { appOrigin } from './env';
import { id, nowIso, randomToken } from './crypto';
import { row, rows, run } from './db';
import { logEmail } from './email';

export const LEAD_CATEGORIES = [
  'Hair salon',
  'Nail salon',
  'Lash & brow studio',
  'Med spa',
  'Skincare studio',
  'Makeup artist',
  'Clothing boutique',
  'Jewelry store',
  'Cosmetics / perfume / gift store',
] as const;

export type LeadCategory = (typeof LEAD_CATEGORIES)[number];

export type LeadStatus =
  | 'new'
  | 'reviewed'
  | 'approved'
  | 'draft_ready'
  | 'booked'
  | 'declined'
  | 'closed';

export type PresenceKind =
  | 'yelp_only'
  | 'instagram_only'
  | 'google_maps_only'
  | 'no_website'
  | 'outdated_website'
  | 'multi_platform_weak';

export type LeadSeed = {
  business_name: string;
  category: LeadCategory;
  city: string;
  website: string | null;
  yelp_url: string | null;
  instagram_url: string | null;
  google_maps_url: string | null;
  public_email: string | null;
  public_phone: string | null;
  notes?: string;
};

const OC_CITIES = [
  'Irvine',
  'Newport Beach',
  'Costa Mesa',
  'Laguna Beach',
  'Huntington Beach',
  'Anaheim',
  'Orange',
  'Tustin',
  'Santa Ana',
  'Fullerton',
  'Mission Viejo',
  'Dana Point',
] as const;

/** Curated Orange County MVP leads. Fictional profiles for scoring demos — not live scrapes. */
export const OC_LEAD_SEED: LeadSeed[] = [
  {
    business_name: 'Coastal Crown Hair Studio',
    category: 'Hair salon',
    city: 'Newport Beach',
    website: null,
    yelp_url: 'https://www.yelp.com/biz/coastal-crown-hair-studio-newport-beach',
    instagram_url: null,
    google_maps_url: null,
    public_email: 'hello@coastalcrown.example',
    public_phone: '(949) 555-0142',
  },
  {
    business_name: 'Luna Nail Bar OC',
    category: 'Nail salon',
    city: 'Irvine',
    website: null,
    yelp_url: null,
    instagram_url: 'https://instagram.com/lunanailbar.oc',
    google_maps_url: null,
    public_email: 'book@lunanailbar.example',
    public_phone: '(949) 555-0188',
  },
  {
    business_name: 'Brow & Bloom Studio',
    category: 'Lash & brow studio',
    city: 'Costa Mesa',
    website: null,
    yelp_url: null,
    instagram_url: null,
    google_maps_url: 'https://maps.google.com/?q=Brow+Bloom+Studio+Costa+Mesa',
    public_email: null,
    public_phone: '(714) 555-0119',
  },
  {
    business_name: 'Aether Med Spa',
    category: 'Med spa',
    city: 'Irvine',
    website: 'http://aethermedspa.example/index.html',
    yelp_url: 'https://www.yelp.com/biz/aether-med-spa-irvine',
    instagram_url: 'https://instagram.com/aethermedspa',
    google_maps_url: 'https://maps.google.com/?q=Aether+Med+Spa+Irvine',
    public_email: 'front@aethermedspa.example',
    public_phone: '(949) 555-0201',
    notes: 'Flash-heavy homepage, no mobile layout, last updated ~2016.',
  },
  {
    business_name: 'Serein Skin Lab',
    category: 'Skincare studio',
    city: 'Laguna Beach',
    website: null,
    yelp_url: 'https://www.yelp.com/biz/serein-skin-lab-laguna-beach',
    instagram_url: 'https://instagram.com/sereinskinlab',
    google_maps_url: null,
    public_email: 'care@sereinskin.example',
    public_phone: '(949) 555-0277',
  },
  {
    business_name: 'Mira Vale Makeup',
    category: 'Makeup artist',
    city: 'Huntington Beach',
    website: null,
    yelp_url: null,
    instagram_url: 'https://instagram.com/miravalemakeup',
    google_maps_url: null,
    public_email: 'mira@miravale.example',
    public_phone: '(714) 555-0334',
  },
  {
    business_name: 'Atelier No. 7 Boutique',
    category: 'Clothing boutique',
    city: 'Newport Beach',
    website: null,
    yelp_url: null,
    instagram_url: null,
    google_maps_url: 'https://maps.google.com/?q=Atelier+No+7+Newport+Beach',
    public_email: 'shop@atelier7.example',
    public_phone: '(949) 555-0410',
  },
  {
    business_name: 'Goldfinch Fine Jewelry',
    category: 'Jewelry store',
    city: 'Orange',
    website: 'https://goldfinch-oc.example',
    yelp_url: 'https://www.yelp.com/biz/goldfinch-fine-jewelry-orange',
    instagram_url: null,
    google_maps_url: 'https://maps.google.com/?q=Goldfinch+Fine+Jewelry+Orange',
    public_email: 'hello@goldfinch-oc.example',
    public_phone: '(714) 555-0466',
    notes: 'Template site with broken product galleries and no booking CTA.',
  },
  {
    business_name: 'Velvet & Vine Gifts',
    category: 'Cosmetics / perfume / gift store',
    city: 'Dana Point',
    website: null,
    yelp_url: 'https://www.yelp.com/biz/velvet-vine-gifts-dana-point',
    instagram_url: null,
    google_maps_url: null,
    public_email: null,
    public_phone: '(949) 555-0502',
  },
  {
    business_name: 'Strand Society Salon',
    category: 'Hair salon',
    city: 'Fullerton',
    website: null,
    yelp_url: null,
    instagram_url: 'https://instagram.com/strandsociety',
    google_maps_url: 'https://maps.google.com/?q=Strand+Society+Fullerton',
    public_email: 'team@strandsociety.example',
    public_phone: '(714) 555-0558',
  },
  {
    business_name: 'Petal Polish Nails',
    category: 'Nail salon',
    city: 'Tustin',
    website: null,
    yelp_url: 'https://www.yelp.com/biz/petal-polish-nails-tustin',
    instagram_url: null,
    google_maps_url: null,
    public_email: 'petal@polishnails.example',
    public_phone: '(714) 555-0611',
  },
  {
    business_name: 'Lash House OC',
    category: 'Lash & brow studio',
    city: 'Anaheim',
    website: null,
    yelp_url: null,
    instagram_url: 'https://instagram.com/lashhouse.oc',
    google_maps_url: null,
    public_email: 'book@lashhouse.example',
    public_phone: '(714) 555-0670',
  },
  {
    business_name: 'Harbor Glow Aesthetics',
    category: 'Med spa',
    city: 'Huntington Beach',
    website: null,
    yelp_url: null,
    instagram_url: null,
    google_maps_url: 'https://maps.google.com/?q=Harbor+Glow+Aesthetics+Huntington+Beach',
    public_email: 'hello@harborglow.example',
    public_phone: '(714) 555-0725',
  },
  {
    business_name: 'Quiet Radiance Facials',
    category: 'Skincare studio',
    city: 'Mission Viejo',
    website: 'http://quietradiance.example',
    yelp_url: null,
    instagram_url: 'https://instagram.com/quietradiance',
    google_maps_url: null,
    public_email: 'desk@quietradiance.example',
    public_phone: '(949) 555-0789',
    notes: 'Wix starter page; stock photos only; no services menu.',
  },
  {
    business_name: 'Camille Ruiz Beauty',
    category: 'Makeup artist',
    city: 'Santa Ana',
    website: null,
    yelp_url: 'https://www.yelp.com/biz/camille-ruiz-beauty-santa-ana',
    instagram_url: null,
    google_maps_url: null,
    public_email: 'camille@ruizbeauty.example',
    public_phone: '(714) 555-0833',
  },
  {
    business_name: 'Northtide Clothiers',
    category: 'Clothing boutique',
    city: 'Laguna Beach',
    website: null,
    yelp_url: null,
    instagram_url: 'https://instagram.com/northtideclothiers',
    google_maps_url: null,
    public_email: 'shop@northtide.example',
    public_phone: '(949) 555-0890',
  },
  {
    business_name: 'Solstice Jewel House',
    category: 'Jewelry store',
    city: 'Irvine',
    website: null,
    yelp_url: null,
    instagram_url: null,
    google_maps_url: 'https://maps.google.com/?q=Solstice+Jewel+House+Irvine',
    public_email: null,
    public_phone: '(949) 555-0914',
  },
  {
    business_name: 'Bloom & Bottle Perfume',
    category: 'Cosmetics / perfume / gift store',
    city: 'Costa Mesa',
    website: null,
    yelp_url: 'https://www.yelp.com/biz/bloom-bottle-perfume-costa-mesa',
    instagram_url: 'https://instagram.com/bloomandbottle',
    google_maps_url: null,
    public_email: 'hello@bloomandbottle.example',
    public_phone: '(714) 555-0966',
  },
  {
    business_name: 'The Cut Room OC',
    category: 'Hair salon',
    city: 'Orange',
    website: 'https://thecutroom-oc.example',
    yelp_url: 'https://www.yelp.com/biz/the-cut-room-oc-orange',
    instagram_url: 'https://instagram.com/thecutroom.oc',
    google_maps_url: 'https://maps.google.com/?q=The+Cut+Room+OC+Orange',
    public_email: 'front@thecutroom.example',
    public_phone: '(714) 555-0991',
    notes: 'Outdated WordPress theme; no online booking; broken SSL warning historically.',
  },
  {
    business_name: 'Ivory Tip Nail Atelier',
    category: 'Nail salon',
    city: 'Newport Beach',
    website: null,
    yelp_url: null,
    instagram_url: 'https://instagram.com/ivorytip.atelier',
    google_maps_url: null,
    public_email: 'book@ivorytip.example',
    public_phone: '(949) 555-1020',
  },
];

export function scoreLead(input: {
  website: string | null;
  yelp_url: string | null;
  instagram_url: string | null;
  google_maps_url: string | null;
  public_email?: string | null;
  notes?: string | null;
}) {
  const hasWebsite = Boolean(input.website?.trim());
  const hasYelp = Boolean(input.yelp_url?.trim());
  const hasIg = Boolean(input.instagram_url?.trim());
  const hasMaps = Boolean(input.google_maps_url?.trim());
  const notes = (input.notes || '').toLowerCase();
  const outdatedHint =
    /outdated|flash|broken|wix starter|stock photos|no mobile|201[0-9]|ssl|template site/.test(notes);

  let presence: PresenceKind;
  let score = 40;
  const reasons: string[] = [];

  if (!hasWebsite) {
    presence = 'no_website';
    score += 45;
    reasons.push('No independent website found — relying on directories or social alone.');
    if (hasYelp && !hasIg && !hasMaps) {
      presence = 'yelp_only';
      score += 8;
      reasons.push('Yelp-only presence.');
    } else if (hasIg && !hasYelp && !hasMaps) {
      presence = 'instagram_only';
      score += 10;
      reasons.push('Instagram-only presence.');
    } else if (hasMaps && !hasYelp && !hasIg) {
      presence = 'google_maps_only';
      score += 9;
      reasons.push('Google Maps-only presence.');
    } else if ((Number(hasYelp) + Number(hasIg) + Number(hasMaps)) >= 2) {
      presence = 'multi_platform_weak';
      score += 5;
      reasons.push('Listed on multiple platforms but still no owned website.');
    }
  } else if (outdatedHint) {
    presence = 'outdated_website';
    score += 35;
    reasons.push('Website appears outdated or poorly structured for conversions.');
    if (input.notes) reasons.push(input.notes);
  } else {
    presence = 'multi_platform_weak';
    score += 10;
    reasons.push('Has a website, but Orange County beauty/retail competitors with weak digital presence still convert well with a modern demo.');
  }

  if (!input.public_email && !hasWebsite) {
    score += 3;
    reasons.push('Limited public contact channels — a clear site would make booking easier.');
  }

  score = Math.min(99, score);
  const why = reasons.join(' ') || 'May benefit from a clearer online presence.';
  return { presence, score, why_need_website: why };
}

function insertLead(seed: LeadSeed, createdAt: string) {
  const scored = scoreLead({
    website: seed.website,
    yelp_url: seed.yelp_url,
    instagram_url: seed.instagram_url,
    google_maps_url: seed.google_maps_url,
    public_email: seed.public_email,
    notes: seed.notes,
  });
  const leadId = id('lead_');
  run(
    `INSERT INTO leads (
      id, business_name, category, city, region, website, yelp_url, instagram_url, google_maps_url,
      public_email, public_phone, online_presence, lead_status, score, why_need_website, notes,
      booking_token, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'Orange County, CA', ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, NULL, ?, ?)`,
    [
      leadId,
      seed.business_name,
      seed.category,
      seed.city,
      seed.website,
      seed.yelp_url,
      seed.instagram_url,
      seed.google_maps_url,
      seed.public_email,
      seed.public_phone,
      scored.presence,
      scored.score,
      scored.why_need_website,
      seed.notes || null,
      createdAt,
      createdAt,
    ],
  );
  return leadId;
}

export function seedLeadsIfNeeded(force = false) {
  const count = row<{ c: number }>('SELECT COUNT(*) as c FROM leads')?.c || 0;
  if (count > 0 && !force) return { seeded: 0, total: count };
  if (force) {
    run('DELETE FROM lead_appointments');
    run('DELETE FROM lead_email_drafts');
    run('DELETE FROM owner_notifications');
    run('DELETE FROM leads');
  }
  const createdAt = nowIso();
  for (const seed of OC_LEAD_SEED) insertLead(seed, createdAt);
  return { seeded: OC_LEAD_SEED.length, total: OC_LEAD_SEED.length, cities: OC_CITIES };
}

export type LeadRow = {
  id: string;
  business_name: string;
  category: string;
  city: string;
  region: string;
  website: string | null;
  yelp_url: string | null;
  instagram_url: string | null;
  google_maps_url: string | null;
  public_email: string | null;
  public_phone: string | null;
  online_presence: string;
  lead_status: LeadStatus;
  score: number;
  why_need_website: string;
  notes: string | null;
  booking_token: string | null;
  created_at: string;
  updated_at: string;
};

export function listLeads(filters: { status?: string; category?: string; city?: string; q?: string } = {}) {
  const clauses: string[] = ["region = 'Orange County, CA'"];
  const params: unknown[] = [];
  if (filters.status) {
    clauses.push('lead_status = ?');
    params.push(filters.status);
  }
  if (filters.category) {
    clauses.push('category = ?');
    params.push(filters.category);
  }
  if (filters.city) {
    clauses.push('city = ?');
    params.push(filters.city);
  }
  if (filters.q) {
    clauses.push('(business_name LIKE ? OR city LIKE ? OR category LIKE ? OR public_email LIKE ?)');
    const like = `%${filters.q}%`;
    params.push(like, like, like, like);
  }
  return rows<LeadRow>(
    `SELECT * FROM leads WHERE ${clauses.join(' AND ')} ORDER BY score DESC, business_name ASC`,
    params,
  );
}

export function getLead(leadId: string) {
  return row<LeadRow>(`SELECT * FROM leads WHERE id = ?`, [leadId]);
}

export function updateLeadStatus(leadId: string, status: LeadStatus) {
  run(`UPDATE leads SET lead_status = ?, updated_at = ? WHERE id = ?`, [status, nowIso(), leadId]);
  if (status === 'approved') {
    const lead = getLead(leadId);
    if (lead && !lead.booking_token) {
      run(`UPDATE leads SET booking_token = ?, updated_at = ? WHERE id = ?`, [randomToken(24), nowIso(), leadId]);
    }
  }
  return getLead(leadId);
}

export function draftOutreachEmail(leadId: string) {
  const lead = getLead(leadId);
  if (!lead) return null;
  if (lead.lead_status !== 'approved' && lead.lead_status !== 'draft_ready' && lead.lead_status !== 'booked') {
    throw new Error('Approve the lead before creating an outreach draft.');
  }
  if (!lead.booking_token) {
    run(`UPDATE leads SET booking_token = ?, updated_at = ? WHERE id = ?`, [randomToken(24), nowIso(), leadId]);
  }
  const fresh = getLead(leadId)!;
  const origin = appOrigin();
  const bookUrl = `${origin}/book/${fresh.booking_token}`;
  const contact = fresh.public_email ? `Hello ${fresh.business_name} team` : `Hello`;
  const subject = `A quick website idea for ${fresh.business_name}`;
  const body = [
    `${contact},`,
    '',
    `I am reaching out from BBL Studio in Orange County. I put together a short personalized website concept for ${fresh.business_name} in ${fresh.city}.`,
    '',
    `Would you be open to a 15-minute video call so I can walk you through the demo live?`,
    '',
    `If a time works, pick a slot here (at least 24 hours out):`,
    bookUrl,
    '',
    `Looking forward to showing you the direction.`,
    '',
    `— BBLS`,
    `BBL Boutique Brand & Launch Studio`,
    `Orange County, CA`,
    `hello@bbl.studio`,
    `(949) 524-2324`,
  ].join('\n');

  const draftId = id('ldft_');
  run(
    `INSERT INTO lead_email_drafts (id, lead_id, to_email, subject, body, created_at, sent_at) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    [draftId, leadId, fresh.public_email || '', subject, body, nowIso()],
  );
  run(`UPDATE leads SET lead_status = 'draft_ready', updated_at = ? WHERE id = ?`, [nowIso(), leadId]);

  // Intentionally do NOT send. EMAIL_MODE=log only stores a draft marker for the owner.
  logEmail(
    'lead_outreach_draft',
    fresh.public_email || 'unlisted@example.invalid',
    `[DRAFT — NOT SENT] ${subject}`,
    `${body}\n\n---\nThis outreach was saved as a draft only. BBLS does not auto-send email or SMS.`,
  );

  return {
    id: draftId,
    lead_id: leadId,
    to_email: fresh.public_email,
    subject,
    body,
    book_url: bookUrl,
    auto_sent: false,
  };
}

export function listDrafts(leadId: string) {
  return rows<{ id: string; lead_id: string; to_email: string; subject: string; body: string; created_at: string; sent_at: string | null }>(
    `SELECT * FROM lead_email_drafts WHERE lead_id = ? ORDER BY created_at DESC`,
    [leadId],
  );
}

export function getLeadByBookingToken(token: string) {
  return row<LeadRow>(`SELECT * FROM leads WHERE booking_token = ?`, [token]);
}

const MIN_BOOKING_MS = 24 * 60 * 60 * 1000;

export function availableSlots(fromIso?: string) {
  const start = fromIso ? new Date(fromIso) : new Date();
  const earliestMs = Math.max(start.getTime(), Date.now() + MIN_BOOKING_MS);
  const slots: string[] = [];
  // Walk calendar days in America/Los_Angeles and emit 10:00–16:30 PT half-hours.
  const dayCursor = new Date(earliestMs);
  for (let day = 0; day < 14 && slots.length < 24; day += 1) {
    for (let minutes = 10 * 60; minutes <= 16 * 60 + 30; minutes += 30) {
      const hour = Math.floor(minutes / 60);
      const minute = minutes % 60;
      const iso = zonedTimeToUtcIso(dayCursor, hour, minute, 'America/Los_Angeles');
      if (!iso) continue;
      const when = new Date(iso);
      const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short' }).format(when);
      if (weekday === 'Sat' || weekday === 'Sun') continue;
      if (when.getTime() < earliestMs) continue;
      slots.push(iso);
      if (slots.length >= 24) break;
    }
    dayCursor.setUTCDate(dayCursor.getUTCDate() + 1);
  }
  return slots;
}

/** Build a UTC ISO timestamp for a wall-clock time in the given IANA zone on the same local calendar day as `day`. */
function zonedTimeToUtcIso(day: Date, hour: number, minute: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(day);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const dayNum = parts.find((part) => part.type === 'day')?.value;
  if (!year || !month || !dayNum) return null;
  const guess = new Date(`${year}-${month}-${dayNum}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`);
  // Adjust from a UTC guess to the target zone offset for that local wall time.
  const asZone = new Date(guess.toLocaleString('en-US', { timeZone }));
  const asUtc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
  const offset = asUtc.getTime() - asZone.getTime();
  return new Date(guess.getTime() + offset).toISOString();
}

export async function bookAppointment(token: string, opts: { slotIso: string; name: string; email: string; notes?: string }) {
  const lead = getLeadByBookingToken(token);
  if (!lead) throw new Error('This booking link is invalid or expired.');
  if (!['approved', 'draft_ready', 'booked'].includes(lead.lead_status)) {
    throw new Error('This lead is not open for booking yet.');
  }
  const when = new Date(opts.slotIso);
  if (Number.isNaN(when.getTime())) throw new Error('Choose a valid time.');
  if (when.getTime() < Date.now() + MIN_BOOKING_MS) {
    throw new Error('Appointments must be scheduled at least 24 hours in advance.');
  }
  const appointmentId = id('appt_');
  run(
    `INSERT INTO lead_appointments (
      id, lead_id, scheduled_at, contact_name, contact_email, notes, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'booked', ?)`,
    [appointmentId, lead.id, when.toISOString(), opts.name.trim(), opts.email.trim().toLowerCase(), opts.notes || null, nowIso()],
  );
  run(`UPDATE leads SET lead_status = 'booked', updated_at = ? WHERE id = ?`, [nowIso(), lead.id]);

  const title = `Demo booked: ${lead.business_name}`;
  const detail = [
    `${opts.name} booked a 15-minute video demo for ${lead.business_name} (${lead.city}).`,
    `When: ${when.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'full', timeStyle: 'short' })} PT`,
    `Contact: ${opts.email}`,
    opts.notes ? `Notes: ${opts.notes}` : '',
    'Prepare the personalized website demo before the call. Do not send the demo beforehand.',
  ]
    .filter(Boolean)
    .join('\n');

  const notificationId = createOwnerNotification({
    kind: 'demo_booked',
    title,
    body: detail,
    lead_id: lead.id,
    appointment_id: appointmentId,
  });

  await notifyOwnerHook({
    title,
    body: detail,
    lead_id: lead.id,
    appointment_id: appointmentId,
    scheduled_at: when.toISOString(),
  });

  const ownerEmail = process.env.OWNER_NOTIFY_EMAIL || process.env.ADMIN_EMAIL || 'admin@bbls.studio';
  logEmail('owner_booking_alert', ownerEmail, title, detail);

  return {
    appointment_id: appointmentId,
    notification_id: notificationId,
    lead,
    scheduled_at: when.toISOString(),
  };
}

export function createOwnerNotification(input: {
  kind: string;
  title: string;
  body: string;
  lead_id?: string | null;
  appointment_id?: string | null;
}) {
  const notificationId = id('ntf_');
  run(
    `INSERT INTO owner_notifications (
      id, kind, title, body, lead_id, appointment_id, read_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    [notificationId, input.kind, input.title, input.body, input.lead_id || null, input.appointment_id || null, nowIso()],
  );
  return notificationId;
}

export async function notifyOwnerHook(payload: Record<string, unknown>) {
  const webhook = process.env.OWNER_NOTIFY_WEBHOOK?.trim();
  if (!webhook) return { delivered: false, reason: 'OWNER_NOTIFY_WEBHOOK not set' as const };
  try {
    const response = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'bbls-lead-agent', ...payload }),
    });
    return { delivered: response.ok, status: response.status };
  } catch (error) {
    return { delivered: false, reason: error instanceof Error ? error.message : 'webhook failed' };
  }
}

export function listOwnerNotifications(limit = 40) {
  return rows<{
    id: string;
    kind: string;
    title: string;
    body: string;
    lead_id: string | null;
    appointment_id: string | null;
    read_at: string | null;
    created_at: string;
  }>(`SELECT * FROM owner_notifications ORDER BY created_at DESC LIMIT ?`, [limit]);
}

export function markNotificationRead(notificationId: string) {
  run(`UPDATE owner_notifications SET read_at = ? WHERE id = ?`, [nowIso(), notificationId]);
}

export function listAppointments(leadId?: string) {
  if (leadId) {
    return rows(`SELECT * FROM lead_appointments WHERE lead_id = ? ORDER BY scheduled_at DESC`, [leadId]);
  }
  return rows(
    `SELECT a.*, l.business_name, l.city, l.category
     FROM lead_appointments a
     JOIN leads l ON l.id = a.lead_id
     ORDER BY a.scheduled_at DESC`,
  );
}

export function leadDashboardSummary() {
  const byStatus = rows<{ lead_status: string; c: number }>(
    `SELECT lead_status, COUNT(*) as c FROM leads GROUP BY lead_status`,
  );
  const unread = row<{ c: number }>(`SELECT COUNT(*) as c FROM owner_notifications WHERE read_at IS NULL`)?.c || 0;
  const upcoming = row<{ c: number }>(
    `SELECT COUNT(*) as c FROM lead_appointments WHERE status = 'booked' AND scheduled_at > ?`,
    [nowIso()],
  )?.c || 0;
  return {
    region: 'Orange County, CA',
    byStatus: Object.fromEntries(byStatus.map((item) => [item.lead_status, item.c])),
    unreadNotifications: unread,
    upcomingAppointments: upcoming,
    total: row<{ c: number }>('SELECT COUNT(*) as c FROM leads')?.c || 0,
  };
}
