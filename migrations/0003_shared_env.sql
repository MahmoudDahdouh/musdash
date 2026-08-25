-- Shared environment variables and build/runtime scoping. PHASES.md §26.
-- STRICT on every table, matching 0001 and 0002.

-- A variable owned by a project or by an environment rather than by one
-- resource. Exactly one of project_id / environment_id is set: a row with both
-- has no defined position in the resolution order, and a row with neither
-- belongs to nothing and would be invisible to every query. The CHECK makes
-- both unrepresentable rather than merely discouraged.
--
-- Two nullable owner columns rather than one polymorphic (owner_kind, owner_id)
-- pair, because only a real foreign key gets ON DELETE CASCADE — deleting a
-- project must take its shared variables with it, and a polymorphic column
-- would leave ciphertext behind forever with nothing pointing at it.
CREATE TABLE shared_env_vars (
  id              TEXT PRIMARY KEY,
  project_id      TEXT REFERENCES projects(id) ON DELETE CASCADE,
  environment_id  TEXT REFERENCES environments(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,
  value_encrypted BLOB NOT NULL,
  -- 'runtime' | 'build' | 'both'. Plain TEXT with no CHECK, matching
  -- deployments.trigger and jobs.type: widening the union later then needs no
  -- migration. The route boundary enforces it.
  scope           TEXT NOT NULL DEFAULT 'runtime',
  created_at      TEXT NOT NULL,
  CHECK ((project_id IS NULL) <> (environment_id IS NULL))
) STRICT;

-- UNIQUE(project_id, key) as a table constraint would not do the job: SQLite
-- treats every NULL as distinct, so environment-level rows (project_id NULL)
-- would collide with nothing and duplicates would slip through. Two PARTIAL
-- unique indexes scope each constraint to the rows that actually have that
-- owner.
CREATE UNIQUE INDEX idx_shared_env_project
  ON shared_env_vars(project_id, key) WHERE project_id IS NOT NULL;
CREATE UNIQUE INDEX idx_shared_env_environment
  ON shared_env_vars(environment_id, key) WHERE environment_id IS NOT NULL;

-- Build-time vs runtime, per variable.
--
-- Existing rows become 'runtime', which is a deliberate BEHAVIOUR CHANGE: until
-- now the one decrypted map was handed BOTH to createContainer and to
-- buildFromSource, so every runtime secret was also passed as a build arg and
-- baked into image history. After this migration a variable reaches the build
-- only if it is explicitly marked 'build' or 'both'. A resource that relied on
-- the old behaviour must re-mark those variables.
ALTER TABLE env_vars ADD COLUMN scope TEXT NOT NULL DEFAULT 'runtime';
