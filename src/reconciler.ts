import { BUILDKIT_CONTAINER } from "./build/bootstrap.ts"
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

/** Whether the current BuildKit outage has already been logged. Reset when it
 *  comes back, so a later outage is reported again. */
let buildkitReported = false

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

    // For a git resource this is the last image that was BUILT, and the
    // "reconcile" trigger marks the job as deploy-this-image-verbatim. A
    // reconcile must never rebuild from source: this runs every 30 seconds, and
    // a flaky daemon would otherwise start a fresh build each time.
    const image = resourceImage(resource)
    // Empty for a git resource that has never built successfully. There is
    // nothing to redeploy, and building here would race the deploy that is
    // presumably already failing.
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
  await ensureBuildkitQueued()

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
 * A shorter bucket than the proxy's, deliberately.
 *
 * The bucket exists to stop a burst of ticks queueing a job each, but it also
 * sets the blind window: once a bucket holds a finished row, the id collides
 * with it and nothing can be re-queued until the bucket rolls over. Five
 * minutes is right for a proxy that almost never dies and whose bootstrap is
 * expensive. A build daemon is different — it is removed routinely (a prune, an
 * upgrade, an operator clearing disk), and while it is down nothing that is
 * already serving is affected. Waiting five minutes to notice is the wrong
 * trade; one minute collapses a tick burst just as well and bounds the blind
 * window to two reconcile passes.
 */
const BUILDKIT_JOB_BUCKET_MS = 60 * 1000

function buildkitJobId(): string {
  return `ensure-buildkit-${Math.floor(Date.now() / BUILDKIT_JOB_BUCKET_MS)}`
}

/**
 * Whether an enqueue error is the primary-key conflict that means "this bucket
 * already holds a row" rather than a genuine failure like a locked database or
 * a full disk. The message fallback covers drivers that do not set `code`.
 */
function isConflict(err: unknown): boolean {
  const code = (err as { code?: unknown }).code
  return (
    (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT")) ||
    /constraint failed/i.test((err as Error).message)
  )
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
    if (!isConflict(err)) {
      logger.error(
        { err: (err as Error).message },
        "could not queue the Caddy bootstrap",
      )
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

/**
 * Queues the build-daemon bootstrap, tolerating a row this bucket already has.
 *
 * Its own bucket key, deliberately not shared with the proxy's: the two heal
 * independently, and a single key would mean a proxy failure suppressing the
 * build daemon's recovery for five minutes.
 */
export function queueBuildkitBootstrap(): void {
  try {
    enqueue("ensure_buildkit", {}, { id: buildkitJobId(), maxAttempts: 1 })
  } catch (err) {
    // A primary-key conflict IS the answer: the bucket already holds a row.
    // Anything else is a real failure and must not vanish.
    if (!isConflict(err)) {
      logger.error(
        { err: (err as Error).message },
        "could not queue the BuildKit bootstrap",
      )
    }
  }
}

/**
 * Queues both sidecar bootstraps at boot.
 *
 * One call rather than two at the call site: `src/index.ts` wires modules
 * together and is capped at 60 lines, and which sidecars mosdash runs for itself
 * is this module's business, not the entry point's.
 */
export function queueSidecarBootstraps(): void {
  queueCaddyBootstrap()
  queueBuildkitBootstrap()
}

/**
 * Re-queues the build daemon when it is not reachable.
 *
 * Gated on an actual connection rather than the Docker running flag, for the
 * reason the proxy's gate is: a daemon in a bind-failure restart loop, or one
 * wedged with a dead listener, reads as running — so the bootstrap, the only
 * thing that can repair it, would never be re-queued.
 *
 * Unlike the proxy, a build daemon being down breaks nothing that is already
 * serving. It is logged at info, not warn, and is not an outage.
 */
async function ensureBuildkitQueued(): Promise<void> {
  const found = await docker
    .findContainersByName(BUILDKIT_CONTAINER)
    .catch(() => null)
  if (!found) return

  if (found.some((c) => c.running)) {
    buildkitReported = false
    return
  }

  // Logged once per outage, not once per tick. The bucketed job id means a
  // bootstrap that already ran in this five-minute window cannot be re-queued
  // until the bucket rolls over, so an unguarded log line here repeats every 30
  // seconds while nothing is actually happening — noise that buries the one
  // line an operator needs.
  if (!buildkitReported) {
    logger.info("reconcile: BuildKit is not running, queueing bootstrap")
    buildkitReported = true
  }
  queueBuildkitBootstrap()
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
