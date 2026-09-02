export const SITE_URL = 'https://bbls.studio';
export const STUDIO_NAME = 'BBLS Boutique Brand & Launch Studio';
export const STUDIO_SHORT = 'BBLS';
export const STUDIO_LINE = 'Premium Website Design Studio in Orange County';
export const PRIMARY_DESCRIPTION =
  'BBLS is a boutique website design studio serving Orange County businesses. We combine clear website strategy, premium visual direction, and launch ready execution to create websites that look distinctive and work with purpose.';
export const SUPPORTING_MESSAGE =
  'Distinctive websites designed to build credibility, generate inquiries, and support business growth.';
export const BRAND_STATEMENT = 'We don’t shape bodies. We build businesses.';
export const EMAIL = 'hello@bbls.studio';
export const EMAIL_HREF = 'mailto:hello@bbls.studio';
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
    alt: 'Raysan IP website homepage on a dark editorial layout',
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
    alt: '7 Stud Farm website homepage with equestrian photography',
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
    alt: 'IP Law Nerds website homepage with a direct, approachable layout',
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

export const PUBLIC_PAGES: PageSeo[] = [
  {
    path: '/',
    title: 'Website Design in Orange County | BBLS Studio',
    description: 'BBLS is a boutique website design studio serving Orange County businesses. Distinctive websites designed to build credibility, generate inquiries, and support business growth.',
    h1: 'Website design in Orange County.',
  },
  {
    path: '/orange-county-web-design',
    title: 'Orange County Web Design | BBLS Studio',
    description: 'Orange County web design by BBLS. Distinctive landing pages, business websites, and commercial sites planned to launch, convert, and grow.',
    h1: 'Orange County web design.',
  },
  {
    path: '/landing-page-design',
    title: 'Landing Page Design in Orange County | BBLS',
    description: 'Landing page design in Orange County starting at $3,000. One focused page with a clear offer, form, and launch ready structure.',
    h1: 'Landing page design in Orange County.',
  },
  {
    path: '/business-website-design',
    title: 'Small Business Website Design Orange County | BBLS',
    description: 'Business website design in Orange County starting at $5,500. Up to five custom pages for a credible site that takes inquiries.',
    h1: 'Business website design in Orange County.',
  },
  {
    path: '/commercial-web-design',
    title: 'Commercial Website Design Orange County | BBLS',
    description: 'Commercial website design in Orange County starting at $8,500. Six to ten custom pages with conversion focused structure and tracking.',
    h1: 'Commercial website design in Orange County.',
  },
  {
    path: '/work',
    title: 'Selected Website Design Work | BBLS Studio',
    description: 'Live BBLS website work: Raysan IP, 7 Stud Farm, and IP Law Nerds. Visit each site as it exists today.',
    h1: 'Work you can visit.',
  },
  {
    path: '/work/raysan-ip',
    title: 'Raysan IP Website Case Study | BBLS',
    description: 'BBLS designed the Raysan IP brand and website for a global intellectual property information platform. Review the live site and the studio approach.',
    h1: 'Raysan IP.',
  },
  {
    path: '/work/7-stud-farm',
    title: '7 Stud Farm Website Case Study | BBLS',
    description: 'BBLS created brand direction and a website for 7 Stud Farm, an international sport horse breeding program.',
    h1: '7 Stud Farm.',
  },
  {
    path: '/work/ip-law-nerds',
    title: 'IP Law Nerds Website Case Study | BBLS',
    description: 'BBLS designed brand expression and a website for IP Law Nerds, an approachable intellectual property practice.',
    h1: 'IP Law Nerds.',
  },
  {
    path: '/about',
    title: 'About BBLS | Boutique Brand & Launch Studio',
    description: 'BBLS is a premium website design studio in Orange County. Learn what the studio offers, who it serves, and how engagements work.',
    h1: 'A studio for websites that need to work.',
  },
  {
    path: '/contact',
    title: 'Contact BBLS | Website Design in Orange County',
    description: 'Start a BBLS website project. Email hello@bbls.studio or call (949) 524-2324. Orange County website design studio.',
    h1: 'Ready to build a more distinctive business?',
  },
  {
    path: '/orange-county/irvine-web-design',
    title: 'Irvine Web Design | BBLS Orange County',
    description: 'Website design for Irvine businesses. BBLS plans landing pages and commercial sites for professional, medical, and growth-focused companies.',
    h1: 'Irvine web design.',
  },
  {
    path: '/orange-county/newport-beach-web-design',
    title: 'Newport Beach Web Design | BBLS Orange County',
    description: 'Website design for Newport Beach businesses. BBLS builds polished sites for hospitality, professional services, and coastal brands.',
    h1: 'Newport Beach web design.',
  },
  {
    path: '/orange-county/costa-mesa-web-design',
    title: 'Costa Mesa Web Design | BBLS Orange County',
    description: 'Website design for Costa Mesa businesses. BBLS designs commercial sites for retail, restaurants, and creative companies near South Coast Plaza.',
    h1: 'Costa Mesa web design.',
  },
  {
    path: '/orange-county/laguna-beach-web-design',
    title: 'Laguna Beach Web Design | BBLS Orange County',
    description: 'Website design for Laguna Beach businesses. BBLS creates distinctive sites for galleries, hospitality, and boutique coastal brands.',
    h1: 'Laguna Beach web design.',
  },
  {
    path: '/orange-county/tustin-web-design',
    title: 'Tustin Web Design | BBLS Orange County',
    description: 'Website design for Tustin businesses. BBLS builds clear, credible sites for local services, trades, and growing family companies.',
    h1: 'Tustin web design.',
  },
];

export function pageByPath(path: string) {
  return PUBLIC_PAGES.find((page) => page.path === path);
}

export const HOME_FAQS = [
  {
    q: 'What is BBLS?',
    a: 'BBLS is a boutique website design studio serving businesses in Orange County, California.',
  },
  {
    q: 'What website services does BBLS offer?',
    a: 'BBLS offers Simple Landing Pages, Business Websites, Commercial Websites, and optional Brand Identity services.',
  },
  {
    q: 'How much does a BBLS website cost?',
    a: 'BBLS landing pages start at $3,000, business websites start at $5,500, and commercial websites start at $8,500. Final pricing depends on project scope and functionality.',
  },
  {
    q: 'Does BBLS provide website design in Orange County?',
    a: 'Yes. BBLS provides premium website design services for businesses throughout Orange County.',
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
    q: 'What is included in a BBLS website project?',
    a: 'A BBLS website project includes custom page design, responsive layouts, forms, basic on page SEO, analytics, launch support, and a defined number of revision rounds. Scope is confirmed in writing before work begins.',
  },
  {
    q: 'Does BBLS design landing pages?',
    a: 'Yes. The Simple Landing Page engagement starts at $3,000 and covers one focused page designed to present an offer clearly and guide visitors toward the next action.',
  },
  {
    q: 'Does BBLS build commercial websites?',
    a: 'Yes. Business Website starts at $5,500. Commercial Website starts at $8,500 for businesses that need stronger content architecture, customer journeys, and conversion focused functionality.',
  },
  {
    q: 'Does BBLS provide branding with website design?',
    a: 'Brand Identity is an optional add on starting at $3,500. When the website needs a stronger visual foundation, BBLS can create a focused identity system covering logo, color, typography, and visual direction.',
  },
  {
    q: 'How long does a website project take?',
    a: 'Focused landing page launches may finish in 14 days when scope, content, and approvals are ready. Broader website work typically takes two to four weeks. Larger or custom work is scheduled after the scope is confirmed.',
  },
] as const;
