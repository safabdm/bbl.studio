/**
 * Google Places API (New) Text Search client.
 * Fail closed when GOOGLE_PLACES_API_KEY is missing — never invent places.
 */
import {
  DISCOVERY_CATEGORY_QUERIES,
  DISCOVERY_PRIORITY_CITIES,
} from './crm-discovery-types.js';

export type PlacesEnv = {
  GOOGLE_PLACES_API_KEY?: string;
  DISCOVERY_ENABLED?: string;
  DISCOVERY_MAX_PER_RUN?: string;
};

export type PlacesCandidate = {
  place_id: string;
  business_name: string;
  website: string | null;
  phone: string | null;
  city: string | null;
  category: string | null;
  source_url: string | null;
  maps_uri: string | null;
  types: string[];
  rating: number | null;
  user_rating_count: number | null;
  raw_query: string;
};

function truthy(value: string | undefined) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function falsy(value: string | undefined) {
  return ['0', 'false', 'no', 'off'].includes(String(value || '').trim().toLowerCase());
}

export function placesApiKey(env: PlacesEnv = process.env): string {
  return String(env.GOOGLE_PLACES_API_KEY || '').trim();
}

export function isPlacesConfigured(env: PlacesEnv = process.env): boolean {
  return Boolean(placesApiKey(env));
}

/** Master switch: off when DISCOVERY_ENABLED explicitly false; otherwise on only if Places key exists. */
export function isDiscoveryEnabled(env: PlacesEnv = process.env): boolean {
  if (falsy(env.DISCOVERY_ENABLED)) return false;
  if (env.DISCOVERY_ENABLED !== undefined && env.DISCOVERY_ENABLED !== '' && !truthy(env.DISCOVERY_ENABLED)) {
    return false;
  }
  return isPlacesConfigured(env);
}

export function maxPerRun(env: PlacesEnv = process.env): number {
  const n = Number.parseInt(String(env.DISCOVERY_MAX_PER_RUN || '8'), 10);
  if (!Number.isFinite(n) || n < 1) return 8;
  return Math.min(n, 40);
}

export function buildSearchQueries(opts: {
  cities?: readonly string[];
  categories?: readonly string[];
  cityLimit?: number;
  categoryLimit?: number;
} = {}): Array<{ city: string; category: string; textQuery: string }> {
  const cities = (opts.cities || DISCOVERY_PRIORITY_CITIES).slice(0, opts.cityLimit ?? 3);
  const categories = (opts.categories || DISCOVERY_CATEGORY_QUERIES).slice(0, opts.categoryLimit ?? 2);
  const out: Array<{ city: string; category: string; textQuery: string }> = [];
  for (const city of cities) {
    for (const category of categories) {
      out.push({ city, category, textQuery: `${category} in ${city}` });
    }
  }
  return out;
}

type PlacesTextSearchResponse = {
  places?: Array<{
    id?: string;
    name?: string;
    displayName?: { text?: string };
    websiteUri?: string;
    nationalPhoneNumber?: string;
    internationalPhoneNumber?: string;
    googleMapsUri?: string;
    types?: string[];
    primaryType?: string;
    primaryTypeDisplayName?: { text?: string };
    rating?: number;
    userRatingCount?: number;
    formattedAddress?: string;
    addressComponents?: Array<{ longText?: string; shortText?: string; types?: string[] }>;
  }>;
  error?: { message?: string; status?: string };
};

type AddressComponent = { longText?: string; shortText?: string; types?: string[] };

function cityFromAddress(
  formatted: string | undefined,
  components?: AddressComponent[] | null,
): string | null {
  if (Array.isArray(components)) {
    const locality = components.find((c) => c.types?.includes('locality'));
    if (locality?.longText) return locality.longText;
  }
  if (!formatted) return null;
  // "123 Main St, Irvine, CA 92618, USA"
  const parts = formatted.split(',').map((p) => p.trim());
  if (parts.length >= 3) return parts[parts.length - 3] || null;
  return null;
}

export async function searchPlacesText(
  textQuery: string,
  opts: { maxResultCount?: number; env?: PlacesEnv; fetchImpl?: typeof fetch } = {},
): Promise<{ ok: true; candidates: PlacesCandidate[] } | { ok: false; message: string; fail_closed: true }> {
  const env = opts.env || process.env;
  const key = placesApiKey(env);
  if (!key) {
    return {
      ok: false,
      fail_closed: true,
      message: 'GOOGLE_PLACES_API_KEY is not configured. Discovery fails closed — no fabricated leads.',
    };
  }

  const fetchImpl = opts.fetchImpl || fetch;
  const maxResultCount = Math.min(Math.max(opts.maxResultCount ?? 5, 1), 20);

  let response: Response;
  try {
    response = await fetchImpl('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask':
          'places.id,places.displayName,places.websiteUri,places.nationalPhoneNumber,places.internationalPhoneNumber,places.googleMapsUri,places.types,places.primaryType,places.primaryTypeDisplayName,places.rating,places.userRatingCount,places.formattedAddress,places.addressComponents',
      },
      body: JSON.stringify({
        textQuery,
        maxResultCount,
        languageCode: 'en',
        regionCode: 'US',
      }),
    });
  } catch (err) {
    return {
      ok: false,
      fail_closed: true,
      message: `Places request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const raw = (await response.json().catch(() => ({}))) as PlacesTextSearchResponse;
  if (!response.ok) {
    return {
      ok: false,
      fail_closed: true,
      message: `Places API ${response.status}: ${raw.error?.message || response.statusText || 'error'}`,
    };
  }

  const candidates: PlacesCandidate[] = [];
  for (const place of raw.places || []) {
    const placeId = String(place.id || '').trim();
    const name = String(place.displayName?.text || '').trim();
    if (!placeId || !name) continue;
    const website = place.websiteUri ? String(place.websiteUri).trim() : null;
    const phone = String(place.nationalPhoneNumber || place.internationalPhoneNumber || '').trim() || null;
    const category =
      place.primaryTypeDisplayName?.text ||
      place.primaryType ||
      (place.types && place.types[0]) ||
      null;
    candidates.push({
      place_id: placeId.startsWith('places/') ? placeId.slice('places/'.length) : placeId,
      business_name: name,
      website,
      phone,
      city: cityFromAddress(place.formattedAddress, place.addressComponents),
      category: category ? String(category) : null,
      source_url: place.googleMapsUri || null,
      maps_uri: place.googleMapsUri || null,
      types: Array.isArray(place.types) ? place.types : [],
      rating: typeof place.rating === 'number' ? place.rating : null,
      user_rating_count: typeof place.userRatingCount === 'number' ? place.userRatingCount : null,
      raw_query: textQuery,
    });
  }

  return { ok: true, candidates };
}
