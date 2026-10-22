/**
 * Published marketing routes — single source for sitemap, prerender, and redirects.
 * Do not list /admin, /client, /api, or /unsubscribe here.
 */
import { EMAIL, PHONE, SITE_URL, STUDIO_NAME, projects } from './site';

export type MarketingPage = {
  path: string;
  title: string;
  description: string;
  h1: string;
  /** File path under out/ after build, e.g. about.html or work/raysan-ip.html */
  file: string;
  kind: 'home' | 'booking' | 'service' | 'buyer' | 'work-index' | 'work' | 'about' | 'contact' | 'geo';
  /** Visible FAQ pairs — JSON-LD FAQPage only when non-empty and rendered */
  faqs?: { q: string; a: string }[];
};

/** City doorway URLs — 301 to the OC hub; not in sitemap. */
export const CITY_REDIRECTS: { from: string; to: string }[] = [
  { from: '/orange-county/irvine-web-design', to: '/orange-county-web-design' },
  { from: '/orange-county/newport-beach-web-design', to: '/orange-county-web-design' },
  { from: '/orange-county/costa-mesa-web-design', to: '/orange-county-web-design' },
  { from: '/orange-county/laguna-beach-web-design', to: '/orange-county-web-design' },
  { from: '/orange-county/tustin-web-design', to: '/orange-county-web-design' },
];

const BOOK = '/book';

export const SERVICE_AREA_CITIES = [
  'Irvine',
  'Newport Beach',
  'Costa Mesa',
  'Laguna Beach',
  'Tustin',
] as const;

const portfolioNote =
  'Selected live work: Raysan IP, 7 Stud Farm, and IP Law Nerds. No other client results are claimed on this page.';

export const MARKETING_PAGES: MarketingPage[] = [
  {
    path: '/',
    title: 'Website Design in Orange County | BBL Studio',
    description:
      'BBL Studio is a boutique website design studio in Orange County. Custom landing pages, business websites, and commercial sites — strategy, design, and development in one studio.',
    h1: 'Website design in Orange County.',
    file: 'home.html',
    kind: 'home',
    faqs: [
      {
        q: 'What is BBL Studio?',
        a: 'BBL Studio (legal name: BBL Boutique Brand & Launch Studio) is a boutique website design studio serving businesses in Orange County, California.',
      },
      {
        q: 'What website services does BBL Studio offer?',
        a: 'BBL Studio designs custom landing pages, business websites, and commercial websites, with optional brand identity work when a stronger visual foundation is needed.',
      },
      {
        q: 'Does BBL Studio provide website design in Orange County?',
        a: 'Yes. BBL Studio provides custom website design for businesses throughout Orange County, including Irvine, Newport Beach, Costa Mesa, Laguna Beach, and Tustin.',
      },
      {
        q: 'How do I start a project with BBL Studio?',
        a: 'Book a free consultation at https://www.bbl.studio/book, email hello@bbl.studio, or call (949) 524-2324.',
      },
    ],
  },
  {
    path: '/booking',
    title: 'Book a Consultation | BBL Studio',
    description:
      'Book a free BBL Studio consultation. Choose a date and time at least 48 hours ahead. Pacific Time.',
    h1: 'Book a time to talk.',
    file: 'book.html',
    kind: 'booking',
  },
  {
    path: '/orange-county-web-design',
    title: 'Orange County Web Design | BBL Studio',
    description:
      'Orange County web design by BBL Studio. Custom landing pages, business websites, and commercial sites for Irvine, Newport Beach, Costa Mesa, Laguna Beach, Tustin, and nearby cities.',
    h1: 'Orange County web design.',
    file: 'orange-county-web-design.html',
    kind: 'geo',
    faqs: [
      {
        q: 'Does BBL Studio design websites for Orange County businesses?',
        a: 'Yes. BBL Studio designs and builds custom websites for businesses throughout Orange County. The studio does not claim a public street office in each city.',
      },
      {
        q: 'Which Orange County cities does BBL Studio serve?',
        a: 'Service areas include Irvine, Newport Beach, Costa Mesa, Laguna Beach, Tustin, and nearby Orange County cities.',
      },
      {
        q: 'How do I book a website consultation?',
        a: 'Use https://www.bbl.studio/book, email hello@bbl.studio, or call (949) 524-2324.',
      },
    ],
  },
  {
    path: '/landing-page-design',
    title: 'Landing Page Design in Orange County | BBL Studio',
    description:
      'Landing page design by BBL Studio in Orange County. One focused page with a clear offer, inquiry path, and launch-ready structure. Custom quote after consultation.',
    h1: 'Landing page design in Orange County.',
    file: 'landing-page-design.html',
    kind: 'service',
    faqs: [
      {
        q: 'What is included in a BBL Studio landing page?',
        a: 'One custom designed page, responsive layouts, a clear call to action, a contact or lead form, basic on-page SEO, analytics setup, launch support, and agreed revision rounds. Scope is confirmed in writing before work begins.',
      },
      {
        q: 'When is a landing page the right choice?',
        a: 'When one offer, campaign, or inquiry path needs to stand on its own. If the business needs several destinations, a business or commercial website is usually the better fit.',
      },
    ],
  },
  {
    path: '/business-website-design',
    title: 'Small Business Website Design Orange County | BBL Studio',
    description:
      'Business website design in Orange County by BBL Studio. Multi-page custom sites built for credibility and inquiries. Custom quote after consultation.',
    h1: 'Business website design in Orange County.',
    file: 'business-website-design.html',
    kind: 'service',
    faqs: [
      {
        q: 'What is a Business Website from BBL Studio?',
        a: 'A multi-page custom website (typically up to five pages) with responsive design, clear navigation, forms, basic on-page SEO, analytics, and launch support. Final scope is confirmed before work begins.',
      },
    ],
  },
  {
    path: '/commercial-web-design',
    title: 'Commercial Website Design Orange County | BBL Studio',
    description:
      'Commercial website design in Orange County by BBL Studio. Larger custom sites with stronger architecture and conversion-focused structure. Custom quote after consultation.',
    h1: 'Commercial website design in Orange County.',
    file: 'commercial-web-design.html',
    kind: 'service',
    faqs: [
      {
        q: 'What is included in a Commercial Website?',
        a: 'A larger custom site (often six to ten pages) with stronger content architecture, conversion-focused layouts, forms or integrations as scoped, on-page SEO, analytics, and launch support.',
      },
    ],
  },
  {
    path: '/med-spa-website-design',
    title: 'Med Spa Website Design | BBL Studio',
    description:
      'Med spa website design by BBL Studio. Clear offers, credible presentation, and booking-ready inquiry paths for aesthetic and wellness practices in Orange County.',
    h1: 'Med spa website design.',
    file: 'med-spa-website-design.html',
    kind: 'buyer',
    faqs: [
      {
        q: 'Does BBL Studio design websites for med spas?',
        a: 'Yes. BBL Studio designs custom websites for med spas and aesthetic practices that need a clear offer, credible visuals, and a straightforward path to book or inquire.',
      },
      {
        q: 'Can the site connect to online booking?',
        a: 'Yes, when booking is in scope. Integrations are confirmed during consultation — BBL Studio does not invent platform claims.',
      },
    ],
  },
  {
    path: '/salon-website-design',
    title: 'Salon Website Design | BBL Studio',
    description:
      'Salon website design by BBL Studio. Distinctive sites for hair, beauty, and wellness salons that need a polished first impression and clear next step.',
    h1: 'Salon website design.',
    file: 'salon-website-design.html',
    kind: 'buyer',
    faqs: [
      {
        q: 'Does BBL Studio design salon websites?',
        a: 'Yes. BBL Studio designs custom websites for salons that want a distinctive public presence rather than a generic template.',
      },
    ],
  },
  {
    path: '/booking-website-design',
    title: 'Booking Website Design | BBL Studio',
    description:
      'Booking-focused website design by BBL Studio. Sites structured so visitors can understand the offer and take the next scheduling step.',
    h1: 'Booking website design.',
    file: 'booking-website-design.html',
    kind: 'buyer',
    faqs: [
      {
        q: 'Can BBL Studio build a site around online booking?',
        a: 'Yes. Structure, copy hierarchy, and CTA placement are planned so booking or consultation requests are obvious. Specific booking tools are chosen per project.',
      },
    ],
  },
  {
    path: '/website-redesign',
    title: 'Website Redesign | BBL Studio',
    description:
      'Website redesign by BBL Studio. Replace an outdated or unclear site with a custom design that presents the offer clearly and supports inquiries.',
    h1: 'Website redesign.',
    file: 'website-redesign.html',
    kind: 'buyer',
    faqs: [
      {
        q: 'When should a business redesign its website?',
        a: 'When the current site no longer reflects the offer, feels generic, fails on mobile, or does not give visitors a clear next step. Scope is assessed in consultation.',
      },
    ],
  },
  {
    path: '/ux-audit',
    title: 'UX Audit | BBL Studio',
    description:
      'UX audit by BBL Studio. A structured review of clarity, navigation, and conversion paths before a redesign or rebuild.',
    h1: 'UX audit.',
    file: 'ux-audit.html',
    kind: 'buyer',
    faqs: [
      {
        q: 'What does a BBL Studio UX audit cover?',
        a: 'A structured review of first impression, navigation, offer clarity, mobile usability, and inquiry paths — with prioritized recommendations. It is not a traffic or revenue guarantee.',
      },
    ],
  },
  {
    path: '/healthcare-ux-design',
    title: 'Healthcare UX Design | BBL Studio',
    description:
      'Healthcare UX and website design by BBL Studio for practices that need clarity, trust, and a careful public presentation.',
    h1: 'Healthcare UX design.',
    file: 'healthcare-ux-design.html',
    kind: 'buyer',
    faqs: [
      {
        q: 'Does BBL Studio design healthcare websites?',
        a: 'Yes. BBL Studio designs custom websites for healthcare and professional practices that need a clear, credible public site. Clinical claims and outcomes are never invented.',
      },
    ],
  },
  {
    path: '/work',
    title: 'Selected Website Design Work | BBL Studio',
    description:
      'Live BBL Studio website work: Raysan IP, 7 Stud Farm, and IP Law Nerds. Visit each site as it exists today.',
    h1: 'Work you can visit.',
    file: 'work.html',
    kind: 'work-index',
    faqs: [
      {
        q: 'Which BBL Studio websites can I visit?',
        a: 'Selected live work includes Raysan IP, 7 Stud Farm, and IP Law Nerds. Each project page covers challenge, role, process, solution, and a live site link. Outcomes stay marked TODO until the owner provides real metrics.',
      },
    ],
  },
  {
    path: '/work/raysan-ip',
    title: 'Raysan IP Website Case Study | BBL Studio',
    description:
      'Case study: BBL Studio led strategy, brand, and commercial website design for Raysan IP, a global intellectual property information platform. Visit the live site.',
    h1: 'Raysan IP website case study.',
    file: 'work/raysan-ip.html',
    kind: 'work',
  },
  {
    path: '/work/7-stud-farm',
    title: '7 Stud Farm Website Case Study | BBL Studio',
    description:
      'Case study: BBL Studio created brand direction and a business website for 7 Stud Farm, an international sport horse breeding program. Visit the live site.',
    h1: '7 Stud Farm website case study.',
    file: 'work/7-stud-farm.html',
    kind: 'work',
  },
  {
    path: '/work/ip-law-nerds',
    title: 'IP Law Nerds Website Case Study | BBL Studio',
    description:
      'Case study: BBL Studio designed brand expression and a business website for IP Law Nerds, an approachable intellectual property practice. Visit the live site.',
    h1: 'IP Law Nerds website case study.',
    file: 'work/ip-law-nerds.html',
    kind: 'work',
  },
  {
    path: '/about',
    title: 'About BBL Studio | Boutique Brand & Launch Studio',
    description:
      'BBL Studio is a premium website design studio in Orange County. Learn what the studio offers, who it serves, and how engagements work.',
    h1: 'A studio for websites that need to work.',
    file: 'about.html',
    kind: 'about',
    faqs: [
      {
        q: 'What is BBL Studio?',
        a: 'BBL Studio is the public name for BBL Boutique Brand & Launch Studio — a boutique website design studio in Orange County, California.',
      },
    ],
  },
  {
    path: '/contact',
    title: 'Contact BBL Studio | Website Design in Orange County',
    description:
      'Contact BBL Studio. Book a consultation, email hello@bbl.studio, or call (949) 524-2324. Orange County website design studio.',
    h1: 'Ready to build a more distinctive business?',
    file: 'contact.html',
    kind: 'contact',
  },
];

export function marketingPageByPath(path: string) {
  return MARKETING_PAGES.find((page) => page.path === path);
}

export function sitemapPaths() {
  return MARKETING_PAGES.map((page) => page.path);
}

export function absoluteUrl(path: string) {
  if (path === '/') return `${SITE_URL}/`;
  return `${SITE_URL}${path}`;
}

export { BOOK, EMAIL, PHONE, SITE_URL, STUDIO_NAME, projects, portfolioNote };
