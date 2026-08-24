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
  const secrets = Object.values(req.buildArgs)
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

  logger.info(
    { tag: req.tag, pack: req.pack, ms: Date.now() - started },
    "build finished",
  )
}
