import { CADDY_CONTAINER } from "./caddy/bootstrap.ts"
import { caddy } from "./caddy/client.ts"
import { LABEL_MANAGED, LABEL_RESOURCE, LABEL_ROLE } from "./docker/client.ts"
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
import { enqueue } from "./queue/index.ts"

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
    // Infrastructure mosdash runs for itself (the proxy) is managed but is not
    // a resource, so it can never be an orphan. This check is explicit and
    // comes first on purpose: the resource-id check below happens to spare it
    // today, and relying on that coincidence is one refactor away from the
    // reconciler force-removing its own Caddy every 30 seconds and taking every
    // site on the box offline.
    if (container.labels[LABEL_ROLE]) continue
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

  await ensureCaddyQueued()

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

/**
 * Re-queues the proxy bootstrap when the proxy is not running. This is what
 * makes `docker rm -f mosdash-caddy` heal itself.
 *
 * The job id is derived rather than random, so a proxy that stays down does not
 * queue a fresh job every 30 seconds and starve real deploys behind them —
 * concurrency is exactly 1. `enqueue` inserts without OR IGNORE, so a duplicate
 * id raises a primary-key conflict; here that conflict IS the answer ("already
 * queued"), and swallowing it is required or every tick throws while the proxy
 * is down.
 *
 * The id carries a time bucket because finished jobs stay in the table until
 * the daily prune. A single constant id would collide with its own completed
 * row forever and the self-heal would fire exactly once in the process's life.
 * One bucket is long enough to collapse a burst of ticks, short enough that a
 * proxy killed later still gets a new job.
 */
const CADDY_JOB_BUCKET_MS = 5 * 60 * 1000

function caddyJobId(): string {
  return `ensure-caddy-${Math.floor(Date.now() / CADDY_JOB_BUCKET_MS)}`
}

/**
 * Queues the proxy bootstrap, tolerating a row this bucket already has.
 *
 * Called at boot and whenever the reconciler finds no running proxy. Both share
 * the bucketed id, so a startup reconcile that already queued one is not doubled
 * up on — a second bootstrap job would occupy the single worker while the
 * startup deploys behind it wait.
 */
export function queueCaddyBootstrap(): void {
  try {
    enqueue("ensure_caddy", {}, { id: caddyJobId(), maxAttempts: 1 })
  } catch (err) {
    // A primary-key conflict IS the answer here: the bucket already holds a row
    // — pending, leased, done, or failed — so there is nothing to queue.
    // Anything else (the database is locked, the disk is full) is a real
    // failure and must not vanish. Swallowing it hides the proxy never being
    // queued at all, which reaches the operator as "no site loads, and nothing
    // in the log".
    const code = (err as { code?: unknown }).code
    const message = (err as Error).message
    const isConflict =
      (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT")) ||
      /constraint failed/i.test(message)
    if (!isConflict) {
      logger.error({ err: message }, "could not queue the Caddy bootstrap")
    }
  }
}

/**
 * Re-queues the proxy bootstrap when the proxy is not answering.
 *
 * Gating on the Docker running flag alone was the readiness false positive one
 * layer up: Caddy exits and restarts when it cannot bind, and a wedged Caddy
 * keeps its container running, so "running" reads true in states where nothing
 * is served — and the bootstrap, the only thing that can repair it, was never
 * re-queued.
 *
 * The second gate is deliberately ping() rather than the full serving probe.
 * This runs every 30 seconds forever, so it must be cheap and must not flap;
 * ping() is bounded at 5s, it catches the restart-loop and wedged-process
 * cases, and re-enqueueing is idempotent thanks to the bucketed id. The
 * bootstrap does the thorough diagnosis once it is queued.
 */
async function ensureCaddyQueued(): Promise<void> {
  const found = await docker.findContainersByName(CADDY_CONTAINER).catch(() => {
    // Docker being unreachable is already reported by the caller above.
    return null
  })
  if (!found) return

  if (!found.some((c) => c.running)) {
    logger.info("reconcile: Caddy is not running, queueing bootstrap")
    queueCaddyBootstrap()
    return
  }

  if (!(await caddy.ping())) {
    logger.warn(
      "reconcile: Caddy is running but its admin API does not answer, queueing bootstrap",
    )
    queueCaddyBootstrap()
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
