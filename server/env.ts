import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function loadEnv() {
  const file = resolve(root, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnv();

export function appOrigin() {
  return (process.env.APP_ORIGIN || (process.env.VERCEL ? 'https://bbls.studio' : 'http://127.0.0.1:4173')).replace(/\/$/, '');
}

export function clientPortalUrl(token: string) {
  return `${appOrigin()}/client/${token}`;
}

export function publicClientUrl(token: string) {
  return `https://bbls.studio/client/${token}`;
}
