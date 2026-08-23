import { caddy, routeIdFor } from "../caddy/client.ts"
import { docker } from "../docker/impl.ts"
import {
  deleteResource,
  getResource,
  listDomains,
  updateResource,
} from "../db/queries.ts"
import { publishStatus } from "../events.ts"
import { logger } from "../log.ts"
import { dropBuffer } from "../logs/buffer.ts"
import { removeLogFiles } from "../logs/file.ts"
import { stopLogStream } from "../logs/stream.ts"
import { type DeployPayload, runDeploy } from "./deploy.ts"

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
    if (c.labels["mosdash.resource_id"] === resource.id) {
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

  if (payload.deleteRow) deleteResource(resource.id)
  publishStatus({ resourceId: resource.id, state: "stopped" })
}

async function runPrune(payload: PrunePayload): Promise<void> {
  const hours = payload.olderThanHours ?? 168
  const { reclaimedBytes } = await docker.pruneImages(hours)
  logger.info({ reclaimedBytes, hours }, "pruned images")
}

export type JobHandler = (payload: Record<string, unknown>) => Promise<void>

export const handlers: Record<string, JobHandler> = {
  deploy: (p) => runDeploy(p as unknown as DeployPayload),
  stop: (p) => runStop(p as unknown as StopPayload),
  remove: (p) => runRemove(p as unknown as RemovePayload),
  prune_images: (p) => runPrune(p as unknown as PrunePayload),
}
