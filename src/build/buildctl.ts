import { config } from "../config.ts"
import { docker } from "../docker/impl.ts"
import { BuildError, type BuildContext } from "./types.ts"
import { runBuilder } from "./railpack.ts"

/**
 * Dockerfile builds, driven through BuildKit's own client.
 *
 * Unlike Railpack, `buildctl` does not load the result into Docker: with a
 * standalone BuildKit container there is no shared image store, so
 * `--output type=docker` writes a tarball that has to be handed back to the
 * Engine. That tarball is streamed to /images/load and never buffered — an
 * image tar is routinely hundreds of megabytes.
 *
 * The tarball goes to a file first rather than piping the subprocess straight
 * into the daemon. Piping is tempting and was measured to work, but it couples
 * two failures into one unreadable state: if the load fails midway the build
 * subprocess is still running and its error is lost. Writing first keeps the
 * build error and the load error distinguishable, and the file lives in the
 * build directory that is deleted either way.
 */

const IMAGE_TAR = "image.tar"

export async function buildWithDockerfile(ctx: BuildContext): Promise<void> {
  const dockerfile = ctx.dockerfilePath ?? "Dockerfile"
  const tarPath = `${ctx.contextDir}/${IMAGE_TAR}`

  const args = [
    "--addr",
    config.buildkitAddr,
    "build",
    "--frontend",
    "dockerfile.v0",
    "--local",
    `context=${ctx.contextDir}`,
    "--local",
    `dockerfile=${ctx.contextDir}`,
    "--opt",
    `filename=${dockerfile}`,
    "--output",
    `type=docker,name=${ctx.tag},dest=${tarPath}`,
    "--progress",
    "plain",
    ...(ctx.noCache ? ["--no-cache"] : []),
    // Layer cache, scoped per resource for the same reason Railpack's is.
    "--export-cache",
    `type=local,dest=${cacheDir(ctx.cacheKey)},mode=max`,
    "--import-cache",
    `type=local,src=${cacheDir(ctx.cacheKey)}`,
  ]
  for (const [k, v] of Object.entries(ctx.buildArgs)) {
    args.push("--opt", `build-arg:${k}=${v}`)
  }

  await runBuilder(config.buildctlBin, args, ctx, {})

  const tar = Bun.file(tarPath)
  if (!(await tar.exists())) {
    throw new BuildError(
      `the build reported success but produced no image tarball at ${IMAGE_TAR}`,
    )
  }
  ctx.onLog(`Loading image ${ctx.tag} into Docker`)
  await docker.loadImage(tar.stream())
}

/** Cache directory for one resource. Lives beside builds, not inside one — a
 *  build directory is deleted when its build ends and would take the cache. */
function cacheDir(cacheKey: string): string {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(cacheKey)) {
    throw new BuildError(`unsafe cache key: ${cacheKey}`)
  }
  return `${config.buildCacheDir}/${cacheKey}`
}
