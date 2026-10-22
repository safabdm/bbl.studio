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
      q: 'What is a Business Website from BBL?',
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
      q: 'Which BBL websites can I visit?',
      a: 'Selected live work includes Raysan IP, 7 Stud Farm, and IP Law Nerds. Each project page covers challenge, role, process, solution, and a live site link.',
    },
    CORE_FAQS[5],
  ],
  '/orange-county/irvine-web-design': [
    {
      q: 'Does BBL design websites for Irvine businesses?',
      a: 'Yes. BBL designs landing pages, business websites, and commercial websites for Irvine companies that need a credible, conversion-ready public site.',
    },
    CORE_FAQS[1],
    HOME_FAQS[2],
  ],
  '/orange-county/newport-beach-web-design': [
    {
      q: 'Does BBL design websites for Newport Beach businesses?',
      a: 'Yes. BBL designs websites for Newport Beach hospitality, professional, and coastal businesses that need a polished first impression and a clear inquiry path.',
    },
    CORE_FAQS[1],
    HOME_FAQS[2],
  ],
  '/orange-county/costa-mesa-web-design': [
    {
      q: 'Does BBL design websites for Costa Mesa businesses?',
      a: 'Yes. BBL designs websites for Costa Mesa retail, restaurant, and commercial companies that need to present the business clearly and take inquiries online.',
    },
    CORE_FAQS[1],
    HOME_FAQS[2],
  ],
  '/orange-county/laguna-beach-web-design': [
    {
      q: 'Does BBL design websites for Laguna Beach businesses?',
      a: 'Yes. BBL designs distinctive websites for Laguna Beach galleries, hospitality, and boutique brands that need a site as considered as the work they sell.',
    },
    CORE_FAQS[1],
    HOME_FAQS[2],
  ],
  '/orange-county/tustin-web-design': [
    {
      q: 'Does BBL design websites for Tustin businesses?',
      a: 'Yes. BBL designs clear, credible websites for Tustin service companies, trades, and growing family businesses that need to be found and contacted.',
    },
    CORE_FAQS[1],
    HOME_FAQS[2],
  ],
};

/**
 * Case study pages omit a public Outcomes section until the owner supplies
 * real metrics. Never invent traffic, ranking, conversion, or revenue figures.
 */
export const caseStudies = {
  'raysan-ip': {
    ...projects[0],
    overview:
      'Raysan IP is a global intellectual property information platform. BBL planned the brand and website so a specialized information business could present itself with the same clarity it expects from the work it publishes.',
    challenge:
      'Intellectual property information is easy to bury under legal jargon or a generic professional template. The site needed to look serious enough for an international audience of companies, counsel, and professionals — without becoming a brochure that hides what the platform actually does.',
    role: 'BBL Studio led strategy, brand, and commercial website design through launch for Raysan IP.',
    process:
      'The engagement treated the website as a commercial information product, not a law-firm lookalike. Structure, naming, and page hierarchy were planned so the offer is visible immediately and the brand can travel across markets without rewriting the story on every page. Design and build followed that architecture into a dark editorial system with restrained typography and a clear inquiry path.',
    solution:
      'A live commercial website and brand system for a global IP information platform: responsive layouts for desktop and mobile review, an international formal visual language with enough distinction to stand apart from generic professional templates, and a public inquiry path at raysanip.com.',
  },
  '7-stud-farm': {
    ...projects[1],
    overview:
      '7 Stud Farm is an international sport horse breeding program. BBL provided brand direction and a website that lets the program present bloodlines, photography, and the farm’s point of view in one place.',
    challenge:
      'Equestrian programs often inherit a patchwork of photos, PDFs, and social posts. International buyers, breeders, and partners — many of whom will never visit the farm first — needed a single, durable site that felt as considered as the horses themselves, without turning the farm into a luxury cliché.',
    role: 'BBL Studio provided brand direction and business website design and build for 7 Stud Farm.',
    process:
      'Brand direction set how images, type, and naming should sit together so the farm can add horses and stories later without redesigning the public face each season. The site was planned as photography-led and deliberately quiet, then designed and built so supporting copy stays short enough that a visitor can move from first look to inquiry without hunting.',
    solution:
      'A live business website at 7studfarm.com with large equestrian photography, restrained typography, a measured pace, and a clear path to inquire — one durable public face for bloodlines, photography, and the farm’s point of view.',
  },
  'ip-law-nerds': {
    ...projects[2],
    overview:
      'IP Law Nerds is an approachable intellectual property practice. BBL designed the brand expression and website so the firm could sound like itself: direct, human, and still serious about the work.',
    challenge:
      'Legal websites often default to marble, Latin, and distance. This practice needed a public site that founders, operators, and growing companies would actually read — without undermining the credibility required for IP counsel.',
    role: 'BBL Studio designed brand expression and the business website for IP Law Nerds.',
    process:
      'Brand expression and website structure were planned together so the name, tone, and pages feel like one practice rather than a logo dropped onto a legal template. The site leads with voice and a clear service picture; design and build kept pages short enough that a first-time visitor can decide whether to inquire.',
    solution:
      'A live business website at iplawnerds.com with an open, readable layout, a direct voice, and color and type that support approachability without becoming casual — plus a clear inquiry path for founders and businesses looking for intellectual property help.',
  },
} as const;
