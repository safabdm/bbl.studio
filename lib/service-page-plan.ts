/**
 * Contract for the next SEO pull request.
 * These paths stay unpublished and must return 404 until real HTML exists.
 * Do not add them to the sitemap or to a rewrite.
 */

export const UNPUBLISHED_SERVICE_PATHS = [
  '/business-website-design',
  '/landing-page-design',
  '/commercial-web-design',
] as const;

export const SERVICE_PAGE_REQUIREMENTS = [
  'Server-delivered HTML',
  'Unique title',
  'Unique meta description',
  'Unique H1',
  'Self-referencing canonical',
  'Published starting price',
  'Internal links',
  'Booking CTA',
  'Contact CTA',
  'Service structured data',
] as const;
