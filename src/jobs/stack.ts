import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { caddy, isRouteOfResource } from "../caddy/client.ts"
import { config } from "../config.ts"
import {
  isStackContainer,
  LABEL_RESOURCE,
  LABEL_SERVICE,
  type ManagedContainer,
} from "../docker/client.ts"
import { composeCli, composeHome } from "../docker/compose.ts"
import { docker } from "../docker/impl.ts"
import { logger } from "../log.ts"

/**
 * What the stack deploy, stop, remove, the scheduler and boot share: the one
 * ComposeCli, the temporary directories, and the resource's containers and
 * routes.
 */

/** The process's one Compose CLI, behind the Docker seam. */
export const compose = composeCli(docker)

/** Where each deploy writes its interpolated file; deleted after use (§3.2). */
export function composeTmpRoot(): string {
  return resolve(config.dataDir, "compose", "tmp")
}

/**
 * The temporary directory of one deploy. The id is a ULID from musdash's own
 * generator, but it is still checked before it is joined onto a path that is
 * later removed recursively: an id carrying `..` would escape the root.
 */
export function composeTmpDir(deploymentId: string): string {
  if (!/^[0-9A-Za-z]{1,64}$/.test(deploymentId)) {
    throw new Error(`unsafe deployment id for a Compose directory`)
  }
  return resolve(composeTmpRoot(), deploymentId)
}

/** Removes a deploy's temporary directory. Never throws: it runs in finally. */
export function removeComposeTmpDir(deploymentId: string): void {
  try {
    rmSync(composeTmpDir(deploymentId), { recursive: true, force: true })
  } catch (err) {
    logger.warn(
      { deploymentId, errorName: err instanceof Error ? err.name : typeof err },
      "could not remove a Compose temporary directory",
    )
  }
}

/**
 * Removes temporary directories older than `maxAgeMs` (0: all of them), and
 * returns how many went. They hold interpolated secrets, so a SIGKILL
 * mid-deploy must not leave one on disk: boot sweeps them all before the
 * worker starts, and the daily housekeeping sweeps any older than an hour.
 */
export function sweepComposeTmp(maxAgeMs: number): number {
  const root = composeTmpRoot()
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return 0
  }
  const cutoff = Date.now() - maxAgeMs
  let removed = 0
  for (const entry of entries) {
    const dir = resolve(root, entry)
    try {
      if (maxAgeMs > 0 && statSync(dir).mtimeMs >= cutoff) continue
      rmSync(dir, { recursive: true, force: true })
      removed++
    } catch (err) {
      logger.warn(
        { dir, errorName: err instanceof Error ? err.name : typeof err },
        "could not sweep a Compose temporary directory",
      )
    }
  }
  if (removed > 0) {
    logger.info({ removed }, "swept Compose temporary directories")
  }
  return removed
}

/**
 * At boot, before the worker can start a deploy: every temporary directory
 * is a leftover, and the Compose directories exist with their modes.
 */
export function prepareComposeDirs(): void {
  sweepComposeTmp(0)
  for (const dir of [resolve(config.dataDir, "compose"), composeTmpRoot()]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  mkdirSync(composeHome(), { recursive: true, mode: 0o700 })
}

/**
 * A resource's stack containers by service, from one container list. Where
 * two carry the same service — a leftover beside its replacement — the
 * running one wins.
 */
export function stackContainersOf(
  containers: readonly ManagedContainer[],
  resourceId: string,
): Map<string, ManagedContainer> {
  const out = new Map<string, ManagedContainer>()
  for (const c of containers) {
    if (!isStackContainer(c.labels)) continue
    if (c.labels[LABEL_RESOURCE] !== resourceId) continue
    const service = c.labels[LABEL_SERVICE]
    if (service === undefined) continue
    const existing = out.get(service)
    if (!existing || (c.running && !existing.running)) out.set(service, c)
  }
  return out
}

/**
 * Deletes every route of a resource — its own and each service's. Best-effort
 * per route, like the other route deletions: a missing route is the goal.
 */
export async function deleteResourceRoutes(
  resourceId: string,
  keep: ReadonlySet<string> = new Set(),
): Promise<void> {
  let ids: string[]
  try {
    ids = await caddy.listRouteIds()
  } catch (err) {
    logger.warn(
      { resourceId, err: (err as Error).message },
      "could not list Caddy routes to remove a resource's",
    )
    return
  }
  for (const id of ids) {
    if (!isRouteOfResource(id, resourceId) || keep.has(id)) continue
    await caddy.deleteRoute(id).catch((err: unknown) => {
      logger.warn(
        { resourceId, route: id, err: (err as Error).message },
        "could not delete the Caddy route",
      )
    })
  }
}
