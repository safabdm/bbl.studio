import { PUBLIC_PROJECT_OFFERS } from './offers';
import { CORE_FAQS, EMAIL, ORG_ID, PHONE, PRIMARY_DESCRIPTION, SITE_URL, STUDIO_NAME, projects, type PageSeo } from './site';

export function organizationNode() {
  return {
    '@type': ['Organization', 'ProfessionalService'],
    '@id': ORG_ID,
    name: STUDIO_NAME,
    alternateName: ['BBLS', 'Boutique Brand & Launch Studio'],
    url: `${SITE_URL}/`,
    image: `${SITE_URL}/og.png`,
    logo: `${SITE_URL}/apple-touch-icon.png`,
    description: PRIMARY_DESCRIPTION,
    email: EMAIL,
    telephone: '+1-949-524-2324',
    areaServed: [
      { '@type': 'AdministrativeArea', name: 'Orange County' },
      { '@type': 'City', name: 'Irvine' },
      { '@type': 'City', name: 'Newport Beach' },
      { '@type': 'City', name: 'Costa Mesa' },
      { '@type': 'City', name: 'Laguna Beach' },
      { '@type': 'City', name: 'Tustin' },
      { '@type': 'State', name: 'California' },
    ],
    serviceType: [
      'Website design',
      'Landing page design',
      'Business website design',
      'Commercial website design',
      'Brand identity',
    ],
    knowsAbout: [
      'Website design in Orange County',
      'Landing page design',
      'Commercial website design',
      'Brand identity',
    ],
    hasOfferCatalog: {
      '@type': 'OfferCatalog',
      name: 'BBLS website engagements',
      itemListElement: PUBLIC_PROJECT_OFFERS.map((offer) => ({
        '@type': 'Offer',
        priceCurrency: 'USD',
        ...(offer.cents > 0
          ? {
              price: String(offer.cents / 100),
              priceSpecification: { '@type': 'PriceSpecification', priceCurrency: 'USD', minPrice: String(offer.cents / 100), description: 'Starting price' },
            }
          : {}),
        itemOffered: { '@type': 'Service', name: offer.name, description: offer.description },
      })),
    },
  };
}

export function websiteNode() {
  return {
    '@type': 'WebSite',
    '@id': `${SITE_URL}/#website`,
    url: `${SITE_URL}/`,
    name: 'BBLS',
    publisher: { '@id': ORG_ID },
    inLanguage: 'en-US',
  };
}

export function webpageNode(page: PageSeo) {
  return {
    '@type': 'WebPage',
    '@id': `${SITE_URL}${page.path === '/' ? '/' : page.path}#webpage`,
    url: `${SITE_URL}${page.path}`,
    name: page.title,
    description: page.description,
    isPartOf: { '@id': `${SITE_URL}/#website` },
    about: { '@id': ORG_ID },
    inLanguage: 'en-US',
  };
}

export function breadcrumbNode(items: { name: string; path: string }[]) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: `${SITE_URL}${item.path}`,
    })),
  };
}

export function faqNode(faqs: { q: string; a: string }[] = [...CORE_FAQS]) {
  return {
    '@type': 'FAQPage',
    mainEntity: faqs.map((item) => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: item.a },
    })),
  };
}

export function serviceNode(name: string, path: string, description: string) {
  return {
    '@type': 'Service',
    name,
    url: `${SITE_URL}${path}`,
    description,
    provider: { '@id': ORG_ID },
    areaServed: { '@type': 'AdministrativeArea', name: 'Orange County' },
  };
}

export function creativeWorkNode(name: string, path: string, description: string, image: string) {
  return {
    '@type': 'CreativeWork',
    name,
    url: `${SITE_URL}${path}`,
    description,
    image: `${SITE_URL}${image}`,
    creator: { '@id': ORG_ID },
  };
}

export function graph(nodes: Record<string, unknown>[]) {
  return {
    '@context': 'https://schema.org',
    '@graph': [organizationNode(), websiteNode(), ...nodes],
  };
}

export { PHONE, projects };
