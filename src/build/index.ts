import { existsSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { config } from "../config.ts"
import { logger } from "../log.ts"
import { redactValues } from "../log.ts"
import { buildkitMemory, restartBuildkit } from "./bootstrap.ts"
import { buildWithDockerfile } from "./buildctl.ts"
import { isStarved, keptAfterBuild } from "./memory.ts"
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

/**
 * How long a build may print nothing before BuildKit's memory is looked at.
 *
 * Long, because a build can be quiet for minutes while it compiles, and on a
 * small host with swap (D50) a build over the cap is slow rather than stuck;
 * but a third of the timeout, which is what a starved build used to cost (P-9).
 * The build is stopped only if the daemon is also pinned at its cap.
 */
const STALL_AFTER_MS = 10 * 60 * 1000

const MIB = 1024 * 1024

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
  /**
   * BuildKit's memory cap as the job read it before the fingerprint, or null
   * when the daemon could not be asked. Passed in rather than read here so the
   * "may use up to" line, the memory advice, the fingerprint and the webpack
   * decision all describe the same reading.
   */
  buildkitLimitBytes: number | null
  /** See BuildContext.railpackBuildCmd. */
  railpackBuildCmd?: string
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

  // The cap is read from the daemon rather than recomputed, so an override
  // and the host-sized value are reported the same way. Said up front: a
  // build that needs more than this will not fit, and on the 1GB host nothing
  // told the user so before, during or after (P-8). The job's one reading,
  // not a second one, so this line cannot disagree with the webpack decision.
  const capMb =
    req.buildkitLimitBytes === null
      ? null
      : Math.round(req.buildkitLimitBytes / MIB)
  if (capMb !== null) onLog(`BuildKit may use up to ${capMb} MiB of memory`)

  const ctx: BuildContext = {
    contextDir: req.contextDir,
    tag: req.tag,
    cacheKey: req.cacheKey,
    buildArgs: req.buildArgs,
    dockerfilePath: req.dockerfilePath,
    noCache: req.noCache,
    railpackBuildCmd: req.railpackBuildCmd,
    onLog,
    timeoutMs: BUILD_TIMEOUT_MS,
    stall: {
      afterMs: STALL_AFTER_MS,
      isStarved: async () => {
        const m = await buildkitMemory()
        return m !== null && isStarved(m)
      },
    },
    memoryAdvice:
      (capMb === null ? "" : `BuildKit can use ${capMb} MiB on this server. `) +
      "Build the image somewhere with more memory — in GitHub Actions, for example — and deploy it as an image, or use a server with more memory.",
  }

  const started = Date.now()
  logger.info({ tag: req.tag, pack: req.pack }, "build started")

  try {
    if (req.pack === "dockerfile") {
      await buildWithDockerfile(ctx)
    } else {
      await buildWithRailpack(ctx)
    }
  } catch (err) {
    // Ending the client cancels its solve, but on the 1GB host a timed-out
    // build's npm and apt processes were still running inside BuildKit,
    // holding the cap the next build needed (P-10). Every failure, not only a
    // timeout: a step that failed while another ran in parallel can leave the
    // same thing behind, and the restart costs seconds.
    await restartQuietly(
      onLog,
      "Restarting BuildKit to stop anything the failed build left running",
    )
    throw err
  }

  const ms = Date.now() - started
  logger.info({ tag: req.tag, pack: req.pack, ms }, "build finished")

  // Build-only time, into the deploy log the user actually reads. The
  // deployment row's duration spans fetch, health gate, and a fixed drain, so a
  // build dropping from cold to warm barely moves it — this line is what makes
  // the cache's effect visible. Through the redacting onLog, so every line out
  // of here still has exactly one path.
  onLog(`Build finished in ${(ms / 1000).toFixed(1)}s using ${req.pack}`)

  // buildkitd keeps its heap after a build: 227 of 384 MiB on the 1GB host,
  // 40 minutes later, which the next build then did not have (P-3).
  const after = await buildkitMemory()
  if (after !== null && keptAfterBuild(after)) {
    await restartQuietly(
      onLog,
      `Restarting BuildKit to release the ${Math.round((after.anonBytes ?? 0) / MIB)} MiB it kept after the build`,
    )
  }
}

/**
 * Restarts the build daemon, and says so in the deploy log.
 *
 * Never throws: the build's own outcome is what the deploy reports. A daemon
 * that does not come back is found by the reconciler, whose BuildKit bootstrap
 * starts it again, and by the next build.
 */
async function restartQuietly(
  onLog: (line: string) => void,
  line: string,
): Promise<void> {
  onLog(line)
  try {
    await restartBuildkit()
  } catch (err) {
    // The Engine's text stays in the service log; the deploy log is shown in
    // the browser and gets a line the user can act on.
    logger.warn(
      { err: (err as Error).message },
      "could not restart the build daemon",
    )
    onLog(
      "BuildKit did not restart cleanly; musdash starts it again within a minute, and the service log has the details",
    )
  }
}
