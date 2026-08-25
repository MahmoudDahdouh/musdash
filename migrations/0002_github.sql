-- Phase 2 schema. PHASES.md §26.
-- STRICT on every table, matching 0001.

-- One GitHub App per musdash instance, registered through the manifest flow.
-- Every secret is AES-256-GCM at rest, using the same key as env var values.
CREATE TABLE github_apps (
  id                 TEXT PRIMARY KEY,
  app_id             INTEGER NOT NULL,
  slug               TEXT NOT NULL,
  client_id          TEXT NOT NULL,
  client_secret_enc  BLOB NOT NULL,
  private_key_enc    BLOB NOT NULL,
  webhook_secret_enc BLOB NOT NULL,
  created_at         TEXT NOT NULL
) STRICT;

CREATE TABLE github_installations (
  id              TEXT PRIMARY KEY,
  app_id          TEXT NOT NULL REFERENCES github_apps(id) ON DELETE CASCADE,
  installation_id INTEGER NOT NULL UNIQUE,
  account_login   TEXT NOT NULL,
  created_at      TEXT NOT NULL
) STRICT;

CREATE TABLE registry_credentials (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  registry_url TEXT NOT NULL,
  username     TEXT NOT NULL,
  password_enc BLOB NOT NULL,
  created_at   TEXT NOT NULL
) STRICT;

-- Git source for a resource whose kind is 'git'. Every column is nullable, or
-- carries a default: SQLite backfills existing rows implicitly, and a bare
-- NOT NULL would fail on any database that already holds resources.
ALTER TABLE resources ADD COLUMN git_installation_id    TEXT;
ALTER TABLE resources ADD COLUMN git_repo               TEXT;
ALTER TABLE resources ADD COLUMN git_branch             TEXT;
ALTER TABLE resources ADD COLUMN build_pack             TEXT;
ALTER TABLE resources ADD COLUMN dockerfile_path        TEXT;
ALTER TABLE resources ADD COLUMN build_context          TEXT;
ALTER TABLE resources ADD COLUMN auto_deploy            INTEGER NOT NULL DEFAULT 1;
ALTER TABLE resources ADD COLUMN registry_credential_id TEXT;

-- What a git resource is actually running. Kept OUT of resources.source_json,
-- which for a git resource describes the repository: writing the built tag
-- there would make the resource read as an image resource on its next deploy
-- and silently stop rebuilding.
ALTER TABLE resources ADD COLUMN built_image TEXT;

ALTER TABLE deployments ADD COLUMN commit_sha     TEXT;
ALTER TABLE deployments ADD COLUMN commit_message TEXT;
ALTER TABLE deployments ADD COLUMN commit_author  TEXT;

-- The webhook handler resolves a push to the resources watching that repo and
-- branch; without this it is a full scan of resources on every delivery.
CREATE INDEX idx_resources_git_repo ON resources(git_repo, git_branch);
