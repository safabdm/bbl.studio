import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function id(prefix = '') {
  return `${prefix}${randomBytes(12).toString('hex')}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string) {
  const [scheme, salt, hash] = stored.split(':');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const next = scryptSync(password, salt, 64);
  const prev = Buffer.from(hash, 'hex');
  return prev.length === next.length && timingSafeEqual(prev, next);
}

export function hashEquals(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function cents(amount: number) {
  return Math.round(amount);
}

export function dollars(centsValue: number) {
  return (centsValue / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function clientIp(header: string | undefined, fallback = '127.0.0.1') {
  return (header?.split(',')[0] || fallback).trim();
}

export function cookieValue(header: string | undefined, name: string) {
  if (!header) return '';
  const match = header.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : '';
}

function secretKey() {
  return createHash('sha256').update(process.env.SESSION_SECRET || 'bbls-local-dev-secret').digest();
}

export function encryptSecret(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}.${cipher.getAuthTag().toString('hex')}.${encrypted.toString('hex')}`;
}

export function decryptSecret(payload: string | null | undefined) {
  if (!payload) return null;
  const [ivHex, tagHex, dataHex] = payload.split('.');
  if (!ivHex || !tagHex || !dataHex) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
