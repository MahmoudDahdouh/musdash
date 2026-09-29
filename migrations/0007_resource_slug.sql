-- A resource's machine name, separate from the name the user sees (D65).
--
-- `name` becomes free text (letters, digits, spaces and a little punctuation);
-- `slug` keeps the old rule, ^[a-z0-9-]{1,32}$, and takes over the two places a
-- name reached something outside SQLite: the built image's repository
-- (musdash/<slug>:<id>) and the auto subdomain's label. It is derived once, at
-- creation, and never changes — a rename touches `name` only, so image tags and
-- hostnames stay put.
--
-- NOT NULL with a default, because a bare NOT NULL cannot be added to a
-- populated table. The backfill copies `name`, which every existing row can
-- take as is: until now every write path refused a name outside the slug rule.
ALTER TABLE resources ADD COLUMN slug TEXT NOT NULL DEFAULT '';

UPDATE resources SET slug = name;

-- ADD COLUMN cannot carry UNIQUE, so the constraint is an index. The existing
-- UNIQUE(environment_id, name) stays: dropping it needs a table rebuild, and
-- two resources sharing one display name in an environment would only confuse.
CREATE UNIQUE INDEX idx_resources_env_slug ON resources (environment_id, slug);
