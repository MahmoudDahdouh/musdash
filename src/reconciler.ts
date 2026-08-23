import { LABEL_MANAGED, LABEL_RESOURCE } from "./docker/client.ts"
import { docker } from "./docker/impl.ts"
import {
  getResource,
  listRunningResources,
  resourceImage,
  updateResource,
} from "./db/queries.ts"
import { publishStatus, type ResourceState } from "./events.ts"
import { enqueueDeploy } from "./jobs/deploy.ts"
import { logger } from "./log.ts"
import { startLogStream } from "./logs/stream.ts"

/**
 * Converges actual state toward desired state every 30 seconds. This is what
 * makes mosdash survive a reboot or a manual `docker rm -f` without anyone
 * touching the dashboard.
 */

const INTERVAL_MS = 30_000
let timer: Timer | null = null

export async function reconcileOnce(): Promise<void> {
  const containers = await docker
    .listManagedContainers()
    .catch((err: unknown) => {
      logger.warn(
        { err: (err as Error).message },
        "reconcile: docker unreachable",
      )
      return null
    })
  if (!containers) return

  const running = listRunningResources()
  const byResource = new Map<string, (typeof containers)[number]>()
  for (const c of containers) {
    const rid = c.labels[LABEL_RESOURCE]
    if (!rid) continue
    // Prefer a running container if several carry the same resource id.
    const existing = byResource.get(rid)
    if (!existing || (c.running && !existing.running)) byResource.set(rid, c)
  }

  // 3. desired-running resources with no live container -> redeploy
  for (const resource of running) {
    const container = byResource.get(resource.id)
    if (container?.running) continue

    const image = resourceImage(resource)
    if (!image) continue
    logger.info(
      { resourceId: resource.id, name: resource.name },
      "reconcile: no running container, redeploying",
    )
    enqueueDeploy(resource.id, image, "reconcile")
  }

  // 4. managed containers with no matching resource row -> orphans
  //
  // This step deletes containers, so it is deliberately conservative: it acts
  // only on containers that carry mosdash.managed=true AND a resource id that
  // is genuinely absent from the database, and it says so in the log before
  // removing anything.
  for (const container of containers) {
    if (container.labels[LABEL_MANAGED] !== "true") continue
    const rid = container.labels[LABEL_RESOURCE]
    if (!rid) continue
    if (getResource(rid)) continue

    logger.warn(
      { container: container.name, resourceId: rid },
      "reconcile: removing orphaned container (no such resource)",
    )
    await docker.stopContainer(container.id, 10).catch(() => {})
    await docker.removeContainer(container.id, true).catch(() => {})
  }

  // 5. refresh live state and broadcast changes
  for (const resource of running) {
    const container = byResource.get(resource.id)
    if (!container?.running) continue

    const state = await docker.inspectContainer(container.id).catch(() => null)
    if (!state) continue

    if (resource.containerId !== container.id) {
      updateResource(resource.id, { containerId: container.id })
    }
    // Re-attach the log stream after a restart; it is a no-op if already live.
    startLogStream(resource.id, container.id)

    const uiState: ResourceState =
      state.health === "unhealthy"
        ? "unhealthy"
        : state.health === "starting"
          ? "deploying"
          : "healthy"
    publishStatus({
      resourceId: resource.id,
      state: uiState,
      health: state.health,
      containerId: container.id,
    })
  }
}

export function startReconciler(): void {
  if (timer) return
  timer = setInterval(() => {
    void reconcileOnce().catch((err: unknown) => {
      logger.error({ err: (err as Error).message }, "reconcile failed")
    })
  }, INTERVAL_MS)
}

export function stopReconciler(): void {
  if (timer) clearInterval(timer)
  timer = null
}
