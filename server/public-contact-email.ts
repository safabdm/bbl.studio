/** Syntax screening only; never a claim that a mailbox exists or accepts mail. */
export function isPublicContactEmail(value: string): boolean {
  const email = value.trim().toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(email)) return false;
  const [local, host] = email.split('@');
  if (local.startsWith('.') || local.endsWith('.') || email.includes('..')) return false;
  if (host.split('.').some(label => label.startsWith('-') || label.endsWith('-'))) return false;
  if (/\.(?:webp|png|jpe?g|svg|gif|avif|ico|css|js|woff2?|ttf|mp4|pdf)$/i.test(host)) return false;
  return !/(?:^|\.)(?:example\.com|domain\.com|email\.com|sentry\.io|wixpress\.com|googleapis\.com|schema\.org)$/i.test(host);
}
