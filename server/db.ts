import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env';
import { SCHEMA_SQL } from './schema-sql';

loadEnv();

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const onVercel = Boolean(process.env.VERCEL);

export const paths = {
  root,
  db: process.env.PORTAL_DB_PATH
    ? resolve(process.env.PORTAL_DB_PATH)
    : onVercel
      ? '/tmp/bbls-portal.db'
      : resolve(root, 'data/portal.db'),
  uploads: process.env.PORTAL_UPLOAD_DIR
    ? resolve(process.env.PORTAL_UPLOAD_DIR)
    : onVercel
      ? '/tmp/bbls-uploads'
      : resolve(root, 'data/uploads'),
  schema: resolve(root, 'server/schema.sql'),
};

mkdirSync(dirname(onVercel ? '/tmp/bbls-portal.db' : paths.db), { recursive: true });
mkdirSync(paths.uploads, { recursive: true });

let instance: DatabaseSync | undefined;

function openDb() {
  if (instance) return instance;
  instance = new DatabaseSync(onVercel ? ':memory:' : paths.db);
  try {
    instance.exec('PRAGMA journal_mode = WAL');
  } catch {
    instance.exec('PRAGMA journal_mode = DELETE');
  }
  instance.exec('PRAGMA foreign_keys = ON');
  return instance;
}

export const db = {
  exec(sql: string) {
    return openDb().exec(sql);
  },
  prepare(sql: string) {
    return openDb().prepare(sql);
  },
  close() {
    instance?.close();
    instance = undefined;
  },
};

export function row<T>(sql: string, params: unknown[] = []) {
  const result = db.prepare(sql).get(...(params as never[])) as T | undefined;
  return result ?? undefined;
}

export function rows<T>(sql: string, params: unknown[] = []) {
  return db.prepare(sql).all(...(params as never[])) as T[];
}

export function run(sql: string, params: unknown[] = []) {
  return db.prepare(sql).run(...(params as never[]));
}

function columnNames(table: string) {
  return rows<{ name: string }>(`PRAGMA table_info(${table})`).map((item) => item.name);
}

function ensureColumn(table: string, name: string, definition: string) {
  if (!columnNames(table).includes(name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

export function migrate() {
  db.exec(existsSync(paths.schema) ? readFileSync(paths.schema, 'utf8') : SCHEMA_SQL);
  ensureColumn('projects', 'currency', "TEXT NOT NULL DEFAULT 'USD'");
  ensureColumn('projects', 'discount_cents', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('projects', 'tax_cents', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('projects', 'additional_services_cents', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('projects', 'third_party_cents', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('projects', 'deposit_cents', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('projects', 'remaining_balance_cents', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('projects', 'deposit_percent', 'INTEGER');
  ensureColumn('projects', 'deposit_mode', "TEXT NOT NULL DEFAULT 'percent'");
  ensureColumn('projects', 'payment_option', "TEXT NOT NULL DEFAULT 'two'");
  ensureColumn('projects', 'client_pricing_notes', 'TEXT');
  ensureColumn('projects', 'internal_notes', 'TEXT');
  ensureColumn('projects', 'proposal_status', "TEXT NOT NULL DEFAULT 'draft'");
  ensureColumn('projects', 'current_proposal_version', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('projects', 'signed_proposal_version', 'INTEGER');
  ensureColumn('portal_access_tokens', 'token_cipher', 'TEXT');
  ensureColumn('portal_access_tokens', 'last4', 'TEXT');
  ensureColumn('installments', 'name', 'TEXT');
  ensureColumn('installments', 'percent', 'REAL');
  ensureColumn('packages', 'monthly', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('packages', 'price_label', 'TEXT');
  ensureColumn('packages', 'deliverables_json', 'TEXT');
}
