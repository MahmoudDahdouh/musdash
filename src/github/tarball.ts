import { existsSync } from "node:fs"
import type { FetchedSource, SourceFetcher } from "../jobs/build.ts"
import { localSourceFetcher, setSourceFetcher } from "../jobs/build.ts"
import { logger } from "../log.ts"
import { ghFetch } from "./api.ts"
import { ARCHIVE_TIMINGS, downloadArchive, retryLine } from "./archive-fetch.ts"
import { getCommit, isValidGitRef, isValidRepoRef } from "./repos.ts"
import { withInstallationToken } from "./tokens.ts"

/**
 * Repository source, fetched as a tarball and extracted straight to disk.
 *
 * The tarball endpoint over `git clone`: one authenticated request, no git
 * binary, no `.git` directory, smaller footprint (DECISIONS, "Source fetching").
 */

/**
 * Downloads and extracts a repository at a resolved commit.
 *
 * The tarball endpoint answers with a 302 to codeload.github.com carrying a
 * signed, short-lived URL. The Authorization header is deliberately NOT carried
 * across that hop: the signed URL is its own credential, and forwarding a
 * bearer token to a different host leaks an installation credential. Hence
 * redirect:"manual" and an explicit second request — relying on the runtime to
 * strip the header would be correct today and silent if it ever changed.
 */
async function download(
  repo: string,
  sha: string,
  installationId: number | null,
  dest: string,
  emit?: (line: string) => void,
): Promise<void> {
  const path = `/repos/${repo}/tarball/${sha}`
  const init = { redirect: "manual" } as const
  // The 401 re-mint stays on the api.github.com request, inside `locate`. The
  // codeload hop carries no token — its signed URL is the credential — so a
  // failure there is not a stale token, and re-minting would not fix it. The
  // whole download (this request, codeload, tar) is retried at most once, and
  // only after the first tar has exited and `dest` has been emptied: a retry
  // never extracts over a half-written tree (D57).
  const locate = () =>
    installationId === null
      ? ghFetch(path, { kind: "none" }, init)
      : withInstallationToken(installationId, (token) =>
          ghFetch(path, { kind: "installation", token }, init),
        )

  await downloadArchive({
    repo,
    dest,
    timings: ARCHIVE_TIMINGS,
    locate,
    onRetry: (reason) => {
      // The repository and the reason's fields only: never the signed URL,
      // and never an error's own text, which can carry it.
      logger.warn(
        { repo, ...reason },
        "the archive download failed; retrying once",
      )
      emit?.(retryLine(reason, ARCHIVE_TIMINGS))
    },
  })
}

/**
 * The source fetcher Checkpoint 4 installs, replacing the local-directory seam.
 *
 * Three ways in, and the last one matters: a filesystem path still delegates to
 * localSourceFetcher, which is what keeps checkpoint 3's end-to-end build
 * verification runnable without GitHub.
 */
export const githubSourceFetcher: SourceFetcher = async (
  source,
  destDir,
  emit,
) => {
  const { repo, ref, installationId } = source

  // A local path: not reachable from the UI, but it is the verification seam.
  if (!isValidRepoRef(repo)) {
    if (existsSync(repo)) return localSourceFetcher(source, destDir)
    throw new Error(
      `"${repo}" is not a repository reference (owner/name) or an existing directory`,
    )
  }
  if (!isValidGitRef(ref)) {
    throw new Error(`"${ref}" is not a valid branch or tag name`)
  }

  const installation = installationId === null ? null : Number(installationId)
  if (installation !== null && !Number.isFinite(installation)) {
    throw new Error(`installation id "${installationId}" is not a number`)
  }

  // Resolve the ref to a commit FIRST, then fetch that exact commit. Fetching
  // the branch name instead would leave a window in which a push lands between
  // the two calls, and the deployment row would record a commit that is not the
  // one that was built.
  const commit = await getCommit(installation, repo, ref)
  await download(repo, commit.sha, installation, destDir, emit)
  return commit satisfies FetchedSource
}

/**
 * Installs the fetcher.
 *
 * Called explicitly from the job registry rather than run as an import side
 * effect: a side effect is invisible at the call site and is exactly what gets
 * removed by someone tidying an apparently-unused import.
 */
export function installSourceFetcher(): void {
  setSourceFetcher(githubSourceFetcher)
}
