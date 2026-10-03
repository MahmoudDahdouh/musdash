import { ensureBuildkit } from "../build/bootstrap.ts"
import { removeResourceCache, sweepBuildCache } from "../build/cache.ts"
import { BUILT_IMAGE_TAG } from "../build/images.ts"
import { ensureCaddy } from "../caddy/bootstrap.ts"
import { runApplyDashboardHost } from "./dashboard.ts"
import { caddy, routeIdFor } from "../caddy/client.ts"
import { config } from "../config.ts"
import {
  isStackContainer,
  LABEL_RESOURCE,
  LABEL_ROLE,
} from "../docker/client.ts"
import { docker } from "../docker/impl.ts"
import {
  deleteResource,
  getResource,
  listDomains,
  listProtectedImages,
  updateResource,
} from "../db/queries.ts"
import type { Resource } from "../db/schema.ts"
import { composeProject } from "./compose-plan.ts"
import { compose, deleteResourceRoutes } from "./stack.ts"
import { publishStatus } from "../events.ts"
import { logger } from "../log.ts"
import { dropBuffer } from "../logs/buffer.ts"
import { removeLogFiles } from "../logs/file.ts"
import { stopLogStream } from "../logs/stream.ts"
import { type DeployPayload, runDeploy } from "./deploy.ts"
import { syncResourceRoutes } from "./routes.ts"
import { installSourceFetcher } from "../github/tarball.ts"
import { VolumeRefusedError } from "../volumes/index.ts"
import {
  isStackVolumeName,
  removableKeptVolume,
  stackVolumesToRemove,
} from "../volumes/select.ts"

export interface StopPayload {
  resourceId: string
}

export interface RemovePayload {
  resourceId: string
  deleteRow: boolean
  /**
   * A stack's named volumes go too. Only the boolean `true` deletes: a
   * payload without it — every one queued before S4 — or with any other
   * value keeps every volume, because the safe reading of an unclear choice
   * about data is "keep". Carried in the payload, not read from anywhere
   * else, so a crash and re-run makes the same choice.
   */
  deleteVolumes?: boolean
}

export interface RemoveVolumePayload {
  name: string
}

export interface PrunePayload {
  olderThanHours?: number
}

/**
 * Stops a stack: its routes first, so no visitor is sent to a service that is
 * about to go, then `compose stop` from the labels alone (D65 item 10).
 * Containers, networks and volumes stay, so Deploy brings it back as it was.
 */
async function runComposeStop(resource: Resource): Promise<void> {
  stopLogStream(resource.id)
  await deleteResourceRoutes(resource.id)
  try {
    await compose.stop(composeProject(resource.id), (line) => {
      logger.debug({ resourceId: resource.id, line }, "compose stop")
    })
  } catch (err) {
    // Nothing running means the stop's goal holds whatever Compose said —
    // a stack that never started, or a server whose Compose is missing.
    // Otherwise the job fails and the resource stays desired-running.
    if (await stackRemains(resource.id, true)) throw err
    logger.warn(
      { resourceId: resource.id, err: (err as Error).message },
      "compose stop failed with nothing running; marking stopped",
    )
  }
  updateResource(resource.id, { desiredState: "stopped" })
  publishStatus({ resourceId: resource.id, state: "stopped" })
}

/**
 * Deletes a stack, in the order plan §3.7 gives: routes, then `compose down`
 * (containers and the stack's network), then — only when the user ticked the
 * box — its named volumes, then logs, then the row.
 *
 * `down` never gets `--volumes`: Compose would remove whatever volumes the
 * CURRENT file declares, which is neither the user's choice nor every volume
 * the stack ever had. Volumes go one at a time through the Engine instead,
 * each only after select.ts's label and name rules. Every step repeats safely
 * and the row goes last, so a crash anywhere re-runs this job with the same
 * payload — the same choice about volumes — and finishes what is left. A
 * volume that cannot be removed (one still attached to a container) fails
 * the job with the row still there, so nothing is half-forgotten.
 */
async function runComposeRemove(
  resource: Resource,
  payload: RemovePayload,
): Promise<void> {
  // The delete route already wrote 'stopped', but a deploy that ran ahead of
  // this job writes 'running' when it succeeds. Written again here, so a
  // removal that then fails (a volume in use) never leaves a row the
  // reconciler would redeploy.
  if (payload.deleteRow)
    updateResource(resource.id, { desiredState: "stopped" })
  stopLogStream(resource.id)
  await deleteResourceRoutes(resource.id)
  try {
    await compose.down(composeProject(resource.id), (line) => {
      logger.debug({ resourceId: resource.id, line }, "compose down")
    })
  } catch (err) {
    // A stack that never started — or a server whose Compose is missing —
    // has nothing for `down` to do, and must still be deletable. Anything
    // else fails the job, so the row stays and the delete can be retried.
    // A network left behind is the reconciler's orphan sweep's.
    if (await stackRemains(resource.id, false)) throw err
    logger.warn(
      { resourceId: resource.id, err: (err as Error).message },
      "compose down failed with no containers left; deleting anyway",
    )
  }
  if (payload.deleteVolumes === true) await removeStackVolumes(resource.id)
  dropBuffer(resource.id)
  removeLogFiles(resource.id)
  if (payload.deleteRow) deleteResource(resource.id)
  publishStatus({ resourceId: resource.id, state: "stopped" })
}

/**
 * Removes the stack's named volumes, after `down` has taken its containers.
 * A list that cannot be read throws, failing the job: it is never taken as
 * "nothing to delete", which would let the row go and orphan the data
 * silently. The first removal that fails throws too, for the same reason.
 */
async function removeStackVolumes(resourceId: string): Promise<void> {
  const list = await docker.listVolumes({
    labelKey: LABEL_RESOURCE,
    labelValue: resourceId,
  })
  const { remove, skipped } = stackVolumesToRemove(list, resourceId)
  for (const v of skipped) {
    logger.warn(
      { resourceId, volume: v.name },
      "volume carries this resource's id but fails the stack-volume rules; left in place",
    )
  }
  for (const v of remove) {
    await docker.removeVolume(v.name)
    logger.info({ resourceId, volume: v.name }, "removed stack volume")
  }
}

/**
 * Whether any of the stack's containers exist (or, with `runningOnly`, run).
 * A list that cannot be read counts as "yes": the caller then fails the job
 * rather than assume a stack is gone.
 */
async function stackRemains(
  resourceId: string,
  runningOnly: boolean,
): Promise<boolean> {
  const list = await docker.listManagedContainers().catch(() => null)
  if (list === null) return true
  return list.some(
    (c) =>
      isStackContainer(c.labels) &&
      c.labels[LABEL_RESOURCE] === resourceId &&
      (!runningOnly || c.running),
  )
}

async function runStop(payload: StopPayload): Promise<void> {
  const resource = getResource(payload.resourceId)
  if (!resource) return
  if (resource.kind === "compose") return runComposeStop(resource)

  stopLogStream(resource.id)
  if (resource.containerId) {
    await docker.stopContainer(resource.containerId, 10).catch(() => {})
  }
  // A stopped resource has no route. Leaving it would point its domains at a
  // dead address until the next deploy; syncResourceRoutes would remove it at
  // the next bootstrap anyway, and the queue is where the proxy is changed.
  await caddy.deleteRoute(routeIdFor(resource.id)).catch((err: unknown) => {
    logger.warn(
      { resourceId: resource.id, err: (err as Error).message },
      "could not delete the Caddy route",
    )
  })
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
  if (resource.kind === "compose") return runComposeRemove(resource, payload)

  // As for a stack: a deploy ahead of this job may have written 'running'.
  if (payload.deleteRow)
    updateResource(resource.id, { desiredState: "stopped" })
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
    // Never a stack service: those are `compose down`'s to remove.
    if (isStackContainer(c.labels)) continue
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

/**
 * Deletes one volume left behind by a deleted stack (the Settings list).
 *
 * The route checked the name already, but the job checks everything again
 * against the daemon's labels as they are NOW: a job waits in the queue, and
 * a payload is only as trustworthy as whatever inserted it. The volume must
 * be a stack volume by name and labels, and its resource must be gone — a
 * live stack's data is never removed from here. A refusal fails the job with
 * the reason in last_error; a volume already gone is success.
 */
async function runRemoveVolume(payload: RemoveVolumePayload): Promise<void> {
  const name: unknown = payload.name
  if (typeof name !== "string" || !isStackVolumeName(name)) {
    throw new VolumeRefusedError("refused: not a stack volume name")
  }
  // A list that cannot be read throws and fails the job; it must never read
  // as "gone".
  const list = await docker.listVolumes({ labelKey: LABEL_RESOURCE })
  const volume = list.find((v) => v.name === name)
  if (!volume) {
    logger.info(
      { volume: name },
      "no musdash stack volume by that name; nothing to remove",
    )
    return
  }
  const hasRow = (id: string): boolean => getResource(id) !== undefined
  if (!removableKeptVolume(list, name, hasRow)) {
    const owner = volume.labels[LABEL_RESOURCE]
    throw new VolumeRefusedError(
      typeof owner === "string" && hasRow(owner)
        ? `refused to remove ${name}: its resource still exists`
        : `refused to remove ${name}: its labels do not mark it as a musdash stack volume`,
    )
  }
  await docker.removeVolume(name)
  logger.info({ volume: name }, "removed a kept stack volume")
}

async function runPrune(payload: PrunePayload): Promise<void> {
  const hours = payload.olderThanHours ?? 168
  const keep = listProtectedImages()
  // musdash's own builds leave on the keep-set's terms, not the age cutoff:
  // retention per resource is already bounded there, and anything outside it —
  // superseded, failed, or belonging to a deleted resource — exists nowhere a
  // user could want it back from (D60).
  const { reclaimedBytes, protectedCount } = await docker.pruneImages(
    hours,
    keep,
    BUILT_IMAGE_TAG,
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
  remove_volume: (p) => runRemoveVolume(p as unknown as RemoveVolumePayload),
  prune_images: (p) => runPrune(p as unknown as PrunePayload),
  // No payload: the cap comes from config, so a job queued before an operator
  // changed it must not run against the value that was current when it was.
  prune_build_cache: async () => runPruneBuildCache(),
  ensure_caddy: () => ensureCaddy(),
  // No payload either: the hostname comes from the settings row, so a job
  // queued before the operator changed it must not run against the old value.
  apply_dashboard_host: async () => runApplyDashboardHost(),
  ensure_buildkit: () => ensureBuildkit(),
  // No payload: the routes come from the database as it is when this runs.
  sync_routes: () => syncResourceRoutes(),
}
