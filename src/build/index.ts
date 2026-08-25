import { existsSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { config } from "../config.ts"
import { logger } from "../log.ts"
import { redactValues } from "../log.ts"
import { buildWithDockerfile } from "./buildctl.ts"
import { buildWithRailpack } from "./railpack.ts"
import { BuildError, type BuildPack, type BuildContext } from "./types.ts"

/**
 * Turns a directory of source into a tagged local image.
 *
 * Two strategies, both shelling out to an external binary: a user-specified
 * Dockerfile through buildctl, and zero-config detection through Railpack. This
 * module owns the choice between them, the redaction of build output, and the
 * timeout; the strategy modules own the mechanics.
 */

/** Builds are far slower than deploys — a cold Node build measured 188s. */
const BUILD_TIMEOUT_MS = 30 * 60 * 1000

export interface BuildRequest {
  contextDir: string
  tag: string
  cacheKey: string
  pack: BuildPack
  dockerfilePath?: string
  buildArgs: Record<string, string>
  /**
   * Every secret value known for this resource, at EVERY scope — not only the
   * build args above.
   *
   * Deriving the redaction set from buildArgs was correct only while one map
   * served both the container and the build. Now that they differ, a
   * runtime-only secret can still surface in build output (a Dockerfile that
   * cats a mounted file, a token inside a lockfile URL), so redaction coverage
   * must not depend on what is actually passed as a build arg.
   */
  redactSecrets: readonly string[]
  /** Skips the layer cache; see BuildContext.noCache. */
  noCache?: boolean
  onLog: (line: string) => void
}

/**
 * Which strategy suits a directory.
 *
 * A Dockerfile is an explicit statement of how the author wants their app
 * built, so its presence wins over anything inferred. Everything else is
 * Railpack's job — it detects the language itself, and guessing here would
 * duplicate that badly.
 */
export function detectBuildPack(
  contextDir: string,
  dockerfilePath = "Dockerfile",
): BuildPack {
  return existsSync(resolve(contextDir, dockerfilePath))
    ? "dockerfile"
    : "railpack"
}

export async function buildImage(req: BuildRequest): Promise<void> {
  if (!existsSync(req.contextDir)) {
    throw new BuildError(`build context ${req.contextDir} does not exist`)
  }
  mkdirSync(config.buildCacheDir, { recursive: true })

  // Build args are secrets as often as not, and BuildKit echoes RUN lines into
  // the progress stream verbatim. Redaction is applied HERE, at the single
  // point every build line passes through, rather than in each strategy — a
  // per-strategy redactor is one forgotten call away from leaking.
  //
  // From redactSecrets, not Object.values(buildArgs): buildArgs is only the
  // build-scoped subset, and a runtime-only secret can still appear in build
  // output.
  const secrets = req.redactSecrets
  const onLog = (line: string) => {
    req.onLog(redactValues(line, secrets))
  }

  const ctx: BuildContext = {
    contextDir: req.contextDir,
    tag: req.tag,
    cacheKey: req.cacheKey,
    buildArgs: req.buildArgs,
    dockerfilePath: req.dockerfilePath,
    noCache: req.noCache,
    onLog,
    timeoutMs: BUILD_TIMEOUT_MS,
  }

  const started = Date.now()
  logger.info({ tag: req.tag, pack: req.pack }, "build started")

  if (req.pack === "dockerfile") {
    await buildWithDockerfile(ctx)
  } else {
    await buildWithRailpack(ctx)
  }

  const ms = Date.now() - started
  logger.info({ tag: req.tag, pack: req.pack, ms }, "build finished")

  // Build-only time, into the deploy log the user actually reads. The
  // deployment row's duration spans fetch, health gate, and a fixed drain, so a
  // build dropping from cold to warm barely moves it — this line is what makes
  // the cache's effect visible. Through the redacting onLog, so every line out
  // of here still has exactly one path.
  onLog(`Build finished in ${(ms / 1000).toFixed(1)}s using ${req.pack}`)
}
