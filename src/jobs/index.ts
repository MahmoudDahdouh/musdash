import { ensureBuildkit } from "../build/bootstrap.ts"
import { removeResourceCache, sweepBuildCache } from "../build/cache.ts"
import { ensureCaddy } from "../caddy/bootstrap.ts"
import { caddy, routeIdFor } from "../caddy/client.ts"
import { config } from "../config.ts"
import { LABEL_RESOURCE, LABEL_ROLE } from "../docker/client.ts"
import { docker } from "../docker/impl.ts"
import {
  deleteResource,
  getResource,
  listDomains,
  listProtectedImages,
  updateResource,
} from "../db/queries.ts"
import { publishStatus } from "../events.ts"
import { logger } from "../log.ts"
import { dropBuffer } from "../logs/buffer.ts"
import { removeLogFiles } from "../logs/file.ts"
import { stopLogStream } from "../logs/stream.ts"
import { type DeployPayload, runDeploy } from "./deploy.ts"
import { installSourceFetcher } from "../github/tarball.ts"

export interface StopPayload {
  resourceId: string
}

export interface RemovePayload {
  resourceId: string
  deleteRow: boolean
}

export interface PrunePayload {
  olderThanHours?: number
}

async function runStop(payload: StopPayload): Promise<void> {
  const resource = getResource(payload.resourceId)
  if (!resource) return

  stopLogStream(resource.id)
  if (resource.containerId) {
    await docker.stopContainer(resource.containerId, 10).catch(() => {})
  }
  updateResource(resource.id, { desiredState: "stopped" })
  publishStatus({ resourceId: resource.id, state: "stopped" })
}

/**
 * Deletes a resource in an order that a crash can be resumed from.
 *
 * Container first, then the route, then the row. Deleting the row first would
 * orphan the container and the route with nothing left to identify them by —
 * the reconciler could find the container by its labels, but the Caddy route
 * would linger forever.
 */
async function runRemove(payload: RemovePayload): Promise<void> {
  const resource = getResource(payload.resourceId)
  if (!resource) return

  stopLogStream(resource.id)

  if (resource.containerId) {
    await docker.stopContainer(resource.containerId, 10).catch(() => {})
    await docker.removeContainer(resource.containerId, true).catch(() => {})
  }

  // Any other container still labelled with this resource (a failed deploy).
  const strays = await docker.listManagedContainers().catch(() => [])
  for (const c of strays) {
    // Never a sidecar. Explicit and ahead of the resource-id comparison on
    // purpose: today a role container carries no resource id so the comparison
    // below spares it by accident, but deleting a resource must never be able
    // to take down the shared proxy and every site with it.
    if (c.labels[LABEL_ROLE]) continue
    if (c.labels[LABEL_RESOURCE] === resource.id) {
      await docker.removeContainer(c.id, true).catch(() => {})
    }
  }

  await caddy.deleteRoute(routeIdFor(resource.id)).catch((err: unknown) => {
    logger.warn(
      { resourceId: resource.id, err: (err as Error).message },
      "could not delete the Caddy route",
    )
  })

  for (const domain of listDomains(resource.id)) {
    logger.debug({ host: domain.host }, "released domain")
  }

  dropBuffer(resource.id)
  removeLogFiles(resource.id)

  if (payload.deleteRow) {
    // Gated with the row, not run unconditionally: a caller that removes the
    // container while keeping the resource still wants its layer cache, and
    // throwing it away would make the next deploy cold for no reason. It has to
    // happen before the row goes, though — afterwards the directory is
    // identifiable only as an orphan, which is a daily sweep away rather than
    // immediate. Not part of the container/route/row ordering above, which
    // exists so a crash can be resumed from.
    removeResourceCache(resource.id)
    deleteResource(resource.id)
  }
  publishStatus({ resourceId: resource.id, state: "stopped" })
}

async function runPrune(payload: PrunePayload): Promise<void> {
  const hours = payload.olderThanHours ?? 168
  const keep = listProtectedImages()
  const { reclaimedBytes, protectedCount } = await docker.pruneImages(
    hours,
    keep,
  )
  logger.info({ reclaimedBytes, protectedCount, hours }, "pruned images")
}

/**
 * Keeps the layer cache under MUSDASH_BUILD_CACHE_GB.
 *
 * On the queue rather than inline in the scheduler because the sizing walk is
 * synchronous over tens of thousands of blobs; inline it would block the event
 * loop and stall the dashboard and its log streams. Here the only thing it
 * delays is the queue, which already absorbs multi-minute builds.
 */
function runPruneBuildCache(): void {
  const { orphansRemoved, evicted, keptBytes } = sweepBuildCache()
  logger.info(
    { orphansRemoved, evicted, keptBytes, capGb: config.buildCacheGb },
    "pruned the build cache",
  )
}

// Repository source arrives over the GitHub API from here on. Wired at the
// job layer because that is where the fetcher's only consumer lives, and
// explicitly rather than as an import side effect.
installSourceFetcher()

export type JobHandler = (payload: Record<string, unknown>) => Promise<void>

export const handlers: Record<string, JobHandler> = {
  deploy: (p) => runDeploy(p as unknown as DeployPayload),
  stop: (p) => runStop(p as unknown as StopPayload),
  remove: (p) => runRemove(p as unknown as RemovePayload),
  prune_images: (p) => runPrune(p as unknown as PrunePayload),
  // No payload: the cap comes from config, so a job queued before an operator
  // changed it must not run against the value that was current when it was.
  prune_build_cache: async () => runPruneBuildCache(),
  ensure_caddy: () => ensureCaddy(),
  ensure_buildkit: () => ensureBuildkit(),
}
