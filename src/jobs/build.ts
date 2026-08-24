import { cpSync, existsSync } from "node:fs"
import { buildImage, detectBuildPack } from "../build/index.ts"
import { createBuildDir, removeBuildDir } from "../build/workdir.ts"
import { gitSource } from "../db/queries.ts"
import type { Resource } from "../db/schema.ts"
import { shortId } from "../ids.ts"

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
 * implementation with the authenticated tarball fetch and widened this
 * signature by one input and one output — the local path stays reachable
 * through the new fetcher, which is what keeps checkpoint 3's verification
 * runnable.
 */
export type SourceFetcher = (
  source: SourceRequest,
  destDir: string,
) => Promise<FetchedSource | null>

/**
 * Copies from a local directory. `repo` is a filesystem path here.
 *
 * Not reachable from the UI — there is no way to create a git resource pointing
 * at a local path — so this is a verification seam, not a user-facing feature.
 * Returns no commit: a directory is not a repository.
 */
export const localSourceFetcher: SourceFetcher = (source, dest) => {
  if (!existsSync(source.repo)) {
    throw new Error(`local source ${source.repo} does not exist`)
  }
  cpSync(source.repo, dest, { recursive: true })
  return Promise.resolve(null)
}

let fetchSource: SourceFetcher = localSourceFetcher

/** Swaps the fetcher. Checkpoint 4 calls this with the GitHub tarball fetch. */
export function setSourceFetcher(fetcher: SourceFetcher): void {
  fetchSource = fetcher
}

/**
 * Builds and returns the image tag for this deployment.
 *
 * The tag embeds the deployment id, so every build is a distinct reference and
 * a rollback has something to point AT. A single moving tag would make rollback
 * meaningless: both deployments would name the same image.
 */
export interface BuiltSource {
  image: string
  commit: FetchedSource | null
}

export async function buildFromSource(
  resource: Resource,
  deploymentId: string,
  emit: (line: string) => void,
  buildArgs: Record<string, string>,
): Promise<BuiltSource> {
  const source = gitSource(resource)
  if (!source) {
    throw new Error(
      `resource ${resource.id} is marked git but has no repository configured`,
    )
  }

  const tag = `mosdash/${resource.name}:${shortId(deploymentId)}`
  const dir = createBuildDir(deploymentId)

  try {
    emit(`Fetching ${source.repo} (${source.branch})`)
    const commit = await fetchSource(
      {
        repo: source.repo,
        ref: source.branch,
        installationId: resource.gitInstallationId,
      },
      dir,
    )
    if (commit) emit(`At commit ${commit.sha.slice(0, 7)}`)

    const contextDir = source.buildContext
      ? `${dir}/${source.buildContext}`
      : dir
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
      onLog: emit,
    })
    return { image: tag, commit }
  } finally {
    // Both paths. Build directories are the second-largest disk leak after
    // images, and a failed build leaves the largest ones.
    removeBuildDir(deploymentId)
  }
}
