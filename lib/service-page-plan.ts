/**
 * City doorway URLs stay unpublished as standalone pages — they 301 to the OC hub.
 * Buyer/service pages are published via prerender (see lib/public-marketing.ts).
 */

export const CITY_DOORWAY_PATHS = [
  '/orange-county/irvine-web-design',
  '/orange-county/newport-beach-web-design',
  '/orange-county/costa-mesa-web-design',
  '/orange-county/laguna-beach-web-design',
  '/orange-county/tustin-web-design',
] as const;

/** @deprecated Use CITY_DOORWAY_PATHS — service pages are now published. */
export const UNPUBLISHED_SERVICE_PATHS = [] as const;

export const SERVICE_PAGE_REQUIREMENTS = [
  'Server-delivered HTML',
  'Unique title',
  'Unique meta description',
  'Unique H1',
  'Self-referencing canonical',
  'Internal links',
  'Booking CTA',
  'Contact CTA',
  'Service structured data',
] as const;
