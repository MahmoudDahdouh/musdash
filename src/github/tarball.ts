import { existsSync } from "node:fs"
import type { FetchedSource, SourceFetcher } from "../jobs/build.ts"
import { localSourceFetcher, setSourceFetcher } from "../jobs/build.ts"
import { logger } from "../log.ts"
import { ghFetch, GitHubError } from "./api.ts"
import { getCommit, isValidGitRef, isValidRepoRef } from "./repos.ts"
import { installationToken } from "./tokens.ts"

/**
 * Repository source, fetched as a tarball and extracted straight to disk.
 *
 * The tarball endpoint over `git clone`: one authenticated request, no git
 * binary, no `.git` directory, smaller footprint (DECISIONS, "Source fetching").
 */

/** A build can legitimately take minutes; a fetch cannot. Job concurrency is 1,
 *  so a hung fetch parks every queued deploy behind it. */
const FETCH_TIMEOUT_MS = 120_000

/**
 * Extracts a gzipped tarball stream into `dest`.
 *
 * The stream is handed to Bun.spawn as stdin rather than pumped by hand: a
 * manual write loop over the response body deadlocks once the pipe fills,
 * because nothing is reading the other end while the loop blocks. Letting Bun
 * own the pumping keeps memory flat — the whole point of streaming rather than
 * buffering a tarball that can be hundreds of megabytes.
 *
 * --strip-components=1 removes GitHub's `{owner}-{repo}-{sha}/` wrapper.
 */
async function extract(
  body: ReadableStream<Uint8Array>,
  dest: string,
): Promise<void> {
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(["tar", "-xz", "--strip-components=1", "-C", dest], {
      stdin: body,
      stdout: "ignore",
      stderr: "pipe",
    })
  } catch (err) {
    throw new Error(
      `could not run tar — is it installed and on PATH? (${(err as Error).message})`,
    )
  }

  const kill = setTimeout(() => {
    proc.kill()
  }, FETCH_TIMEOUT_MS)

  try {
    // stderr is drained concurrently with the wait: an undrained pipe blocks
    // tar as soon as its buffer fills, and nothing would ever read it if we
    // waited for exit first.
    const [code, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr as ReadableStream).text(),
    ])
    if (code !== 0) {
      throw new Error(`tar exited ${code}: ${stderr.trim() || "no output"}`)
    }
  } finally {
    clearTimeout(kill)
  }
}

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
): Promise<void> {
  const auth =
    installationId === null
      ? ({ kind: "none" } as const)
      : ({
          kind: "installation" as const,
          token: await installationToken(installationId),
        } as const)

  const res = await ghFetch(`/repos/${repo}/tarball/${sha}`, auth, {
    redirect: "manual",
  })

  let body = res.body
  const location = res.headers.get("location")
  if (location) {
    // Never log `location`: the signed URL grants read access to the archive.
    logger.debug({ repo }, "following GitHub's archive redirect")
    const signed = await fetch(location, {
      headers: { "user-agent": "mosdash" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!signed.ok) {
      throw new GitHubError(
        `GitHub's archive host returned ${signed.status} for ${repo}`,
        signed.status,
      )
    }
    body = signed.body
  }

  if (!body) throw new Error(`GitHub returned an empty archive for ${repo}`)
  await extract(body, dest)
}

/**
 * The source fetcher Checkpoint 4 installs, replacing the local-directory seam.
 *
 * Three ways in, and the last one matters: a filesystem path still delegates to
 * localSourceFetcher, which is what keeps checkpoint 3's end-to-end build
 * verification runnable without GitHub.
 */
export const githubSourceFetcher: SourceFetcher = async (source, destDir) => {
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
  await download(repo, commit.sha, installation, destDir)
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
