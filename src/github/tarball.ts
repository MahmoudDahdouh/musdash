import { existsSync } from "node:fs"
import type {
  FetchedSource,
  SourceFetcher,
  SourceRequest,
} from "../jobs/build.ts"
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
  // never extracts over a half-written tree (D58).
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

/** Where a SourceRequest points, once validated. */
type ValidatedSource =
  | { kind: "local" }
  | { kind: "github"; repo: string; ref: string; installation: number | null }

/**
 * Validates a request, for both steps: resolve and fetch must agree on what a
 * request means, and two copies of these checks would drift apart.
 */
function validate(source: SourceRequest): ValidatedSource {
  const { repo, ref, installationId } = source

  // A local path: the create dialog's Local path field reaches this, and it is
  // the verification seam. An owner/name typed into that same field is not a
  // local path — it falls through below and is fetched from GitHub without
  // credentials, as a public repository.
  if (!isValidRepoRef(repo)) {
    if (existsSync(repo)) return { kind: "local" }
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
  return { kind: "github", repo, ref, installation }
}

/**
 * The source fetcher Checkpoint 4 installs, replacing the local-directory seam.
 *
 * Three ways in, and the last one matters: a filesystem path still delegates to
 * localSourceFetcher, which is what keeps checkpoint 3's end-to-end build
 * verification runnable without GitHub.
 */
export const githubSourceFetcher: SourceFetcher = {
  async resolve(source) {
    const target = validate(source)
    if (target.kind === "local") return localSourceFetcher.resolve(source)
    const commit = await getCommit(target.installation, target.repo, target.ref)
    return commit satisfies FetchedSource
  },

  async fetch(source, commit, destDir, emit) {
    const target = validate(source)
    if (target.kind === "local") {
      return localSourceFetcher.fetch(source, null, destDir, emit)
    }
    // Only ever the commit resolve() returned, never the branch name: fetching
    // the branch would reopen the window resolve-then-fetch exists to close — a
    // push landing in between would be built under the previous commit's record.
    if (!commit) {
      throw new Error(`no commit was resolved for ${target.repo}`)
    }
    await download(target.repo, commit.sha, target.installation, destDir, emit)
  },
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
