export const SITE_URL = 'https://www.bbl.studio';
export const STUDIO_NAME = 'BBL Boutique Brand & Launch Studio';
export const STUDIO_SHORT = 'BBL';
export const STUDIO_LINE = 'Premium Website Design Studio in Orange County';
export const PRIMARY_DESCRIPTION =
  'BBL is a boutique website design studio serving Orange County businesses. We combine clear website strategy, premium visual direction, and launch ready execution to create websites that look distinctive and work with purpose.';
export const SUPPORTING_MESSAGE =
  'Distinctive websites designed to build credibility, generate inquiries, and support business growth.';
export const BRAND_STATEMENT = 'We don’t shape bodies. We build businesses.';
export const EMAIL = 'hello@bbl.studio';
export const EMAIL_HREF = 'mailto:hello@bbl.studio';
export const PHONE = '(949) 524-2324';
export const PHONE_HREF = 'tel:+19495242324';
export const ORG_ID = `${SITE_URL}/#organization`;

export const projects = [
  {
    slug: 'raysan-ip',
    path: '/work/raysan-ip',
    number: '01',
    name: 'Raysan IP',
    category: 'Strategy, Brand, Website',
    href: 'https://raysanip.com/',
    image: '/work/raysanip.webp',
    alt: 'Desktop screenshot of the Raysan IP homepage: dark editorial layout introducing a global intellectual property information platform',
    description: 'Brand and website for a global intellectual property information platform.',
    service: 'Commercial Website',
    servicePath: '/commercial-web-design',
  },
  {
    slug: '7-stud-farm',
    path: '/work/7-stud-farm',
    number: '02',
    name: '7 Stud Farm',
    category: 'Brand Direction, Website',
    href: 'https://7studfarm.com/',
    image: '/work/7studfarm.webp',
    alt: 'Desktop screenshot of the 7 Stud Farm homepage: large equestrian photography with restrained typography for an international breeding program',
    description: 'Brand direction and website for an international sport horse breeding program.',
    service: 'Business Website',
    servicePath: '/business-website-design',
  },
  {
    slug: 'ip-law-nerds',
    path: '/work/ip-law-nerds',
    number: '03',
    name: 'IP Law Nerds',
    category: 'Brand Expression, Website',
    href: 'https://www.iplawnerds.com/',
    image: '/work/iplawnerds.webp',
    alt: 'Desktop screenshot of the IP Law Nerds homepage: open, approachable layout with direct messaging for an intellectual property practice',
    description: 'Brand expression and website for an approachable intellectual property practice.',
    service: 'Business Website',
    servicePath: '/business-website-design',
  },
] as const;

export type PageSeo = {
  path: string;
  title: string;
  description: string;
  h1: string;
};

/** Keep in sync with lib/public-marketing.ts MARKETING_PAGES (avoids circular import). */
export const PUBLIC_PAGES: PageSeo[] = [
  {
    path: '/',
    title: 'Website Design in Orange County | BBL Studio',
    description:
      'BBL Studio is a boutique website design studio in Orange County. Custom landing pages, business websites, and commercial sites — strategy, design, and development in one studio.',
    h1: 'Website design in Orange County.',
  },
  {
    path: '/booking',
    title: 'Book a Consultation | BBL Studio',
    description:
      'Book a free BBL Studio consultation. Choose a date and time at least 48 hours ahead. Pacific Time.',
    h1: 'Book a time to talk.',
  },
  {
    path: '/orange-county-web-design',
    title: 'Orange County Web Design | BBL Studio',
    description:
      'Orange County web design by BBL Studio. Custom landing pages, business websites, and commercial sites for Irvine, Newport Beach, Costa Mesa, Laguna Beach, Tustin, and nearby cities.',
    h1: 'Orange County web design.',
  },
  {
    path: '/landing-page-design',
    title: 'Landing Page Design in Orange County | BBL Studio',
    description:
      'Landing page design by BBL Studio in Orange County. One focused page with a clear offer, inquiry path, and launch-ready structure. Custom quote after consultation.',
    h1: 'Landing page design in Orange County.',
  },
  {
    path: '/business-website-design',
    title: 'Small Business Website Design Orange County | BBL Studio',
    description:
      'Business website design in Orange County by BBL Studio. Multi-page custom sites built for credibility and inquiries. Custom quote after consultation.',
    h1: 'Business website design in Orange County.',
  },
  {
    path: '/commercial-web-design',
    title: 'Commercial Website Design Orange County | BBL Studio',
    description:
      'Commercial website design in Orange County by BBL Studio. Larger custom sites with stronger architecture and conversion-focused structure. Custom quote after consultation.',
    h1: 'Commercial website design in Orange County.',
  },
  {
    path: '/med-spa-website-design',
    title: 'Med Spa Website Design | BBL Studio',
    description:
      'Med spa website design by BBL Studio. Clear offers, credible presentation, and booking-ready inquiry paths for aesthetic and wellness practices in Orange County.',
    h1: 'Med spa website design.',
  },
  {
    path: '/salon-website-design',
    title: 'Salon Website Design | BBL Studio',
    description:
      'Salon website design by BBL Studio. Distinctive sites for hair, beauty, and wellness salons that need a polished first impression and clear next step.',
    h1: 'Salon website design.',
  },
  {
    path: '/booking-website-design',
    title: 'Booking Website Design | BBL Studio',
    description:
      'Booking-focused website design by BBL Studio. Sites structured so visitors can understand the offer and take the next scheduling step.',
    h1: 'Booking website design.',
  },
  {
    path: '/website-redesign',
    title: 'Website Redesign | BBL Studio',
    description:
      'Website redesign by BBL Studio. Replace an outdated or unclear site with a custom design that presents the offer clearly and supports inquiries.',
    h1: 'Website redesign.',
  },
  {
    path: '/ux-audit',
    title: 'UX Audit | BBL Studio',
    description:
      'UX audit by BBL Studio. A structured review of clarity, navigation, and conversion paths before a redesign or rebuild.',
    h1: 'UX audit.',
  },
  {
    path: '/healthcare-ux-design',
    title: 'Healthcare UX Design | BBL Studio',
    description:
      'Healthcare UX and website design by BBL Studio for practices that need clarity, trust, and a careful public presentation.',
    h1: 'Healthcare UX design.',
  },
  {
    path: '/work',
    title: 'Selected Website Design Work | BBL Studio',
    description:
      'Live BBL Studio website work: Raysan IP, 7 Stud Farm, and IP Law Nerds. Visit each site as it exists today.',
    h1: 'Work you can visit.',
  },
  {
    path: '/work/raysan-ip',
    title: 'Raysan IP Website Case Study | BBL Studio',
    description:
      'Case study: BBL Studio led strategy, brand, and commercial website design for Raysan IP, a global intellectual property information platform. Visit the live site.',
    h1: 'Raysan IP website case study.',
  },
  {
    path: '/work/7-stud-farm',
    title: '7 Stud Farm Website Case Study | BBL Studio',
    description:
      'Case study: BBL Studio created brand direction and a business website for 7 Stud Farm, an international sport horse breeding program. Visit the live site.',
    h1: '7 Stud Farm website case study.',
  },
  {
    path: '/work/ip-law-nerds',
    title: 'IP Law Nerds Website Case Study | BBL Studio',
    description:
      'Case study: BBL Studio designed brand expression and a business website for IP Law Nerds, an approachable intellectual property practice. Visit the live site.',
    h1: 'IP Law Nerds website case study.',
  },
  {
    path: '/about',
    title: 'About BBL Studio | Boutique Brand & Launch Studio',
    description:
      'BBL Studio is a premium website design studio in Orange County. Learn what the studio offers, who it serves, and how engagements work.',
    h1: 'A studio for websites that need to work.',
  },
  {
    path: '/contact',
    title: 'Contact BBL Studio | Website Design in Orange County',
    description:
      'Contact BBL Studio. Book a consultation, email hello@bbl.studio, or call (949) 524-2324. Orange County website design studio.',
    h1: 'Ready to build a more distinctive business?',
  },
];

export function pageByPath(path: string) {
  return PUBLIC_PAGES.find((page) => page.path === path);
}

export const HOME_FAQS = [
  {
    q: 'What is BBL Studio?',
    a: 'BBL Studio is a boutique website design studio serving businesses in Orange County, California.',
  },
  {
    q: 'What website services does BBL Studio offer?',
    a: 'BBL Studio designs custom landing pages, business websites, and commercial websites, with optional brand identity work when needed.',
  },
  {
    q: 'How much does a BBL Studio website cost?',
    a: 'BBL Studio provides a custom quote after consultation based on pages, functionality, and content readiness.',
  },
  {
    q: 'Does BBL Studio provide website design in Orange County?',
    a: 'Yes. BBL Studio provides custom website design services for businesses throughout Orange County.',
  },
] as const;

export function breadcrumbsFor(path: string) {
  const crumbs = [{ name: 'Home', path: '/' }];
  if (path === '/') return crumbs;
  if (path.startsWith('/work/')) {
    crumbs.push({ name: 'Work', path: '/work' });
    const project = projects.find((item) => item.path === path);
    crumbs.push({ name: project?.name || 'Project', path });
    return crumbs;
  }
  if (path.startsWith('/orange-county/')) {
    crumbs.push({ name: 'Orange County web design', path: '/orange-county-web-design' });
    const page = pageByPath(path);
    crumbs.push({ name: page?.h1.replace(/\.$/, '') || 'City', path });
    return crumbs;
  }
  const page = pageByPath(path);
  crumbs.push({ name: page?.h1.replace(/\.$/, '') || page?.title || 'Page', path });
  return crumbs;
}

export const CORE_FAQS = [
  ...HOME_FAQS,
  {
    q: 'What is included in a BBL Studio website project?',
    a: 'A BBL Studio website project includes custom page design, responsive layouts, forms, basic on-page SEO, analytics, launch support, and a defined number of revision rounds. Scope is confirmed in writing before work begins.',
  },
  {
    q: 'Does BBL Studio design landing pages?',
    a: 'Yes. Landing page engagements cover one focused page designed to present an offer clearly and guide visitors toward the next action. Scope and pricing are confirmed after consultation.',
  },
  {
    q: 'Does BBL Studio build commercial websites?',
    a: 'Yes. Business and commercial website engagements are available for companies that need multi-page sites with stronger architecture and conversion-focused functionality.',
  },
  {
    q: 'Does BBL Studio provide branding with website design?',
    a: 'Brand Identity is an optional add-on. When the website needs a stronger visual foundation, BBL Studio can create a focused identity system covering logo, color, typography, and visual direction.',
  },
  {
    q: 'How long does a website project take?',
    a: '[OWNER REVIEW] Timeline depends on scope, content readiness, and feedback. Exact ranges are confirmed in writing after consultation.',
  },
] as const;
