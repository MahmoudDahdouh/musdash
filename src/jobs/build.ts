import { cpSync, existsSync } from "node:fs"
import { buildFingerprint, fingerprintKey } from "../build/fingerprint.ts"
import { builtImageTag } from "../build/images.ts"
import { buildImage, detectBuildPack } from "../build/index.ts"
import {
  scanUnsupportedSource,
  UnsupportedSourceError,
} from "../build/unsupported-source.ts"
import { createBuildDir, removeBuildDir } from "../build/workdir.ts"
import { config } from "../config.ts"
import { loadKey } from "../crypto.ts"
import { gitSource } from "../db/queries.ts"
import type { Resource } from "../db/schema.ts"
import { shortId } from "../ids.ts"
import { logger } from "../log.ts"

/**
 * Produces the image a git resource should run, for one deployment.
 *
 * A phase of `runDeploy` rather than a job of its own, deliberately. Two jobs at
 * concurrency 1 can be separated in the queue by an unrelated deploy, which
 * leaves the deployment row "running" across both with no single owner of the
 * failure path — and `runDeploy` already owns marking a deployment failed, the
 * SSE log topic, and cleanup-by-stage. Splitting that in two would duplicate
 * all of it.
 *
 * The caller is responsible for nothing: the build directory is created and
 * removed here, in a `finally`, so no failure path can leak it.
 */

/**
 * Which repository, at which ref, and on whose behalf.
 *
 * `installationId` is null for a public repository and for the local-directory
 * seam; only a private repository needs a GitHub installation token.
 */
export interface SourceRequest {
  repo: string
  ref: string
  installationId: string | null
}

/**
 * The commit a fetch actually landed on.
 *
 * Returned rather than looked up separately so the recorded commit is
 * definitionally the one that was built. Null where there is no commit at all —
 * a local directory has none.
 */
export interface FetchedSource {
  sha: string
  message: string | null
  author: string | null
}

/**
 * Where the source comes from.
 *
 * Checkpoint 3 fetched from a local path so the build pipeline and the deploy
 * branch could be proven without GitHub existing. Checkpoint 4 replaced the
 * implementation with the authenticated tarball fetch — the local path stays
 * reachable through the new fetcher, which is what keeps checkpoint 3's
 * verification runnable.
 *
 * Two steps rather than one (D60): whether a build can be skipped depends on
 * the commit, so the commit has to be known before anything is downloaded. One
 * combined call would download a tree only to throw it away.
 */
export interface SourceFetcher {
  /** Resolves source.ref to a commit. Null for the local-directory seam. Writes nothing to disk. */
  resolve(source: SourceRequest): Promise<FetchedSource | null>
  /** Writes the tree at `commit` (or copies the local dir when null) into destDir, which exists and is empty. */
  fetch(
    source: SourceRequest,
    commit: FetchedSource | null,
    destDir: string,
    /** The deploy log, for a line the fetch itself has to say (a retry). */
    emit?: (line: string) => void,
  ): Promise<void>
}

function assertLocalSource(repo: string): void {
  if (!existsSync(repo)) {
    throw new Error(`local source ${repo} does not exist`)
  }
}

/**
 * Copies from a local directory. `repo` is a filesystem path here.
 *
 * Reached from the create dialog's "Local path" field when what is typed there
 * is a directory rather than `owner/name` (which githubSourceFetcher fetches
 * from GitHub without credentials). A path on the server is for testing on the
 * host itself, not a way to deploy from someone else's machine.
 * Resolves to no commit: a directory is not a repository.
 */
export const localSourceFetcher: SourceFetcher = {
  resolve(source) {
    assertLocalSource(source.repo)
    return Promise.resolve(null)
  },
  fetch(source, _commit, dest) {
    assertLocalSource(source.repo)
    cpSync(source.repo, dest, { recursive: true })
    return Promise.resolve()
  },
}

let sourceFetcher: SourceFetcher = localSourceFetcher

/** Swaps the fetcher. Checkpoint 4 calls this with the GitHub tarball fetch. */
export function setSourceFetcher(fetcher: SourceFetcher): void {
  sourceFetcher = fetcher
}

/** What onCommit is told about the build besides the commit itself. */
export interface CommitRecord {
  repo: string
  /** Keyed HMAC of the build inputs. Stored, never logged or emitted. */
  fingerprint: string
}

export interface BuildOptions {
  /** After the commit is resolved and recorded, before any download. A returned tag skips download and build. */
  reuse?: (commit: FetchedSource, fingerprint: string) => Promise<string | null>
  /**
   * Build this commit instead of the branch head: 40 lowercase hex. Set only
   * by "Deploy this again", which repeats a recorded build (D61) — the branch
   * may have moved on since, and building its head would deploy something the
   * user did not pick.
   */
  commitSha?: string
}

/**
 * The image this deployment should run.
 *
 * `reused` is true when no build ran and `image` is an earlier build of the
 * same inputs; its tag then names that earlier deployment, not this one.
 */
export interface BuiltSource {
  image: string
  reused: boolean
}

export async function buildFromSource(
  resource: Resource,
  deploymentId: string,
  emit: (line: string) => void,
  /** Build-scoped variables only; runtime-only ones never reach the build. */
  buildArgs: Record<string, string>,
  /** Every secret at every scope, for redaction. See BuildRequest. */
  redactSecrets: readonly string[],
  /**
   * Called with the commit as soon as it is resolved, before anything is
   * downloaded or built.
   *
   * A callback rather than part of the return value: only a build that
   * succeeds returns, and a failed build is the deploy whose commit the user
   * most needs to see (P-2).
   */
  onCommit: (commit: FetchedSource, record: CommitRecord) => void,
  opts: BuildOptions = {},
): Promise<BuiltSource> {
  const source = gitSource(resource)
  if (!source) {
    throw new Error(
      `resource ${resource.id} is marked git but has no repository configured`,
    )
  }

  const request: SourceRequest = {
    repo: source.repo,
    ref: opts.commitSha ?? source.branch,
    installationId: resource.gitInstallationId,
  }

  emit(
    opts.commitSha === undefined
      ? `Fetching ${source.repo} (${source.branch})`
      : `Fetching ${source.repo} at commit ${opts.commitSha.slice(0, 7)}`,
  )
  // Resolve the ref to a commit FIRST, then fetch that exact commit. Fetching
  // the branch name instead would leave a window in which a push lands between
  // the two calls, and the deployment row would record a commit that is not
  // the one that was built.
  const commit = await sourceFetcher.resolve(request)
  if (commit) {
    emit(`At commit ${commit.sha.slice(0, 7)}`)
    // Over every input that decides what the build produces, taken from the
    // same `source` and `buildArgs` the build below uses, so the fingerprint
    // cannot describe a different build from the one it is stored against.
    // The stored pack, not the detected one: detection needs the downloaded
    // tree, and the stored value together with the commit determines it.
    const fingerprint = buildFingerprint(fingerprintKey(loadKey()), {
      commitSha: commit.sha,
      repo: source.repo,
      pack: source.pack,
      dockerfilePath: source.dockerfilePath ?? null,
      buildContext: source.buildContext ?? null,
      buildVars: buildArgs,
    })
    onCommit(commit, { repo: source.repo, fingerprint })

    // Before the build directory exists: a reused image downloads nothing and
    // never touches BuildKit, so there is nothing to create or clean up.
    const reused = opts.reuse ? await opts.reuse(commit, fingerprint) : null
    if (reused !== null) return { image: reused, reused: true }
  }

  const tag = builtImageTag(resource.name, deploymentId)
  const dir = createBuildDir(deploymentId)

  try {
    await sourceFetcher.fetch(request, commit, dir, emit)

    const contextDir = source.buildContext
      ? `${dir}/${source.buildContext}`
      : dir

    // A tarball leaves a submodule's directory empty and an LFS file as its
    // pointer; the build would fail somewhere unrelated, or worse, ship the
    // pointer text (D62). Only a downloaded tree is scanned: the local-directory
    // seam resolves no commit and copies a real checkout. After onCommit, so a
    // refused deploy still names its commit (P-2).
    if (commit) {
      const findings = await scanUnsupportedSource(dir, contextDir)
      if (findings.truncated !== null) {
        logger.debug(
          { deploymentId, reason: findings.truncated },
          "unsupported-source scan stopped early; proceeding",
        )
      }
      if (findings.submodules.length > 0 || findings.lfsPointers.length > 0) {
        throw new UnsupportedSourceError(findings)
      }
    }
    // gitSource() always yields a pack, so detection runs only where the stored
    // value is the "railpack" default AND a Dockerfile is actually present —
    // which is the case where the user never made an explicit choice. Detection
    // looks at the build context rather than the repository root, so a
    // Dockerfile beside the app in a monorepo is found.
    const pack =
      source.pack === "railpack"
        ? detectBuildPack(contextDir, source.dockerfilePath)
        : source.pack
    emit(`Building with ${pack}`)

    await buildImage({
      contextDir,
      tag,
      // Per resource: the cache is what makes a redeploy fast, and scoping it
      // per deployment would miss on every single build.
      cacheKey: shortId(resource.id),
      pack,
      dockerfilePath: source.dockerfilePath,
      buildArgs,
      redactSecrets,
      noCache: config.buildNoCache,
      onLog: emit,
    })
    return { image: tag, reused: false }
  } finally {
    // Both paths. Build directories are the second-largest disk leak after
    // images, and a failed build leaves the largest ones.
    removeBuildDir(deploymentId)
  }
}
