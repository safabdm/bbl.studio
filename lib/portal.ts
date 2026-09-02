export async function api<T = Record<string, unknown>>(path: string, init: RequestInit = {}) {
  const response = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    ...init,
  });
  const data = await response.json().catch(() => ({})) as T & { ok?: boolean; message?: string };
  if (!response.ok) {
    throw new Error(data.message || `Request failed (${response.status}).`);
  }
  return data;
}

export function money(cents?: number | null, currency = 'USD') {
  return ((cents || 0) / 100).toLocaleString('en-US', { style: 'currency', currency });
}

export function usePrivateIndexing(title: string) {
  if (typeof document === 'undefined') return;
  document.title = title;
  for (const name of ['robots', 'googlebot']) {
    document.querySelector(`meta[name="${name}"]`)?.setAttribute('content', 'noindex, nofollow');
  }
}
