/**
 * Body copy for prerendered marketing pages.
 * Unverifiable claims are marked [OWNER REVIEW] for owner approval.
 */
import { caseStudies } from './seo-content';
import {
  BOOK,
  EMAIL,
  PHONE,
  SERVICE_AREA_CITIES,
  portfolioNote,
  projects,
  type MarketingPage,
} from './public-marketing';

export type BodySection = {
  eyebrow?: string;
  heading: string;
  paragraphs: string[];
  bullets?: string[];
  links?: { href: string; label: string }[];
  image?: { src: string; alt: string; width?: number; height?: number };
};

export type PageBody = {
  intro: string;
  sections: BodySection[];
  ctaLabel?: string;
};

function processSections(serviceName: string, included: string[]): BodySection[] {
  return [
    {
      eyebrow: 'Problem',
      heading: 'What usually goes wrong.',
      paragraphs: [
        'Many business sites bury the offer, look like a template, or send visitors nowhere useful. The result is polite traffic that never becomes a conversation.',
      ],
    },
    {
      eyebrow: 'Approach',
      heading: 'How BBL Studio works.',
      paragraphs: [
        'BBL Studio plans the offer, audience, and next action first, then designs and builds a custom site around that path. Strategy, design, and development stay in one studio.',
      ],
    },
    {
      eyebrow: 'Included',
      heading: `What a ${serviceName} engagement covers.`,
      paragraphs: ['Scope is confirmed in writing before work begins. Typical inclusions:'],
      bullets: included,
    },
    {
      eyebrow: 'Process',
      heading: 'From first call to launch.',
      paragraphs: [
        'Consultation → scope confirmation → design → build → review → launch support. [OWNER REVIEW: public timeline claims such as “14 days” are withheld until approved.]',
      ],
    },
  ];
}

const buyerBodies: Record<string, PageBody> = {
  '/med-spa-website-design': {
    intro:
      'Med spas need a site that feels as considered as the treatment room — clear services, credible presentation, and an obvious path to book or inquire. BBL Studio designs custom med spa websites for Orange County practices.',
    sections: [
      ...processSections('med spa website', [
        'Custom page design matched to your offer and brand',
        'Service presentation that stays readable on mobile',
        'Inquiry or booking CTA placement planned with you',
        'Basic on-page SEO and analytics setup at launch',
        'Revision rounds agreed in the written scope',
      ]),
      {
        heading: 'Real portfolio only.',
        paragraphs: [
          portfolioNote,
          'Industry-specific outcome stats are not listed here. [OWNER REVIEW: add med-spa case studies only when a live, owner-approved project exists.]',
        ],
        links: [
          { href: '/work', label: 'View selected work' },
          { href: '/booking-website-design', label: 'Booking-focused sites' },
          { href: '/orange-county-web-design', label: 'Orange County web design' },
        ],
      },
    ],
  },
  '/salon-website-design': {
    intro:
      'Salon websites should look distinctive and make the next step obvious — book, call, or inquire. BBL Studio designs custom salon sites for hair, beauty, and wellness businesses in Orange County.',
    sections: [
      ...processSections('salon website', [
        'Custom visual direction (not a salon template skin)',
        'Clear services and location context when needed',
        'Mobile-first layouts for on-the-go visitors',
        'Forms or booking CTAs as scoped',
        'Launch support and basic on-page SEO',
      ]),
      {
        heading: 'Real portfolio only.',
        paragraphs: [
          portfolioNote,
          '[OWNER REVIEW: add salon-specific case studies only when live and approved.]',
        ],
        links: [
          { href: '/work', label: 'View selected work' },
          { href: '/med-spa-website-design', label: 'Med spa websites' },
          { href: BOOK, label: 'Book a consultation' },
        ],
      },
    ],
  },
  '/booking-website-design': {
    intro:
      'When the business runs on appointments, the website has one job after the first impression: make scheduling the obvious next step. BBL Studio designs booking-oriented sites without inventing platform lock-in.',
    sections: [
      ...processSections('booking website', [
        'Information architecture that leads to a booking or consult CTA',
        'Custom design that still feels brand-led',
        'Integration planning for the booking tool you choose',
        'Mobile-ready flows and form fallbacks',
        'Analytics setup so you can see what visitors do',
      ]),
      {
        heading: 'Tools and claims.',
        paragraphs: [
          'Specific booking vendors are selected per project after consultation. BBL Studio does not claim a partnership or results percentage without owner-approved evidence.',
          portfolioNote,
        ],
        links: [
          { href: '/landing-page-design', label: 'Landing page design' },
          { href: '/work', label: 'Selected work' },
          { href: BOOK, label: 'Book a consultation' },
        ],
      },
    ],
  },
  '/website-redesign': {
    intro:
      'A redesign is for businesses that have outgrown a template, an outdated site, or a structure that hides the offer. BBL Studio rebuilds the public face around clarity and conversion — not decoration alone.',
    sections: [
      ...processSections('website redesign', [
        'Audit of the current site’s clarity and gaps',
        'New information architecture and page plan',
        'Custom design and responsive build',
        'Redirect planning for important URLs when needed',
        'Launch support and basic SEO carryover',
      ]),
      {
        heading: 'Portfolio context.',
        paragraphs: [portfolioNote],
        links: [
          { href: '/ux-audit', label: 'Start with a UX audit' },
          { href: '/work', label: 'Selected work' },
          { href: BOOK, label: 'Book a consultation' },
        ],
      },
    ],
  },
  '/ux-audit': {
    intro:
      'A UX audit is a structured review before you spend on a full redesign. BBL Studio examines clarity, navigation, mobile usability, and inquiry paths — then prioritizes what to fix first.',
    sections: [
      {
        eyebrow: 'Problem',
        heading: 'Guessing is expensive.',
        paragraphs: [
          'Teams often redesign the wrong pages or polish visuals while the offer and next step stay unclear. An audit separates evidence from opinion.',
        ],
      },
      {
        eyebrow: 'Approach',
        heading: 'What we review.',
        paragraphs: ['Typical review areas:'],
        bullets: [
          'First screen clarity and value proposition',
          'Navigation and findability of key offers',
          'Mobile readability and tap targets',
          'Forms, CTAs, and dead ends',
          'Trust cues that are present vs missing (without inventing testimonials)',
        ],
      },
      {
        eyebrow: 'Deliverable',
        heading: 'What you receive.',
        paragraphs: [
          'A written findings list with prioritized recommendations. This is not a traffic, ranking, or revenue guarantee.',
          '[OWNER REVIEW: publish sample audit excerpt only if owner approves a sanitized example.]',
        ],
        links: [
          { href: '/website-redesign', label: 'Website redesign' },
          { href: BOOK, label: 'Book a consultation' },
        ],
      },
    ],
  },
  '/healthcare-ux-design': {
    intro:
      'Healthcare and clinical-adjacent practices need a public site that builds trust without overclaiming. BBL Studio designs clear, careful UX and websites for professional healthcare presentation.',
    sections: [
      ...processSections('healthcare website', [
        'Clear service explanation without invented clinical outcomes',
        'Accessible, readable layouts',
        'Contact and appointment paths as scoped',
        'Custom design aligned to your practice voice',
        'Basic on-page SEO and analytics at launch',
      ]),
      {
        heading: 'Compliance and claims.',
        paragraphs: [
          'BBL Studio does not invent patient results, ratings, or medical claims. Copy that requires clinical or legal review is marked for owner approval before publish.',
          portfolioNote,
          '[OWNER REVIEW: healthcare vertical case studies only when live and approved.]',
        ],
        links: [
          { href: '/med-spa-website-design', label: 'Med spa websites' },
          { href: '/ux-audit', label: 'UX audit' },
          { href: BOOK, label: 'Book a consultation' },
        ],
      },
    ],
  },
};

export function bodyFor(page: MarketingPage): PageBody {
  if (buyerBodies[page.path]) return buyerBodies[page.path]!;

  if (page.path === '/orange-county-web-design') {
    return {
      intro:
        'BBL Studio designs custom websites for Orange County businesses that want a distinctive public presence — not a swapped template. Strategy, design, and development stay connected from planning to launch.',
      sections: [
        {
          heading: 'Service area.',
          paragraphs: [
            `BBL Studio works with businesses in ${SERVICE_AREA_CITIES.join(', ')}, and nearby Orange County cities.`,
            'The studio does not list a public street storefront on city pages. Virtual office addresses are not used as Google Business Profile storefront pins.',
          ],
        },
        {
          heading: 'Website services.',
          paragraphs: ['Choose the engagement that matches the job:'],
          links: [
            { href: '/landing-page-design', label: 'Landing page design' },
            { href: '/business-website-design', label: 'Business website design' },
            { href: '/commercial-web-design', label: 'Commercial web design' },
            { href: '/med-spa-website-design', label: 'Med spa websites' },
            { href: '/salon-website-design', label: 'Salon websites' },
            { href: '/website-redesign', label: 'Website redesign' },
          ],
        },
        {
          heading: 'Related work.',
          paragraphs: [portfolioNote],
          links: [
            ...projects.map((p) => ({ href: p.path, label: p.name })),
            { href: BOOK, label: 'Book a consultation' },
          ],
        },
      ],
    };
  }

  if (page.path === '/landing-page-design') {
    return {
      intro:
        'A landing page is one focused page built around a single offer and a clear next step. BBL Studio designs custom landing pages for Orange County businesses — custom quote after consultation.',
      sections: [
        ...processSections('landing page', [
          'One custom page design',
          'Responsive layout',
          'Clear CTA and lead form',
          'Basic on-page SEO and analytics',
          'Launch support and agreed revisions',
        ]),
        {
          heading: 'Related work.',
          paragraphs: [
            portfolioNote,
            'Landing-page engagements share the same clarity and inquiry-path standards as the live business and commercial sites below.',
          ],
          links: [
            { href: '/work/raysan-ip', label: 'Raysan IP' },
            { href: '/work', label: 'All selected work' },
            { href: BOOK, label: 'Book a consultation' },
          ],
        },
        {
          heading: 'Related services.',
          paragraphs: [],
          links: [
            { href: '/business-website-design', label: 'Business websites' },
            { href: '/orange-county-web-design', label: 'Orange County web design' },
            { href: BOOK, label: 'Book a consultation' },
          ],
        },
      ],
    };
  }

  if (page.path === '/business-website-design') {
    return {
      intro:
        'A business website gives a growing company a complete, credible presence — typically several custom pages with clear navigation and an inquiry path. Custom quote after consultation.',
      sections: [
        ...processSections('business website', [
          'Up to five custom pages (scope confirmed in writing)',
          'Strategy and navigation',
          'Forms and responsive build',
          'Basic on-page SEO and analytics',
          'Launch support',
        ]),
        {
          heading: 'Related work.',
          paragraphs: [portfolioNote],
          links: [
            { href: '/work/7-stud-farm', label: '7 Stud Farm' },
            { href: '/work/ip-law-nerds', label: 'IP Law Nerds' },
            { href: BOOK, label: 'Book a consultation' },
          ],
        },
      ],
    };
  }

  if (page.path === '/commercial-web-design') {
    return {
      intro:
        'Commercial websites need stronger architecture — more pages, clearer journeys, and conversion-focused structure. BBL Studio designs and builds these as custom engagements. Custom quote after consultation.',
      sections: [
        ...processSections('commercial website', [
          'Six to ten custom pages when scoped',
          'Custom UX and information architecture',
          'Forms and integrations as agreed',
          'On-page SEO, analytics, and launch support',
          'Agreed revision rounds',
        ]),
        {
          heading: 'Related work.',
          paragraphs: [portfolioNote],
          links: [
            { href: '/work/raysan-ip', label: 'Raysan IP' },
            { href: '/work', label: 'All selected work' },
            { href: BOOK, label: 'Book a consultation' },
          ],
        },
      ],
    };
  }

  if (page.path === '/work') {
    return {
      intro: 'These are live websites BBL Studio designed. Visit each site as it exists today — no invented metrics.',
      sections: [
        {
          heading: 'Selected projects.',
          paragraphs: projects.map((p) => `${p.name} — ${p.description}`),
          links: projects.map((p) => ({ href: p.path, label: `Case study: ${p.name}` })),
        },
        {
          heading: 'Services behind the work.',
          paragraphs: [],
          links: [
            { href: '/commercial-web-design', label: 'Commercial web design' },
            { href: '/business-website-design', label: 'Business website design' },
            { href: '/orange-county-web-design', label: 'Orange County web design' },
          ],
        },
      ],
    };
  }

  if (page.path.startsWith('/work/')) {
    const slug = page.path.replace('/work/', '') as keyof typeof caseStudies;
    const study = caseStudies[slug];
    if (!study) {
      return { intro: page.description, sections: [] };
    }
    const relatedServices =
      study.servicePath === '/business-website-design'
        ? [
            { href: '/business-website-design', label: 'Business website design' },
            { href: '/orange-county-web-design', label: 'Orange County web design' },
          ]
        : [
            { href: '/commercial-web-design', label: 'Commercial web design' },
            { href: '/landing-page-design', label: 'Landing page design' },
          ];
    return {
      intro: study.overview,
      sections: [
        {
          heading: 'Challenge',
          paragraphs: [study.challenge],
          image: { src: study.image, alt: study.alt, width: 1100, height: 688 },
        },
        { heading: 'Role', paragraphs: [study.role] },
        { heading: 'Process', paragraphs: [study.process] },
        { heading: 'Solution', paragraphs: [study.solution] },
        {
          heading: 'Live site',
          paragraphs: [`Visit the live website: ${study.href}`],
          links: [
            { href: study.href, label: `Open ${study.name}` },
            ...relatedServices,
            { href: '/work', label: 'All work' },
            { href: BOOK, label: 'Book a consultation' },
          ],
        },
      ],
    };
  }

  if (page.path === '/about') {
    return {
      intro:
        'BBL Studio (BBL Boutique Brand & Launch Studio) is a boutique website design studio in Orange County, California. We don’t shape bodies. We build businesses.',
      sections: [
        {
          heading: 'What we do.',
          paragraphs: [
            'Custom website strategy, design, and development for businesses that need a distinctive public presence. Landing pages, business websites, and commercial sites — with optional brand identity when the visual foundation needs work.',
          ],
        },
        {
          heading: 'Who we serve.',
          paragraphs: [
            'Orange County businesses and selective remote clients who want custom work, not a theme with stock photos. Typical verticals include professional services, hospitality-adjacent brands, and growth-focused local companies.',
            '[OWNER REVIEW: tighten vertical list to owner-approved niches only.]',
          ],
        },
        {
          heading: 'How to start.',
          paragraphs: [`Book a consultation, email ${EMAIL}, or call ${PHONE}.`],
          links: [
            { href: BOOK, label: 'Book a consultation' },
            { href: '/work', label: 'Selected work' },
            { href: '/contact', label: 'Contact' },
          ],
        },
      ],
    };
  }

  if (page.path === '/contact') {
    return {
      intro: `Tell BBL Studio about your project. Primary next step: book a free consultation. Or email ${EMAIL} / call ${PHONE}.`,
      sections: [
        {
          heading: 'Book a consultation.',
          paragraphs: ['Choose a time that works. Appointments need at least 48 hours’ notice (Pacific Time).'],
          links: [{ href: BOOK, label: 'Book now' }],
        },
        {
          heading: 'Send a project note.',
          paragraphs: [
            'Use the inquiry form on this page. Messages go to the studio inbox. Primary CTA remains booking.',
          ],
        },
      ],
      ctaLabel: 'Book a consultation',
    };
  }

  return {
    intro: page.description,
    sections: [
      {
        heading: 'Next step.',
        paragraphs: ['Book a free consultation with BBL Studio.'],
        links: [{ href: BOOK, label: 'Book a consultation' }],
      },
    ],
  };
}
