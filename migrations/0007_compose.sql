-- Compose stacks (docs/PHASE-3-PLAN.md §3.1).
--
-- The exact Compose file each deploy used, so Roll back and "Deploy this again"
-- redeploy that text. It never holds a secret: interpolation happens later, in
-- a temporary file that is deleted after the deploy. NULL for image and git
-- deployments, and for every row from before this migration.
ALTER TABLE deployments ADD COLUMN compose_file TEXT;

-- Which service of a stack a domain routes to, and on which container port.
-- Both NULL for image and git resources, whose port is on the resource row.
ALTER TABLE domains ADD COLUMN service_name TEXT;
ALTER TABLE domains ADD COLUMN container_port INTEGER;
