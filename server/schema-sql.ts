export const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS admin_users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  company_name TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  email TEXT NOT NULL,
  title TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS packages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  starting_price_cents INTEGER NOT NULL,
  description TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  package_id TEXT,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  description TEXT NOT NULL,
  pages INTEGER,
  revisions_included INTEGER NOT NULL DEFAULT 2,
  timeline TEXT,
  client_responsibilities TEXT,
  bbls_responsibilities TEXT,
  price_cents INTEGER NOT NULL,
  third_party_costs TEXT,
  payment_plan_kind TEXT NOT NULL DEFAULT 'choice',
  proposal_expires_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (client_id) REFERENCES clients(id)
);

CREATE TABLE IF NOT EXISTS portal_access_tokens (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  require_verification INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS verification_codes (
  id TEXT PRIMARY KEY,
  token_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  token_id TEXT,
  session_hash TEXT UNIQUE NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS line_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  label TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  kind TEXT NOT NULL,
  selected INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS deliverables (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS agreement_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  body_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  legal_status TEXT NOT NULL DEFAULT 'template_requires_attorney_review',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agreement_acceptances (
  id TEXT PRIMARY KEY,
  agreement_version_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  typed_name TEXT NOT NULL,
  title TEXT,
  company TEXT NOT NULL,
  signature_data TEXT NOT NULL,
  portfolio_permission TEXT NOT NULL,
  consents_json TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  audit_event_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  pdf_path TEXT
);

CREATE TABLE IF NOT EXISTS payment_plans (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  refund_language TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS installments (
  id TEXT PRIMARY KEY,
  payment_plan_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  milestone TEXT NOT NULL,
  due_at TEXT,
  status TEXT NOT NULL,
  stripe_checkout_id TEXT,
  checkout_expires_at TEXT,
  paid_at TEXT
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  installment_id TEXT,
  stripe_payment_intent TEXT,
  stripe_checkout_id TEXT,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  receipt_url TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  processed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS previews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  file_path TEXT,
  website_path TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  preview_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  body TEXT NOT NULL,
  attachment_path TEXT,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  preview_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  typed_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS file_releases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  deliverable_id TEXT,
  file_path TEXT NOT NULL,
  label TEXT NOT NULL,
  released_at TEXT,
  released_by TEXT
);

CREATE TABLE IF NOT EXISTS download_tokens (
  id TEXT PRIMARY KEY,
  file_release_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS download_events (
  id TEXT PRIMARY KEY,
  file_release_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  downloaded_at TEXT NOT NULL,
  ip_address TEXT
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  meta_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS email_log (
  id TEXT PRIMARY KEY,
  template TEXT NOT NULL,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proposal_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS change_orders (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  additional_cents INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  accepted_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);
`;
