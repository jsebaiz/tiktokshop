CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  agent_slug TEXT NOT NULL,
  task TEXT NOT NULL,
  status TEXT NOT NULL,
  send_state TEXT NOT NULL DEFAULT 'idle',
  stale INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  accepted_at TEXT,
  run_uuid TEXT,
  output_url TEXT,
  note TEXT,
  error TEXT,
  callback_token_hash TEXT NOT NULL,
  callback_failures INTEGER NOT NULL DEFAULT 0,
  UNIQUE (agent_slug, task, idempotency_key)
);

CREATE INDEX idx_jobs_agent_created ON jobs (agent_slug, created_at DESC);

CREATE TABLE oauth_credentials (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  email TEXT,
  refresh_token_enc TEXT NOT NULL,
  access_token_enc TEXT,
  access_expires_at TEXT,
  scopes TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  code_verifier_enc TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE upload_sessions (
  id TEXT PRIMARY KEY,
  folder_id TEXT NOT NULL,
  folder_key TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  received_bytes INTEGER NOT NULL DEFAULT 0,
  session_uri_enc TEXT,
  status TEXT NOT NULL,
  error TEXT,
  drive_file_id TEXT,
  web_view_link TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE login_attempts (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  failures INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT
);
