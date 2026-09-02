import { CORE_FAQS, HOME_FAQS, projects } from './site';

export type FaqItem = { q: string; a: string };

export const PAGE_FAQS: Record<string, FaqItem[]> = {
  '/': [...HOME_FAQS],
  '/orange-county-web-design': [...CORE_FAQS],
  '/landing-page-design': [
    CORE_FAQS[3],
    {
      q: 'What is included in a Simple Landing Page?',
      a: 'One custom designed page, responsive layouts, a clear call to action, a contact or lead form, basic on page SEO, analytics, launch support, and up to two revision rounds. Starting price is $3,000.',
    },
    CORE_FAQS[6],
    {
      q: 'When is a landing page the right choice?',
      a: 'A landing page is the right choice when one offer, campaign, or inquiry path needs to stand on its own. If the business needs several destinations, a Business Website or Commercial Website is the better fit.',
    },
  ],
  '/business-website-design': [
    {
      q: 'What is a Business Website from BBLS?',
      a: 'A Business Website starts at $5,500 and includes up to five custom pages, responsive design, clear navigation, forms, basic CMS setup where appropriate, basic on page SEO, analytics, launch support, and up to two revision rounds.',
    },
    CORE_FAQS[2],
    CORE_FAQS[5],
    CORE_FAQS[6],
  ],
  '/commercial-web-design': [
    CORE_FAQS[4],
    {
      q: 'What is included in a Commercial Website?',
      a: 'Six to ten custom pages, custom UX and architecture, conversion focused layouts, advanced forms or integrations, CMS setup where appropriate, on page SEO, analytics and conversion tracking, launch support, and up to three revision rounds. Starting price is $8,500.',
    },
    CORE_FAQS[5],
    CORE_FAQS[6],
  ],
  '/about': [...CORE_FAQS],
  '/contact': [HOME_FAQS[2], CORE_FAQS[1], CORE_FAQS[6]],
  '/work': [
    {
      q: 'Which BBLS websites can I visit?',
      a: 'Selected live work includes Raysan IP, 7 Stud Farm, and IP Law Nerds. Each project page describes the challenge, audience, and deliverables. The live websites are linked from those pages.',
    },
    CORE_FAQS[5],
  ],
  '/orange-county/irvine-web-design': [
    {
      q: 'Does BBLS design websites for Irvine businesses?',
      a: 'Yes. BBLS designs landing pages, business websites, and commercial websites for Irvine companies that need a credible, conversion-ready public site.',
    },
    CORE_FAQS[1],
    HOME_FAQS[2],
  ],
  '/orange-county/newport-beach-web-design': [
    {
      q: 'Does BBLS design websites for Newport Beach businesses?',
      a: 'Yes. BBLS designs websites for Newport Beach hospitality, professional, and coastal businesses that need a polished first impression and a clear inquiry path.',
    },
    CORE_FAQS[1],
    HOME_FAQS[2],
  ],
  '/orange-county/costa-mesa-web-design': [
    {
      q: 'Does BBLS design websites for Costa Mesa businesses?',
      a: 'Yes. BBLS designs websites for Costa Mesa retail, restaurant, and commercial companies that need to present the business clearly and take inquiries online.',
    },
    CORE_FAQS[1],
    HOME_FAQS[2],
  ],
  '/orange-county/laguna-beach-web-design': [
    {
      q: 'Does BBLS design websites for Laguna Beach businesses?',
      a: 'Yes. BBLS designs distinctive websites for Laguna Beach galleries, hospitality, and boutique brands that need a site as considered as the work they sell.',
    },
    CORE_FAQS[1],
    HOME_FAQS[2],
  ],
  '/orange-county/tustin-web-design': [
    {
      q: 'Does BBLS design websites for Tustin businesses?',
      a: 'Yes. BBLS designs clear, credible websites for Tustin service companies, trades, and growing family businesses that need to be found and contacted.',
    },
    CORE_FAQS[1],
    HOME_FAQS[2],
  ],
};

export const caseStudies = {
  'raysan-ip': {
    ...projects[0],
    overview:
      'Raysan IP is a global intellectual property information platform. BBLS planned the brand and website so a specialized information business could present itself with the same clarity it expects from the work it publishes.',
    challenge:
      'Intellectual property information is easy to bury under legal jargon or a generic professional template. The site needed to look serious enough for an international audience without becoming a brochure that hides what the platform actually does.',
    audience:
      'Companies, counsel, and professionals who need a trustworthy place to understand IP information. Visitors arrive with a specific question and little patience for decoration that does not help them decide whether to inquire.',
    strategy:
      'The website was treated as a commercial information product, not a law-firm lookalike. Structure, naming, and page hierarchy were designed so the offer is visible immediately and the brand can travel across markets without rewriting the story on every page.',
    design:
      'A dark editorial system, restrained typography, and a calm layout keep attention on the platform rather than on studio flourishes. The visual language is international and formal, with enough distinction that the site does not disappear among other professional services.',
    deliverables: [
      'Brand system for a global IP information platform',
      'Commercial website structure and page design',
      'Responsive layouts for desktop and mobile review',
      'Inquiry path and live launch',
    ],
  },
  '7-stud-farm': {
    ...projects[1],
    overview:
      '7 Stud Farm is an international sport horse breeding program. BBLS provided brand direction and a website that lets the program present bloodlines, photography, and the farm’s point of view in one place.',
    challenge:
      'Equestrian programs often inherit a patchwork of photos, PDFs, and social posts. Buyers and partners needed a single, durable site that felt as considered as the horses themselves, without turning the farm into a luxury cliché.',
    audience:
      'International buyers, breeders, and partners who evaluate programs through photography, pedigree, and tone. Many will never visit the farm first. The website is often the first complete impression.',
    strategy:
      'The site is photography-led and deliberately quiet. Brand direction set how images, type, and naming should sit together so the farm can add horses and stories later without redesigning the public face each season.',
    design:
      'Large images, restrained type, and a measured pace. The layout gives the photography room and keeps supporting copy short enough that a visitor can move from first look to inquiry without hunting.',
    deliverables: [
      'Brand direction for an international breeding program',
      'Business website design and build',
      'Responsive presentation of farm photography',
      'Live website at 7studfarm.com',
    ],
  },
  'ip-law-nerds': {
    ...projects[2],
    overview:
      'IP Law Nerds is an approachable intellectual property practice. BBLS designed the brand expression and website so the firm could sound like itself: direct, human, and still serious about the work.',
    challenge:
      'Legal websites often default to marble, Latin, and distance. This practice needed a public site that founders and growing companies would actually read, without undermining the credibility required for IP counsel.',
    audience:
      'Founders, operators, and businesses looking for intellectual property help who are wary of firms that feel inaccessible. They need to understand the practice quickly and know how to start a conversation.',
    strategy:
      'The site leads with voice and a clear service picture. Brand expression and website structure were planned together so the name, tone, and pages feel like one practice rather than a logo dropped onto a legal template.',
    design:
      'An open, readable layout with a direct voice. Color and type support approachability without becoming casual. The pages stay short enough that a first-time visitor can decide whether to inquire.',
    deliverables: [
      'Brand expression for an IP practice',
      'Business website design and build',
      'Responsive layouts and inquiry path',
      'Live website at iplawnerds.com',
    ],
  },
} as const;
