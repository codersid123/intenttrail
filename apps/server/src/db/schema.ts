export const SCHEMA = `
CREATE TABLE IF NOT EXISTS principals (
  id TEXT PRIMARY KEY,            -- 'user:priya', 'agent:hotel', 'merchant:goa-stays'
  kind TEXT NOT NULL,             -- 'user' | 'agent' | 'merchant'
  public_jwk TEXT NOT NULL,
  private_jwk TEXT NOT NULL       -- demo only (see threat model)
);

CREATE TABLE IF NOT EXISTS mandates (
  mid TEXT PRIMARY KEY,
  parent_mid TEXT REFERENCES mandates(mid),
  run_id TEXT NOT NULL,
  iss TEXT NOT NULL,
  sub TEXT NOT NULL,
  jws TEXT NOT NULL,
  max_amount REAL NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS budget_ledger (
  id TEXT PRIMARY KEY,
  mid TEXT NOT NULL REFERENCES mandates(mid),
  kind TEXT NOT NULL,             -- 'carve_out' | 'spend'
  amount REAL NOT NULL,
  status TEXT NOT NULL,           -- 'reserved' | 'committed' | 'released'
  ref TEXT,                       -- child mid or PayPal authorization id
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  mid TEXT NOT NULL REFERENCES mandates(mid),
  cart_id TEXT NOT NULL UNIQUE,
  merchant_id TEXT NOT NULL,
  signed_cart_jws TEXT NOT NULL,
  paypal_order_id TEXT,
  paypal_authorization_id TEXT,
  paypal_capture_id TEXT,
  captured_amount REAL,
  is_mock INTEGER DEFAULT 0,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provenance (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  ts INTEGER NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS disputes (
  id TEXT PRIMARY KEY,
  transaction_id TEXT REFERENCES transactions(id),
  reason TEXT,
  verdict TEXT,
  findings TEXT,
  explanation TEXT,
  action_taken TEXT,
  is_mock INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  scenario TEXT NOT NULL,         -- 'A' | 'B' | 'C' | 'D'
  payment_mode TEXT NOT NULL,     -- provider label, e.g. 'PayPal sandbox (vaulted wallet)'
  fault_injection TEXT,           -- JSON, null for honest runs (kept OUT of the provenance log on purpose)
  status TEXT NOT NULL,           -- 'running' | 'awaiting_approval' | 'completed' | 'failed'
  approve_url TEXT,
  result TEXT,                    -- JSON summary
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ledger_mid ON budget_ledger(mid);
CREATE INDEX IF NOT EXISTS idx_prov_run ON provenance(run_id, seq);
`;
