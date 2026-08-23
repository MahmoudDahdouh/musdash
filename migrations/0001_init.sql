-- Phase 1 schema. PHASES.md §7.
-- STRICT on every table: SQLite otherwise accepts any type in any column.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
) STRICT;

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,        -- random 32-byte hex, this IS the cookie
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TEXT NOT NULL
) STRICT;

CREATE TABLE environments (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,           -- "production", "staging"
  created_at TEXT NOT NULL,
  UNIQUE(project_id, name)
) STRICT;

CREATE TABLE resources (
  id             TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,       -- slug: [a-z0-9-]+
  kind           TEXT NOT NULL,       -- Phase 1: only 'image'
  source_json    TEXT NOT NULL,       -- {"image":"nginx:alpine"}
  desired_state  TEXT NOT NULL,       -- 'running' | 'stopped'
  container_port INTEGER,
  memory_limit_mb INTEGER NOT NULL DEFAULT 512,
  health_path    TEXT,                -- e.g. "/health"; NULL disables HTTP check
  container_id   TEXT,
  current_deployment_id TEXT,
  previous_image TEXT,                -- enables one-click rollback
  created_at     TEXT NOT NULL,
  UNIQUE(environment_id, name)
) STRICT;

CREATE TABLE deployments (
  id          TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  status      TEXT NOT NULL,   -- queued|running|succeeded|failed|cancelled
  image       TEXT NOT NULL,
  trigger     TEXT NOT NULL,   -- 'manual' | 'rollback' | 'reconcile'
  error       TEXT,
  started_at  TEXT,
  finished_at TEXT,
  created_at  TEXT NOT NULL
) STRICT;

CREATE TABLE env_vars (
  id              TEXT PRIMARY KEY,
  resource_id     TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,
  value_encrypted BLOB NOT NULL,
  created_at      TEXT NOT NULL,
  UNIQUE(resource_id, key)
) STRICT;

CREATE TABLE domains (
  id          TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  host        TEXT NOT NULL UNIQUE,
  is_auto     INTEGER NOT NULL DEFAULT 0,   -- generated from wildcard
  created_at  TEXT NOT NULL
) STRICT;

CREATE TABLE jobs (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status       TEXT NOT NULL,      -- pending|leased|done|failed
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_after    TEXT NOT NULL,
  leased_until TEXT,
  last_error   TEXT,
  created_at   TEXT NOT NULL
) STRICT;

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_jobs_claim ON jobs(status, run_after);
CREATE INDEX idx_deploy_resource ON deployments(resource_id, created_at DESC);
