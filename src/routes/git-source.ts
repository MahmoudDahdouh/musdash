import { listGithubInstallations } from "../db/queries.ts"
import { isValidGitRef, isValidRepoRef } from "../github/repos.ts"

/**
 * The installation / repository / branch rules for a git resource's source.
 *
 * One function for both the create route and the re-link route, so re-linking
 * can never accept something creating refuses. Each route maps a refusal to its
 * own response; the rules themselves live only here.
 *
 * Two shapes, and the difference is deliberate. WITH an installation the repo
 * came from GitHub and is validated as a real repository reference and a real
 * git ref, because both become path segments in a GitHub URL. WITHOUT one, the
 * repo stays free text and the branch is not checked: githubSourceFetcher falls
 * back to a local directory when the value is not a repository reference
 * (tarball.ts), and that seam is how the build verification runs on a box with
 * no GitHub at all. Requiring isValidRepoRef unconditionally would remove it.
 * The fetcher still validates both before any request is made.
 */

export interface GitSourceForm {
  installationId?: string
  repo: string
  branch: string
}

export type GitSourceRefusal =
  "no-repo" | "bad-installation" | "bad-repo" | "bad-branch"

export type GitSourceCheck =
  | { ok: true; installationId: string | null; repo: string; branch: string }
  | { ok: false; refusal: GitSourceRefusal }

export function checkGitSource(form: GitSourceForm): GitSourceCheck {
  const repo = form.repo.trim()
  const branch = form.branch.trim() || "main"
  if (!repo) return { ok: false, refusal: "no-repo" }

  const installationId = form.installationId?.trim() || null
  if (installationId !== null) {
    // Stored as GitHub's integer in DECIMAL STRING form, because the fetcher
    // does Number() on it and throws if the result is not finite. Anything else
    // here fails at deploy time, not now.
    if (!/^\d+$/.test(installationId)) {
      return { ok: false, refusal: "bad-installation" }
    }
    // Checked against installationId (GitHub's number), never against the ULID
    // row id — they are different values and the row id would never match.
    const known = listGithubInstallations().some(
      (i) => String(i.installationId) === installationId,
    )
    if (!known) return { ok: false, refusal: "bad-installation" }

    if (!isValidRepoRef(repo)) return { ok: false, refusal: "bad-repo" }
    if (!isValidGitRef(branch)) return { ok: false, refusal: "bad-branch" }
  }

  return { ok: true, installationId, repo, branch }
}
