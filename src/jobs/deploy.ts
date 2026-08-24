import { autoDomainFor, caddy, routeIdFor } from "../caddy/client.ts"
import { buildFromSource } from "./build.ts"
import { config } from "../config.ts"
import { LABEL_RESOURCE, LABEL_ROLE, managedLabels } from "../docker/client.ts"
import { docker } from "../docker/impl.ts"
import {
  createDeployment,
  deleteDeployment,
  getDecryptedEnvVars,
  getDeployment,
  getResourceContext,
  listDomains,
  markDeploymentFailed,
  updateDeployment,
  updateResource,
} from "../db/queries.ts"
import {
  publishDeployLog,
  publishDeployment,
  publishStatus,
} from "../events.ts"
import { nowIso, shortId } from "../ids.ts"
import { logger, redactGithub, redactValues } from "../log.ts"
import { enqueue } from "../queue/index.ts"
import { startLogStream, stopLogStream } from "../logs/stream.ts"

export interface DeployPayload {
  resourceId: string
  deploymentId: string
  image: string
  /**
   * Deploy the image named above verbatim, without building it.
   *
   * Set for exactly the triggers in REUSES_IMAGE, which name an image that
   * already exists locally. Without it a git resource would rebuild from source
   * on rollback — defeating the button entirely, since the point is to return
   * to the artifact that was running — and the reconciler would rebuild from
   * source every time Docker hiccuped.
   *
   * The inverse matters just as much: a trigger that has no image yet must NOT
   * set this, or the deploy tries to pull the placeholder tag the row was
   * created with. See REUSES_IMAGE.
   */
  useExistingImage?: boolean
}

/** How long to let the old container finish in-flight requests. */
const DRAIN_MS = 10_000

export function containerName(
  resourceId: string,
  deploymentId: string,
): string {
  return `mosdash-${shortId(resourceId)}-${shortId(deploymentId)}`
}

/**
 * The deploy pipeline.
 *
 * The ordering at the end is the product's core guarantee and must not be
 * rearranged: the new container is verified healthy, THEN the route is
 * switched, THEN the old container is drained and stopped. Any other order
 * still produces a deploy that looks like it works — it just drops requests
 * every time, and nobody notices until production.
 */
export async function runDeploy(payload: DeployPayload): Promise<void> {
  const { resourceId, deploymentId } = payload
  // Reassigned for a git resource, whose real tag is not known until it builds.
  let image = payload.image
  const ctx = getResourceContext(resourceId)
  if (!ctx) throw new Error(`resource ${resourceId} no longer exists`)
  const { resource, environment, project } = ctx

  // Secrets are decrypted here and must never reach a log line — not on the
  // happy path, not in an error message, not in the deploy stream.
  const env = getDecryptedEnvVars(resourceId)
  const secrets = Object.values(env)
  // Two layers, because they catch different things: redactValues matches the
  // env values known for this resource, while redactGithub pattern-matches
  // credentials minted at runtime — an installation token belongs to no known
  // set and would otherwise print verbatim.
  const safe = (text: string) => redactGithub(redactValues(text, secrets))

  // Redaction lives in emit itself, which is the single point every deploy log
  // line passes through — build output, status lines and error messages alike.
  // Applying it only at individual call sites is one forgotten call away from
  // publishing a secret, and this stream is shown in the browser.
  const emit = (text: string) => {
    publishDeployLog(deploymentId, safe(text))
  }

  const oldContainerId = resource.containerId
  let newContainerId: string | null = null
  // Whether the route switch was entered, and whether it finished. The failure
  // cleanup differs entirely between the two, so they are tracked separately.
  let routeSwitchAttempted = false
  let routeSwitched = false

  // What is genuinely running right now. The resource row cannot be trusted for
  // this: editing the image in Settings writes the NEW image to the row before
  // this job runs, so reading it here would report the incoming image as the
  // outgoing one and rollback would have nothing to roll back to.
  const outgoingImage = await currentImageOf(oldContainerId)

  try {
    // 1. mark running
    updateDeployment(deploymentId, { status: "running", startedAt: nowIso() })
    publishDeployment({ deploymentId, resourceId, status: "running" })
    publishStatus({ resourceId, state: "deploying" })
    emit(`Deploying ${image}`)

    // 2. network
    await docker.ensureNetwork(config.network)
    emit(`Network ${config.network} ready`)

    // 2b. reclaim containers a previous attempt left behind.
    //
    // A deploy whose route switch failed deliberately keeps its healthy
    // container (the old one is still serving, so destroying the new one would
    // throw away work), and the resource row is never repointed at it. Nothing
    // else collects it: the orphan sweep skips containers whose resource row
    // still exists, so without this they accumulate one per failed attempt.
    await reclaimStrays(resourceId, oldContainerId, emit)

    // 3. obtain the image: build it from source, or pull it.
    //
    // The ONLY structural change for git resources. Everything from step 4 on
    // is identical for both kinds, which is deliberate: the zero-downtime
    // ordering below is the product's core guarantee, and a second copy of it
    // for git resources would be a second place for it to rot.
    if (resource.kind === "git" && !payload.useExistingImage) {
      const built = await buildFromSource(resource, deploymentId, emit, env)
      image = built.image
      // The deployment row is created before the tag exists, so it holds the
      // placeholder the enqueue used until now.
      //
      // Commit metadata is written here rather than at enqueue time for two
      // reasons: resolving it in the HTTP handler would put a GitHub call in a
      // request path, and it would record the commit that was current when the
      // button was pressed rather than the one this build actually used.
      updateDeployment(deploymentId, {
        image,
        ...(built.commit
          ? {
              commitSha: built.commit.sha,
              commitMessage: built.commit.message,
              commitAuthor: built.commit.author,
            }
          : {}),
      })
    } else {
      await resolveImage(image, emit, safe)
    }

    // 4/5. create the new container alongside the old one
    const name = containerName(resourceId, deploymentId)
    emit(`Creating container ${name}`)
    newContainerId = await docker.createContainer({
      name,
      image,
      env,
      labels: managedLabels({
        resourceId,
        deploymentId,
        projectId: project.id,
      }),
      networks: [config.network],
      volumes: [],
      memoryLimitBytes: resource.memoryLimitMb * 1024 * 1024,
      restartPolicy: "unless-stopped",
    })

    // 6. start
    await docker.startContainer(newContainerId)
    emit("Container started, waiting for health...")

    // 7. health gate
    await healthGate(
      newContainerId,
      resource.containerPort,
      resource.healthPath,
      emit,
    )
    emit("Health check passed")

    // 8a. switch the route BEFORE touching the old container
    const hosts = listDomains(resourceId).map((d) => d.host)
    const auto = autoDomainFor(resource.name, environment.name)
    if (auto && !hosts.includes(auto)) hosts.push(auto)

    if (hosts.length > 0 && resource.containerPort) {
      const state = await docker.inspectContainer(newContainerId)
      const upstream = `${state.ipAddress}:${resource.containerPort}`
      // Flipped immediately before the Caddy call itself, not before the block:
      // everything above this line fails while nothing points at the new
      // container, so it is still safe to remove. Only once the swap is in play
      // does keeping it become the right cleanup, and the two are opposites.
      routeSwitchAttempted = true
      await caddy.upsertRoute({
        id: routeIdFor(resourceId),
        hosts,
        upstream,
      })
      emit(`Route switched to ${upstream} for ${hosts.join(", ")}`)
    } else if (hosts.length > 0) {
      emit("No container port set — skipping route (set one to expose it)")
    }
    // Only reached if nothing above threw; a failure propagates to the outer
    // catch, which knows to keep the healthy container rather than remove it.
    routeSwitched = true

    // 8b. only now is the old container expendable.
    //
    // Gated on the route switch having SUCCEEDED as well as on there being a
    // distinct old container. Stopping the old one while traffic still points
    // at it is the exact outage the zero-downtime guarantee exists to prevent,
    // and an unreachable Caddy is precisely when that mistake would be made.
    if (routeSwitched && oldContainerId && oldContainerId !== newContainerId) {
      emit(`Draining old container for ${DRAIN_MS / 1000}s...`)
      await Bun.sleep(DRAIN_MS)
      stopLogStream(resourceId)
      await docker.stopContainer(oldContainerId, 10).catch(() => {})
      await docker.removeContainer(oldContainerId, true).catch(() => {})
      emit("Old container removed")
    }

    // 8c. record success
    updateResource(resourceId, {
      containerId: newContainerId,
      currentDeploymentId: deploymentId,
      desiredState: "running",
      // sourceJson describes what the resource is built or pulled FROM, so it
      // is rewritten only for an IMAGE resource. Writing a tag there for a git
      // resource destroys the repository spec, and the resource then reads as
      // an image resource on its next deploy and silently stops rebuilding.
      //
      // Keyed on resource.kind, NOT on whether this deploy built something: a
      // rollback or a reconcile of a git resource deploys an existing tag
      // without building, and keying on that clobbered sourceJson on exactly
      // those paths. Found by rolling back a git resource and reading the row.
      ...(resource.kind === "git"
        ? { builtImage: image }
        : { sourceJson: JSON.stringify({ image }) }),
      // Only remember a genuinely different previous image, so rollback never
      // points at the image already running.
      previousImage:
        outgoingImage && outgoingImage !== image
          ? outgoingImage
          : resource.previousImage,
    })
    updateDeployment(deploymentId, {
      status: "succeeded",
      finishedAt: nowIso(),
    })
    publishDeployment({ deploymentId, resourceId, status: "succeeded" })
    publishStatus({
      resourceId,
      state: "healthy",
      containerId: newContainerId,
    })
    emit("Deploy succeeded")

    startLogStream(resourceId, newContainerId)
  } catch (err) {
    const message = safe((err as Error).message)
    logger.error({ resourceId, deploymentId, err: message }, "deploy failed")

    // 9. clean up, and what that means depends on how far the deploy got.
    //
    // Before the route switch (pull, create, start, health gate) the new
    // container is useless: nothing points at it and nothing ever did, so
    // removing it is right.
    //
    // The route switch itself failing is a different situation. The container
    // is HEALTHY — it passed the gate — and only the proxy update failed, which
    // an unreachable or misconfigured Caddy causes routinely. Destroying it
    // there would throw away good work and, with the reconciler redeploying
    // every 30 seconds, do it again on a loop. Keep it, and say plainly that
    // traffic has not moved.
    //
    // The resource row is deliberately NOT pointed at the kept container (8c
    // runs only on success). The reconciler therefore still sees the OLD
    // container running and matching the row, and leaves it alone — no
    // redeploy loop.
    if (newContainerId && !routeSwitchAttempted) {
      await docker.removeContainer(newContainerId, true).catch(() => {})
      emit("Removed the failed container; the previous one is still serving")
    } else if (newContainerId) {
      emit(
        "The new container is healthy but the route could not be switched, so traffic is unchanged. " +
          "The container was kept; check that Caddy is running, then deploy again.",
      )
    }
    markDeploymentFailed(deploymentId, message)
    publishDeployment({ deploymentId, resourceId, status: "failed" })
    publishStatus({
      resourceId,
      state: oldContainerId ? "healthy" : "failed",
      containerId: oldContainerId,
    })
    emit(`Deploy failed: ${message}`)
    throw err
  }
}

/**
 * Makes the image available locally, preferring a fresh pull.
 *
 * An image built on the box and never pushed anywhere is a legitimate source:
 * `POST /images/create` 404s for it, so an unconditional pull made those
 * resources undeployable.
 *
 * The gate is `imageExists`, deliberately NOT the pull's 404 status. A private
 * image whose registry credentials have lapsed also 404s, and so does a typo'd
 * tag that happens to be absent from the registry. Branching on the status
 * would silently deploy whatever stale copy of that name is sitting in the
 * local store while the user believes they got the registry's current one —
 * exactly the failure this is written to prevent. Asking the daemon "do I
 * actually hold this?" answers the only question that matters, and the log line
 * says plainly that the image was not refreshed.
 *
 * Any pull error qualifies, not just a 404: the Engine also reports failures
 * inside the 200 progress stream, and an unreachable daemon throws too. If the
 * existence probe itself fails, the ORIGINAL pull error is what surfaces — the
 * probe must never mask the reason the pull failed.
 */
async function resolveImage(
  image: string,
  emit: (s: string) => void,
  safe: (s: string) => string,
): Promise<void> {
  emit(`Pulling ${image}...`)
  try {
    await docker.pullImage(image, (line) => emit(safe(line)))
    emit("Image pulled")
    return
  } catch (pullError) {
    let local = false
    try {
      local = await docker.imageExists(image)
    } catch {
      throw pullError
    }
    if (!local) throw pullError

    const reason = safe((pullError as Error).message)
    emit(
      `Pull of ${image} failed (${reason}) — using the local image, which will not be refreshed from a registry`,
    )
  }
}

/**
 * Removes containers belonging to this resource that are neither the one
 * currently serving nor a sidecar.
 *
 * Only failed attempts leave these behind, so on the common path the loop finds
 * nothing. Best-effort throughout: a deploy must not fail because a leftover
 * from a previous attempt could not be removed.
 */
async function reclaimStrays(
  resourceId: string,
  keepContainerId: string | null,
  emit: (s: string) => void,
): Promise<void> {
  const containers = await docker.listManagedContainers().catch(() => [])
  for (const c of containers) {
    // Never a sidecar — see the identical guard in the reconciler's orphan
    // sweep. A resource deploy must not be able to remove the shared proxy.
    if (c.labels[LABEL_ROLE]) continue
    if (c.labels[LABEL_RESOURCE] !== resourceId) continue
    if (c.id === keepContainerId) continue

    await docker.stopContainer(c.id, 10).catch(() => {})
    await docker.removeContainer(c.id, true).catch(() => {})
    emit("Reclaimed a container left behind by an earlier failed deploy")
  }
}

/** The image the currently-serving container was created from, if any. */
async function currentImageOf(
  containerId: string | null,
): Promise<string | null> {
  if (!containerId) return null
  const containers = await docker.listManagedContainers().catch(() => [])
  return containers.find((c) => c.id === containerId)?.image ?? null
}

/**
 * Waits for the new container to be usable, in the precedence §9 defines.
 *
 * mosdash runs on the host, so it dials the container's IP rather than its name
 * — Docker's embedded DNS only resolves from inside the network (DECISIONS D2).
 */
async function healthGate(
  containerId: string,
  containerPort: number | null,
  healthPath: string | null,
  emit: (s: string) => void,
): Promise<void> {
  const deadline = Date.now() + config.healthTimeoutSec * 1000

  // (a) explicit HTTP check
  if (healthPath && containerPort) {
    emit(`Polling http://<container>:${containerPort}${healthPath}`)
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error(
          `health check did not pass within ${config.healthTimeoutSec}s`,
        )
      }
      const state = await docker.inspectContainer(containerId)
      if (!state.running) {
        throw new Error(
          `container exited during the health check (code ${state.exitCode})`,
        )
      }
      if (state.ipAddress) {
        try {
          const res = await fetch(
            `http://${state.ipAddress}:${containerPort}${healthPath}`,
            { signal: AbortSignal.timeout(5000) },
          )
          if (res.ok) return
          emit(`Health check returned ${res.status}, retrying...`)
        } catch {
          // Not up yet; keep polling until the deadline.
        }
      }
      await Bun.sleep(1000)
    }
  }

  // (b) the image declares its own HEALTHCHECK
  const initial = await docker.inspectContainer(containerId)
  if (initial.health !== "none") {
    emit("Image declares a HEALTHCHECK, polling docker health...")
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error(
          `container did not report healthy within ${config.healthTimeoutSec}s`,
        )
      }
      const state = await docker.inspectContainer(containerId)
      if (state.health === "healthy") return
      if (state.health === "unhealthy") {
        throw new Error("container reported unhealthy")
      }
      if (!state.running) {
        throw new Error(`container exited (code ${state.exitCode})`)
      }
      await Bun.sleep(1000)
    }
  }

  // (c) fallback: still running after 5 seconds
  emit("No health check configured; requiring 5s of uptime")
  await Bun.sleep(5000)
  const state = await docker.inspectContainer(containerId)
  if (!state.running) {
    throw new Error(
      `container exited within 5s (code ${state.exitCode}) — check the logs above`,
    )
  }
}

export type DeployTrigger = "manual" | "rollback" | "reconcile" | "webhook"

/**
 * Triggers that deploy an image which already exists locally.
 *
 * Enumerated rather than derived from `trigger !== "manual"`. That inference
 * was correct while there were three triggers and became silently wrong the
 * moment a fourth was added: a webhook deploy would be handed
 * useExistingImage:true and then try to `docker pull` an image literally named
 * "(building)" — the placeholder the deployment row carries until a build
 * resolves the real tag.
 *
 * Adding a trigger now means choosing a side, instead of inheriting an answer
 * from a comparison that never mentioned the concept.
 */
const REUSES_IMAGE: ReadonlySet<DeployTrigger> = new Set([
  "rollback",
  "reconcile",
])

/** Queues a deploy and returns the deployment id. Handlers call this, never runDeploy. */
export function enqueueDeploy(
  resourceId: string,
  image: string,
  trigger: DeployTrigger = "manual",
): string {
  const deployment = createDeployment({ resourceId, image, trigger })
  enqueue("deploy", {
    resourceId,
    deploymentId: deployment.id,
    image,
    useExistingImage: REUSES_IMAGE.has(trigger),
  } satisfies DeployPayload)
  publishStatus({ resourceId, state: "queued" })
  return deployment.id
}

/**
 * How long one resource's pushes collapse into a single deploy.
 *
 * Pushes arrive in bursts — five commits in one `git push`, a merge, a CI bot —
 * and job concurrency is exactly 1, so a job per delivery parks real work behind
 * a queue of redundant builds of nearly the same tree.
 *
 * The tradeoff is sharper than the reconciler's (reconciler.ts:156-169) and cuts
 * the other way, so it is worth stating plainly. For a sidecar the bucket only
 * DELAYS a re-queue, because the reconciler tries again every 30 seconds
 * forever. A webhook has no retry loop: a second, genuinely different push
 * landing in a bucket that already holds a finished row is DROPPED, not delayed,
 * and that commit does not deploy until someone pushes again or clicks Deploy.
 *
 * 60 seconds — the BuildKit precedent, not the proxy's five minutes — bounds
 * that blind window to roughly the length of one build while still collapsing
 * the burst this exists for. Anything longer starts swallowing real commits.
 */
const PUSH_BUCKET_MS = 60 * 1000

function pushJobId(resourceId: string): string {
  return `deploy-push-${resourceId}-${Math.floor(Date.now() / PUSH_BUCKET_MS)}`
}

/**
 * Whether an enqueue error is the primary-key conflict that means "this bucket
 * already holds a row" rather than a genuine failure like a locked database or
 * a full disk. Same shape as reconciler.ts:180-186; the message fallback covers
 * drivers that do not set `code`.
 */
function isConflict(err: unknown): boolean {
  const code = (err as { code?: unknown }).code
  return (
    (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT")) ||
    /constraint failed/i.test((err as Error).message)
  )
}

/**
 * Queues a push-triggered deploy, collapsing a burst per resource.
 *
 * Returns the deployment id, or null when this bucket already holds a job — the
 * primary-key conflict IS the answer there, exactly as it is for the sidecar
 * bootstraps. `enqueue` has no OR IGNORE and will throw, so the catch is
 * required rather than defensive.
 *
 * The deployment row is created first because the job payload needs its id, and
 * removed again on a conflict: a row left behind would show as a permanently
 * "queued" deploy that no job will ever pick up.
 */
export function enqueueDeployCoalesced(
  resourceId: string,
  image: string,
): string | null {
  const deployment = createDeployment({
    resourceId,
    image,
    trigger: "webhook",
  })
  try {
    enqueue(
      "deploy",
      {
        resourceId,
        deploymentId: deployment.id,
        image,
        // A push always builds. Never REUSES_IMAGE — see that set's comment.
        useExistingImage: false,
      } satisfies DeployPayload,
      { id: pushJobId(resourceId) },
    )
  } catch (err) {
    deleteDeployment(deployment.id)
    if (!isConflict(err)) throw err
    return null
  }
  publishStatus({ resourceId, state: "queued" })
  return deployment.id
}

/** After a crash, a deployment can be left claiming to be running. */
export function failStuckDeployment(deploymentId: string): void {
  const d = getDeployment(deploymentId)
  if (d && d.status === "running") {
    markDeploymentFailed(deploymentId, "interrupted by a restart")
  }
}
