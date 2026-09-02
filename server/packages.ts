import { PROJECT_OFFERS } from '../lib/offers';

export type PaymentOption = 'full' | 'two' | 'three' | 'custom';

export type PackagePreset = {
  id: string;
  name: string;
  starting_price_cents: number;
  price_label: string;
  monthly: boolean;
  description: string;
  deliverables: string[];
};

export const PACKAGE_PRESETS: PackagePreset[] = [
  ...PROJECT_OFFERS.map((offer) => ({
    id: offer.id,
    name: offer.name,
    starting_price_cents: offer.cents,
    price_label: offer.label,
    monthly: offer.monthly,
    description: offer.lede,
    deliverables: [...offer.features],
  })),
  {
    id: 'pkg_custom',
    name: 'Custom Project',
    starting_price_cents: 0,
    price_label: 'Manually entered price',
    monthly: false,
    description: 'Scoped around the work the business actually needs. Enter price and deliverables before publishing.',
    deliverables: [],
  },
];

export function presetById(id: string | null | undefined) {
  return PACKAGE_PRESETS.find((item) => item.id === id) || null;
}
