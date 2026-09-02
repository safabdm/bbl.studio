export type StudioOffer = {
  id: string;
  number: string;
  name: string;
  label: string;
  cents: number;
  monthly: boolean;
  featured?: boolean;
  badge?: string;
  addon?: boolean;
  lede: string;
  features: string[];
  description: string;
};

export const PROJECT_OFFERS: StudioOffer[] = [
  {
    id: 'pkg_landing',
    number: '01',
    name: 'Simple Landing Page',
    label: 'Starting at $3,000',
    cents: 300000,
    monthly: false,
    lede: 'A focused page for one clear offer.',
    features: [
      'One custom page',
      'Responsive design',
      'Lead form and analytics',
      'SEO and launch setup',
    ],
    description: 'Simple Landing Page starts at $3,000. It includes one custom landing page, responsive design, a clear call to action, a contact or lead form, basic on page SEO, analytics, launch support, and up to two revision rounds.',
  },
  {
    id: 'pkg_business',
    number: '02',
    name: 'Business Website',
    label: 'Starting at $5,500',
    cents: 550000,
    monthly: false,
    lede: 'A complete website built for credibility and inquiries.',
    features: [
      'Up to five custom pages',
      'Strategy and navigation',
      'Forms and CMS setup',
      'SEO, analytics, and launch',
    ],
    description: 'Business Website starts at $5,500. It includes up to five custom pages, responsive design, clear navigation, forms, basic CMS setup where appropriate, basic on page SEO, analytics, launch support, and up to two revision rounds.',
  },
  {
    id: 'pkg_commercial',
    number: '03',
    name: 'Commercial Website',
    label: 'Starting at $8,500',
    cents: 850000,
    monthly: false,
    featured: true,
    badge: 'SIGNATURE',
    lede: 'A larger website for complex content and customer journeys.',
    features: [
      'Six to ten custom pages',
      'Custom UX and architecture',
      'Advanced forms and integrations',
      'SEO, tracking, and launch',
    ],
    description: 'Commercial Website starts at $8,500. It includes six to ten custom pages, custom UX and architecture, conversion focused layouts, advanced forms or integrations, CMS setup where appropriate, on page SEO, analytics and conversion tracking, launch support, and up to three revision rounds.',
  },
  {
    id: 'pkg_brand',
    number: '04',
    name: 'Brand Identity Add On',
    label: 'Starting at $3,500',
    cents: 350000,
    monthly: false,
    addon: true,
    lede: 'Logo, color, typography, and visual direction.',
    features: [
      'Logo system',
      'Color palette',
      'Typography system',
      'Core visual direction',
      'Basic brand guidelines',
    ],
    description: 'Brand Identity is an optional website add on starting at $3,500. It may include a logo system, color palette, typography system, core visual direction, and basic brand guidelines. It is not a separate primary package.',
  },
];

export const PUBLIC_PROJECT_OFFERS = PROJECT_OFFERS.filter((item) => !item.addon);
export const BRAND_ADDON = PROJECT_OFFERS.find((item) => item.id === 'pkg_brand')!;

export const PRICE_DISCLAIMER =
  'Final pricing depends on scope, content, and functionality. Platform costs are separate.';

export const PROJECT_OVERVIEW =
  'Planning estimates: Simple Landing Page starting at $3,000. Business Website starting at $5,500. Commercial Website starting at $8,500. Optional Brand Identity add on starting at $3,500.';

export const CUSTOM_SCOPE =
  'Custom scope and pricing available after consultation for ecommerce, booking systems, memberships, multilingual websites, client portals, advanced integrations, or projects larger than ten pages.';
