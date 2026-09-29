-- BuildKit's memory cap, in MiB, when this deployment's build switched a
-- Next.js 16+ app from Turbopack to webpack because the cap was too small for
-- Turbopack. The deployment page shows a note from it.
--
-- One integer per row, not a log: the deploy log line that says the same
-- thing lives in the ring buffer and the log file like every other.
--
-- Nullable with no backfill: rows from before this migration did not switch,
-- and every row that did not build (reuse, rollback, reconcile) stays null.
ALTER TABLE deployments ADD COLUMN auto_webpack_cap_mib INTEGER;
