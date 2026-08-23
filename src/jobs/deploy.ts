import { autoDomainFor, caddy, routeIdFor } from "../caddy/client.ts"
import { config } from "../config.ts"
import { managedLabels } from "../docker/client.ts"
import { docker } from "../docker/impl.ts"
import {
  createDeployment,
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
import { logger, redactValues } from "../log.ts"
import { enqueue } from "../queue/index.ts"
import { startLogStream, stopLogStream } from "../logs/stream.ts"

export interface DeployPayload {
  resourceId: string
  deploymentId: string
  image: string
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
  const { resourceId, deploymentId, image } = payload
  const ctx = getResourceContext(resourceId)
  if (!ctx) throw new Error(`resource ${resourceId} no longer exists`)
  const { resource, environment, project } = ctx

  const emit = (text: string) => {
    publishDeployLog(deploymentId, text)
  }

  // Secrets are decrypted here and must never reach a log line — not on the
  // happy path, not in an error message, not in the deploy stream.
  const env = getDecryptedEnvVars(resourceId)
  const secrets = Object.values(env)
  const safe = (text: string) => redactValues(text, secrets)

  const oldContainerId = resource.containerId
  let newContainerId: string | null = null

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

    // 3. pull
    emit(`Pulling ${image}...`)
    await docker.pullImage(image, (line) => emit(safe(line)))
    emit("Image pulled")

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
      await caddy.upsertRoute({
        id: routeIdFor(resourceId),
        hosts,
        upstream,
      })
      emit(`Route switched to ${upstream} for ${hosts.join(", ")}`)
    } else if (hosts.length > 0) {
      emit("No container port set — skipping route (set one to expose it)")
    }

    // 8b. only now is the old container expendable
    if (oldContainerId && oldContainerId !== newContainerId) {
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
      sourceJson: JSON.stringify({ image }),
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

    // 9. the old container is still serving; tear down only what we created.
    if (newContainerId) {
      await docker.removeContainer(newContainerId, true).catch(() => {})
      emit("Removed the failed container; the previous one is still serving")
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

/** Queues a deploy and returns the deployment id. Handlers call this, never runDeploy. */
export function enqueueDeploy(
  resourceId: string,
  image: string,
  trigger: "manual" | "rollback" | "reconcile" = "manual",
): string {
  const deployment = createDeployment({ resourceId, image, trigger })
  enqueue("deploy", {
    resourceId,
    deploymentId: deployment.id,
    image,
  } satisfies DeployPayload)
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
