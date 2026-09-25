-- Exactly one account, enforced by the database (S-1, D36).
--
-- musdash is single-user. Until now that was a check in POST /setup, made
-- before an awaited password hash — so two concurrent setups (or a
-- double-click) could both pass it and create two accounts. A constraint holds
-- for every code path, current and future; a handler check holds for one.
--
-- Runs inside the migration runner's transaction (src/db/migrations.ts), so a
-- failure anywhere below rolls back all of it. The runner's hook for this
-- migration logs the kept and moved accounts at error level after commit.

-- 1. Installs that already have more than one account keep the OLDEST
--    (created_at, then id: ULIDs are time-ordered and break ties) and MOVE the
--    rest here rather than deleting them. If a first-boot attacker won the
--    setup race, theirs is the oldest row — deleting would have destroyed the
--    owner's own account. Recovery from this table is manual.
--
--    Deliberately NOT in src/db/schema.ts: nothing in musdash reads it. The
--    hashes stay in the same file that already holds the live hash and are
--    never logged. An explicit STRICT column list rather than
--    CREATE TABLE ... AS, which would drop STRICT and the NOT NULLs.
CREATE TABLE IF NOT EXISTS users_removed_0004 (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
) STRICT;

-- On an empty users table the subquery is NULL and `<> NULL` matches nothing,
-- so all three statements are no-ops on a fresh install and on a one-user one.
INSERT INTO users_removed_0004 (id, email, password_hash, created_at)
  SELECT id, email, password_hash, created_at FROM users
  WHERE id <> (SELECT id FROM users ORDER BY created_at, id LIMIT 1);

-- 2. Sessions first and explicitly, so the result does not depend on
--    PRAGMA foreign_keys (the ON DELETE CASCADE only fires when it is ON).
DELETE FROM sessions
  WHERE user_id <> (SELECT id FROM users ORDER BY created_at, id LIMIT 1);

DELETE FROM users
  WHERE id <> (SELECT id FROM users ORDER BY created_at, id LIMIT 1);

-- 3. The guarantee: a unique index on a constant expression. Every row has the
--    same key, (1), so a second row — any email, the same email included —
--    fails with SQLITE_CONSTRAINT_UNIQUE, which createUser maps to
--    AccountExistsError and POST /setup answers with 303 /login.
--
--    A later migration that rebuilds `users` (SQLite's twelve-step table
--    rebuild) silently drops this index unless it recreates it;
--    src/db/single-user.test.ts applies the full shipped migration list and
--    fails if it is gone.
CREATE UNIQUE INDEX idx_users_single ON users((1));
