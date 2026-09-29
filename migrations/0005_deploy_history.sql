-- What a build was built FROM, recorded on the deployment row (D59).
--
-- git_repo is the repository the build fetched, as it was at that moment: the
-- resource's own repo can be re-pointed later, and a row that only named its
-- commit would then describe a commit in a repository it never came from.
--
-- build_fingerprint is an HMAC over every input that decides what a build
-- produces (commit, repository, pack, Dockerfile path, build context, build
-- variables), keyed from data/secret.key. A push whose fingerprint matches an
-- earlier succeeded build reuses that image instead of building again. Keyed
-- rather than a plain hash so a copy of this database alone cannot be used to
-- brute-force a low-entropy build variable offline.
--
-- Both nullable with no backfill: rows written before this migration simply
-- never match, which costs one build, never a wrong reuse. No index — the
-- lookup is already narrowed to one resource by idx_deploy_resource.
ALTER TABLE deployments ADD COLUMN git_repo TEXT;
ALTER TABLE deployments ADD COLUMN build_fingerprint TEXT;
