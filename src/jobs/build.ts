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
 * Where the source comes from.
 *
 * Checkpoint 3 fetches from a local path so the build pipeline and the deploy
 * branch can be proven without GitHub existing. Checkpoint 4 replaces this with
 * the authenticated tarball fetch; nothing else in this file changes, which is
 * the point of the seam.
 */
export type SourceFetcher = (
  repo: string,
  ref: string,
  destDir: string,
) => Promise<void>

/**
 * Copies from a local directory. `repo` is a filesystem path here.
 *
 * Not reachable from the UI — there is no way to create a git resource pointing
 * at a local path — so this is a verification seam, not a user-facing feature.
 */
export const localSourceFetcher: SourceFetcher = (repo, _ref, dest) => {
  if (!existsSync(repo)) throw new Error(`local source ${repo} does not exist`)
  cpSync(repo, dest, { recursive: true })
  return Promise.resolve()
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
export async function buildFromSource(
  resource: Resource,
  deploymentId: string,
  emit: (line: string) => void,
  buildArgs: Record<string, string>,
): Promise<string> {
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
    await fetchSource(source.repo, source.branch, dir)

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
    return tag
  } finally {
    // Both paths. Build directories are the second-largest disk leak after
    // images, and a failed build leaves the largest ones.
    removeBuildDir(deploymentId)
  }
}
