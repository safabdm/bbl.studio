/**
 * Freelance opportunity paste → score → proposal draft.
 * No scraping, no marketplace API calls, no auto-submit, no outreach email.
 */
export type FreelanceJobInput = {
  id?: string;
  title?: string;
  body?: string;
  description?: string;
  budget?: string;
  location?: string;
  source?: string;
};

export type ScoredFreelanceJob = {
  id: string;
  title: string;
  body: string;
  source: string;
  budget: string;
  location: string;
  score: number;
  tier: 'strong' | 'possible' | 'skip';
  reasons: string[];
  proposal_draft: string;
  status: 'draft_for_owner_review';
  auto_submit: false;
};

const BEAUTY_WELLNESS = [
  'salon',
  'hair',
  'nail',
  'lash',
  'brow',
  'spa',
  'med spa',
  'medspa',
  'aesthetic',
  'skincare',
  'skin care',
  'beauty',
  'wellness',
  'barber',
  'makeup',
  'cosmetic',
  'boutique',
  'massage',
  'facial',
  'dermatolog',
  'injectable',
  'botox',
  'laser',
] as const;

const WEB_BUILD = [
  'website',
  'web site',
  'web design',
  'web development',
  'landing page',
  'squarespace',
  'wix',
  'wordpress',
  'shopify',
  'webflow',
  'booking',
  'online booking',
  'appointment',
  'ecommerce',
  'e-commerce',
  'redesign',
  'rebuild',
  'new site',
] as const;

const US_REMOTE_OK = [
  'united states',
  'usa',
  'u.s.',
  'us only',
  'us-based',
  'remote',
  'anywhere',
  'worldwide',
  'california',
  'orange county',
  'irvine',
  'newport',
  'costa mesa',
  'laguna',
  'los angeles',
  'la area',
] as const;

const LOCATION_PENALTY = [
  'on-site only',
  'onsite only',
  'must be local',
  'must relocate',
  'india only',
  'pakistan only',
  'philippines only',
  'eu only',
  'europe only',
  'uk only',
] as const;

const NEGATIVE = [
  'logo only',
  'just a logo',
  'flyer only',
  'data entry',
  'virtual assistant',
  'va needed',
  'app only',
  'ios app',
  'android app',
  'blockchain',
  'crypto',
  'nft',
  'wordpress plugin only',
] as const;

function norm(text: string): string {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function hasAny(text: string, phrases: readonly string[]): string[] {
  let n = norm(text);
  n = n.replace(/\b(?:not|no|isn't|is not|aren't|without)\b[^.!?\n]{0,40}/g, ' ');
  return phrases.filter((p) => n.includes(p));
}

const TITLE_RE = /(?:^|\n)\s*(?:title|job title|project)\s*[:\-]\s*(.+)$/im;
const BUDGET_RE = /(?:^|\n)\s*(?:budget|rate|hourly|fixed)\s*[:\-]\s*(.+)$/im;
const LOCATION_RE = /(?:^|\n)\s*(?:location|client location|prefers)\s*[:\-]\s*(.+)$/im;
const SOURCE_RE = /(?:^|\n)\s*(?:source|platform|url|link)\s*[:\-]\s*(.+)$/im;

export function parsePastedJob(text: string, fallbackId = 'paste-1'): FreelanceJobInput {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('Empty paste');
  const parts = raw.split(/\n\s*---+\s*\n/);
  const titleM = TITLE_RE.exec(raw);
  const budgetM = BUDGET_RE.exec(raw);
  const locM = LOCATION_RE.exec(raw);
  const sourceM = SOURCE_RE.exec(raw);
  let title = titleM?.[1]?.trim() || '';
  let body = parts.length > 1 ? parts[1]!.trim() : raw;
  if (!title) {
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      if (/^(title|budget|rate|hourly|fixed|location|source|platform|url|link)\s*[:\-]/i.test(s)) continue;
      title = s.slice(0, 120);
      break;
    }
  }
  if (parts.length === 1) {
    body = raw
      .split('\n')
      .filter((line) => !/^(title|budget|rate|hourly|fixed|location|source|platform|url|link)\s*[:\-]/i.test(line.trim()))
      .join('\n')
      .trim() || raw;
  }
  return {
    id: fallbackId,
    title: title || fallbackId,
    body,
    budget: budgetM?.[1]?.trim() || '',
    location: locM?.[1]?.trim() || '',
    source: sourceM?.[1]?.trim() || 'paste',
  };
}

function clientHint(job: FreelanceJobInput): string {
  const blob = `${job.title || ''}\n${(job.body || job.description || '').slice(0, 400)}`;
  for (const phrase of BEAUTY_WELLNESS) {
    if (norm(blob).includes(phrase)) return phrase;
  }
  return 'your business';
}

function draftProposal(job: FreelanceJobInput, score: number, tier: string, reasons: string[]): string {
  const title = String(job.title || 'your project').trim();
  const niche = clientHint(job);
  const locNote = job.location ? ` I saw you’re looking for help with location preference: ${job.location}.` : '';
  let need = '';
  for (const line of String(job.body || job.description || '').split('\n')) {
    const s = line.trim();
    if (s.length > 40 && !/^(skills|budget|proposals)/i.test(s)) {
      need = s.slice(0, 180).replace(/\.$/, '');
      break;
    }
  }
  if (!need) {
    need = 'a clean, modern website that makes it easy for clients to book and trust your brand';
  }
  if (tier === 'skip') {
    return `[SKIP — score ${score}/100]\nDo not submit unless you intentionally override.\nReasons: ${reasons.join('; ')}\n`;
  }
  return [
    'Hi —',
    '',
    'I help beauty and wellness businesses (salons, med spas, skincare, boutiques) get websites that look premium and make booking simple.',
    '',
    `Your post — “${title}” — stood out because it matches what I build day to day for ${niche} brands.${locNote}`,
    '',
    `What I heard you need: ${need}.`,
    '',
    'I’m Safa with BBL Studio (Orange County / US remote). I design and build custom sites with clear booking flows — not generic templates. Happy to review your current site (or brief) and outline a practical plan before any commitment.',
    '',
    'Custom scope and pricing are private — I share a quote only after we align on needs. No auto-bids.',
    '',
    'If useful, I can share a short walkthrough of similar beauty/wellness work and ask a few clarifying questions on scope, timeline, and must-haves.',
    '',
    'Looking forward to hearing from you,',
    'Safa',
    'BBL Studio',
    'hello@bbl.studio · www.bbl.studio',
    '',
    '[draft_for_owner_review — auto_submit: false]',
  ].join('\n');
}

export function scoreFreelanceJob(input: FreelanceJobInput, index = 0): ScoredFreelanceJob {
  const job = {
    id: String(input.id || `job-${index + 1}`),
    title: String(input.title || 'Untitled').trim() || 'Untitled',
    body: String(input.body || input.description || ''),
    source: String(input.source || 'paste'),
    budget: String(input.budget || ''),
    location: String(input.location || ''),
  };
  const blob = `${job.title}\n${job.body}\n${job.location}\n${job.budget}`;
  const reasons: string[] = [];
  let score = 0;

  const beauty = hasAny(blob, BEAUTY_WELLNESS);
  const web = hasAny(blob, WEB_BUILD);
  const us = hasAny(blob, US_REMOTE_OK);
  const neg = hasAny(blob, NEGATIVE);
  const locBad = hasAny(blob, LOCATION_PENALTY);

  if (beauty.length) {
    score += 35;
    reasons.push(`Beauty/wellness fit: ${beauty.slice(0, 4).join(', ')}`);
  } else {
    reasons.push('No clear beauty/wellness niche signal');
  }
  if (web.length) {
    score += 35;
    reasons.push(`Website/booking work: ${web.slice(0, 4).join(', ')}`);
  } else {
    reasons.push('No clear website/booking signal');
  }
  if (us.length) {
    score += 20;
    reasons.push(`US/remote/OC OK: ${us.slice(0, 3).join(', ')}`);
  } else {
    reasons.push('Location/remote preference unclear — verify before proposing');
  }

  const n = norm(`${job.budget} ${blob}`);
  if (/\$\s?\d{3,}|fixed.?price|budget/.test(n)) {
    score += 5;
    reasons.push('Budget mentioned');
  }
  if (/\$\s?(?:[5-9]\d{2,}|\d{4,})/.test(n) || /long.?term/.test(n)) {
    score += 5;
    reasons.push('Budget/scope looks substantive');
  }
  if (neg.length) {
    score -= 25;
    reasons.push(`Weak fit / out of scope: ${neg.slice(0, 3).join(', ')}`);
  }
  if (locBad.length) {
    score -= 20;
    reasons.push(`Location restriction risk: ${locBad.slice(0, 2).join(', ')}`);
  }

  score = Math.max(0, Math.min(100, score));
  const tier = score >= 70 ? 'strong' : score >= 45 ? 'possible' : 'skip';

  return {
    ...job,
    score,
    tier,
    reasons,
    proposal_draft: draftProposal(job, score, tier, reasons),
    status: 'draft_for_owner_review',
    auto_submit: false,
  };
}

export function importFreelanceJobs(input: {
  paste?: string;
  jobs?: FreelanceJobInput[];
}): { ok: true; jobs: ScoredFreelanceJob[]; auto_submit: false } {
  const scored: ScoredFreelanceJob[] = [];
  if (Array.isArray(input.jobs) && input.jobs.length) {
    input.jobs.forEach((job, i) => scored.push(scoreFreelanceJob(job, i)));
  } else if (input.paste && String(input.paste).trim()) {
    const chunks = String(input.paste).split(/\n={5,}\n/);
    chunks.forEach((chunk, i) => {
      const trimmed = chunk.trim();
      if (!trimmed) return;
      scored.push(scoreFreelanceJob(parsePastedJob(trimmed, `paste-${i + 1}`), i));
    });
  } else {
    throw new Error('Provide paste text or a jobs array.');
  }
  return { ok: true, jobs: scored, auto_submit: false };
}
