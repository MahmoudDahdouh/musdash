import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { config } from "../config.ts"
import { logger } from "../log.ts"

/**
 * Build directories: created per deployment, removed when the build ends.
 *
 * These are the second-largest disk leak after images, and the leak is silent —
 * a box fills up weeks later and the cause is not obvious from anything in the
 * UI. So there are two independent mechanisms, deliberately: the build removes
 * its own directory in a `finally`, and the daily sweep removes anything left
 * behind by a crash or a SIGKILL that never ran one.
 */

/**
 * The directory for one deployment's build context.
 *
 * The deployment id is a ULID from mosdash's own generator, never user input,
 * but it is still validated before being joined onto a path: an id carrying
 * `..` would escape buildsDir, and this function's whole job is to hand back a
 * path that something later deletes recursively.
 */
export function buildDir(deploymentId: string): string {
  if (!/^[0-9A-Za-z]{1,64}$/.test(deploymentId)) {
    throw new Error(`unsafe deployment id for a build directory: ${deploymentId}`)
  }
  return resolve(config.buildsDir, deploymentId)
}

/** Creates an empty build directory, replacing any leftover of the same name. */
export function createBuildDir(deploymentId: string): string {
  const dir = buildDir(deploymentId)
  // A retry of the same deployment must not extract into a half-populated tree
  // from the previous attempt.
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Removes a build directory. Never throws.
 *
 * Called from a `finally`, where a throw would replace the real build error
 * with a cleanup error and lose the reason the deploy failed.
 */
export function removeBuildDir(deploymentId: string): void {
  try {
    rmSync(buildDir(deploymentId), { recursive: true, force: true })
  } catch (err) {
    logger.warn(
      { deploymentId, err: (err as Error).message },
      "could not remove the build directory",
    )
  }
}

/**
 * Removes build directories older than `maxAgeHours`, returning how many went.
 *
 * The backstop for the `finally` above: a SIGKILL, an OOM, or a power loss
 * leaves a directory nothing will otherwise claim. Age-based rather than
 * cross-referenced against the deployments table on purpose — a build directory
 * has no value once its build is over, so "old" is the only question worth
 * asking, and it needs no database read to answer.
 */
export function sweepBuildDirs(maxAgeHours = 24): number {
  if (!existsSync(config.buildsDir)) return 0

  const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000
  let removed = 0

  for (const entry of readdirSync(config.buildsDir)) {
    const dir = resolve(config.buildsDir, entry)
    try {
      const stat = statSync(dir)
      if (!stat.isDirectory() || stat.mtimeMs >= cutoff) continue
      rmSync(dir, { recursive: true, force: true })
      removed++
    } catch (err) {
      // One unreadable entry must not stop the sweep: the next one may be the
      // large directory actually filling the disk.
      logger.warn(
        { dir, err: (err as Error).message },
        "could not sweep a build directory",
      )
    }
  }

  if (removed > 0) logger.info({ removed }, "swept stale build directories")
  return removed
}
