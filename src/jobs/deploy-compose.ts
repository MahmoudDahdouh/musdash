import { mkdirSync, writeFileSync } from "node:fs"
import { isIP } from "node:net"
import { resolve } from "node:path"
import { caddy, routeIdForService } from "../caddy/client.ts"
import { refusalMessage } from "../compose/messages.ts"
import { prescanCompose } from "../compose/prescan.ts"
import { interpolationEnv } from "../compose/env.ts"
import {
  serviceMemoryMib,
  stackMemoryBytes,
  transformModel,
} from "../compose/transform.ts"
import type { Refusal } from "../compose/types.ts"
import { isRecord, validateModel } from "../compose/validate.ts"
import { config } from "../config.ts"
import {
  composeSource,
  createDeployment,
  getDeployment,
  getResource,
  getResourceContext,
  markDeploymentFailed,
  resolveEnvVars,
  updateDeployment,
  updateResource,
} from "../db/queries.ts"
import type { ManagedContainer } from "../docker/client.ts"
import { docker } from "../docker/impl.ts"
import {
  markDeployLogFinished,
  publishDeployLog,
  publishDeployment,
  publishStatus,
} from "../events.ts"
import { nowIso } from "../ids.ts"
import { logger, redactGithub, redactValues } from "../log.ts"
import { syncStackLogStreams } from "../logs/stream.ts"
import { enqueue } from "../queue/index.ts"
import {
  composeDescriptor,
  composeProject,
  primaryService,
  routedServicesFor,
  type ServiceBaseline,
  serviceContainerName,
  serviceVerdict,
} from "./compose-plan.ts"
import type { DeployPayload } from "./deploy.ts"
import { awaitCertificates, healthGate } from "./health-gate.ts"
import { routeHostsForService } from "./routes.ts"
import {
  compose,
  composeTmpDir,
  deleteResourceRoutes,
  removeComposeTmpDir,
  stackContainersOf,
} from "./stack.ts"

/**
 * Deploying a Compose stack (docs/PHASE-3-PLAN.md §3.2, §3.8): the pipeline
 * A–F, then the gate, the route and the certificate wait.
 *
 * Unlike an image deploy there is no old container kept serving while a new
 * one is checked: `compose up` recreates changed services in place, stopping
 * each before starting its replacement. So a stack has brief downtime on a
 * redeploy, the log says so, and there is nothing to drain. A failed gate
 * leaves the stack as Compose left it — no automatic rollback, because a
 * database may already have migrated forward; Roll back is the way back.
 */

const MIB = 1024 * 1024

/** How long every non-routed service must stay good before the gate passes. */
const STABLE_MS = 5_000

/**
 * A deploy job runs once (see DEPLOY_MAX_ATTEMPTS in deploy.ts, whose reasons
 * hold for stacks too: most failures are deterministic, and each attempt holds
 * the one worker).
 */
const COMPOSE_DEPLOY_MAX_ATTEMPTS = 1

/** A deploy failure whose message is already redacted and fit to show. */
export class ComposeDeployError extends Error {
  override readonly name = "ComposeDeployError"
}

export type ComposeTrigger = "manual" | "rollback" | "reconcile" | "redeploy"

/**
 * Queues a stack deploy of `composeFile` and returns the deployment id.
 * Handlers and the reconciler call this, never runComposeDeploy.
 *
 * The payload has the shape enqueueDeploy writes — useExistingImage false,
 * no redeployOf unless this repeats a deployment — so pendingDeploymentFor
 * folds a second Deploy press into a queued deploy of the same file.
 */
export function enqueueComposeDeploy(
  resourceId: string,
  trigger: ComposeTrigger,
  composeFile: string,
  extra?: { redeployOf?: string },
): string {
  const image = composeDescriptor(composeFile)
  const deployment = createDeployment({
    resourceId,
    image,
    trigger,
    composeFile,
  })
  enqueue(
    "deploy",
    {
      resourceId,
      deploymentId: deployment.id,
      image,
      useExistingImage: false,
      ...(extra?.redeployOf === undefined
        ? {}
        : { redeployOf: extra.redeployOf }),
    } satisfies DeployPayload,
    { maxAttempts: COMPOSE_DEPLOY_MAX_ATTEMPTS },
  )
  publishStatus({ resourceId, state: "queued" })
  return deployment.id
}

export async function runComposeDeploy(payload: DeployPayload): Promise<void> {
  const { resourceId, deploymentId } = payload
  const ctx = getResourceContext(resourceId)
  if (!ctx) throw new Error(`resource ${resourceId} no longer exists`)
  const { resource, environment, project } = ctx
  const stack = composeProject(resourceId)
  const hadCurrent = resource.currentDeploymentId !== null

  // Filled once variables are resolved; read through the closure so a failure
  // during resolution is still redacted with what is known by then. Every
  // line — Compose's own output, status lines, errors — passes through emit,
  // so there is one place redaction can be forgotten, and it is here.
  let secrets: string[] = []
  const safe = (text: string) => redactGithub(redactValues(text, secrets))
  const emit = (text: string) => {
    publishDeployLog(deploymentId, safe(text))
  }
  const refuse = (refusals: readonly Refusal[]): never => {
    for (const r of refusals) emit(refusalMessage(r))
    const first = refusals[0]
    const more = refusals.length - 1
    throw new ComposeDeployError(
      `The Compose file was refused. ${first ? refusalMessage(first) : ""}${
        more > 0 ? ` (${more} more in the log above)` : ""
      }`.trim(),
    )
  }

  try {
    // 1. mark running. The file comes from the deployment row, not the
    // resource: a rollback or "Deploy this again" deploys an older text.
    updateDeployment(deploymentId, { status: "running", startedAt: nowIso() })
    publishDeployment({ deploymentId, resourceId, status: "running" })
    publishStatus({ resourceId, state: "deploying" })
    const deployment = getDeployment(deploymentId)
    const composeFile = deployment?.composeFile ?? null
    if (composeFile === null) {
      throw new ComposeDeployError("This deployment has no Compose file.")
    }
    const source = composeSource(resource)
    if (source === null) {
      throw new ComposeDeployError(
        "This resource's Compose settings could not be read. Save them again in Settings.",
      )
    }
    emit(`Deploying the Compose file ${composeDescriptor(composeFile)}`)

    // 2. variables: the file's interpolation environment, never injected into
    // every service (§3.5). Decrypted here, and never logged.
    const env = resolveEnvVars(resourceId)
    secrets = env.secrets

    // 3. prescan: refuse what would make `config` read host files, and fail on
    // a variable Compose would silently blank (D13, D65 item 3).
    const scan = prescanCompose(composeFile)
    if (scan.refusals.length > 0) refuse(scan.refusals)
    const interp = interpolationEnv(env.runtime, scan.references)
    for (const key of interp.dropped) {
      emit(
        `Ignoring the variable ${key}: it would change how Docker Compose itself runs`,
      )
    }
    if (interp.missing.length > 0) {
      const lines = interp.missing.map(
        (name) =>
          `The Compose file uses \${${name}}, which is not set on this resource, its environment or its project`,
      )
      for (const line of lines) emit(line)
      throw new ComposeDeployError(lines.join(". "))
    }

    // 4. the temporary directory. It will hold the interpolated file, so it is
    // 0700 and removed in finally — and right after `up`, which is the last
    // thing that needs it (D65 item 10).
    const dir = composeTmpDir(deploymentId)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const inFile = resolve(dir, "in.yaml")
    writeFileSync(inFile, composeFile, { mode: 0o600 })

    // 5. normalise, then validate what Compose produced — the authority.
    emit("Normalising the file with docker compose config")
    const model = await compose.config(
      { project: stack, dir, file: inFile },
      interp.env,
    )
    const hosts =
      source.publicService === null
        ? []
        : routeHostsForService(
            resourceId,
            resource.name,
            environment.name,
            source.publicService,
          )
    const routed = routedServicesFor(source, hosts.length)
    const refusals = validateModel(model, {
      project: stack,
      routedServices: routed,
    })
    if (refusals.length > 0) refuse(refusals)

    // 6. what musdash adds: labels, memory limits, restart, logging, network.
    const transformed = transformModel(model, {
      project: stack,
      resourceId,
      projectId: project.id,
      network: config.network,
      routedServices: routed,
      defaultMemoryBytes: config.defaultMemoryMb * MIB,
    })
    const stackFile = resolve(dir, "stack.json")
    writeFileSync(stackFile, JSON.stringify(transformed), { mode: 0o600 })
    const services = isRecord(transformed.services)
      ? Object.keys(transformed.services)
      : []

    // 7. the shared network, which only routed services join.
    if (routed.length > 0) await docker.ensureNetwork(config.network)

    // 8. what was running before: a service Compose leaves untouched keeps
    // its container and its restart count, and only a restart since `up`
    // means it crashed.
    const baseline = await snapshot(resourceId)

    // 9. pull first, so a missing image fails before anything is stopped.
    const target = { project: stack, dir, file: stackFile }
    emit("Pulling images...")
    await compose.pull(target, emit)
    emit(
      "Stacks are recreated in place, so services that changed may be briefly unavailable during this deploy.",
    )
    await compose.up(target, emit)
    removeComposeTmpDir(deploymentId)

    // 10. the gate, every service under one deadline.
    const containers = await gateStack({
      resourceId,
      services,
      transformed,
      routed,
      port: source.publicPort,
      healthPath: resource.healthPath,
      baseline,
      emit,
    })
    emit("Health check passed")

    // 11. the route: one per routed service, dialled by container name
    // (D48), and every other route of this resource removed.
    let newHosts: string[] = []
    const keep = new Set<string>()
    const service = routed[0]
    if (service !== undefined && source.publicPort !== null) {
      const id = routeIdForService(resourceId, service)
      const upstream = `${serviceContainerName(resourceId, service)}:${source.publicPort}`
      const previousHosts = await caddy.upsertRoute({ id, hosts, upstream })
      keep.add(id)
      newHosts = hosts.filter(
        (h) =>
          isIP(h) === 0 &&
          !previousHosts.some((p) => p.toLowerCase() === h.toLowerCase()),
      )
      emit(`Route switched to ${upstream} for ${hosts.join(", ")}`)
    } else if (hosts.length > 0 || source.publicService !== null) {
      emit(
        "No public service with a port and a domain — skipping the route (set them in Settings to expose it)",
      )
    }
    await deleteResourceRoutes(resourceId, keep)
    if (newHosts.length > 0) {
      await awaitCertificates(resourceId, newHosts, emit)
    }

    // 12. record success. The source is read again: Settings may have saved a
    // new file while this ran, and only `services` and `memoryMb` are this
    // deploy's to write.
    const primary = primaryService({
      publicService: source.publicService,
      services,
    })
    const containerId =
      primary === null ? null : (containers.get(primary)?.id ?? null)
    const fresh = getResource(resourceId)
    const freshSource = fresh ? composeSource(fresh) : null
    updateResource(resourceId, {
      containerId,
      currentDeploymentId: deploymentId,
      desiredState: "running",
      memoryLimitMb: Math.ceil(stackMemoryBytes(transformed) / MIB),
      ...(freshSource === null
        ? {}
        : {
            sourceJson: JSON.stringify({
              ...freshSource,
              services,
              memoryMb: serviceMemoryMib(transformed),
            }),
          }),
    })
    updateDeployment(deploymentId, {
      status: "succeeded",
      finishedAt: nowIso(),
    })
    publishDeployment({ deploymentId, resourceId, status: "succeeded" })
    publishStatus({ resourceId, state: "healthy", containerId })
    emit("Deploy succeeded")
    markDeployLogFinished(deploymentId)
    logFinished(resourceId, deploymentId, "succeeded")

    syncStackLogStreams(resourceId, runningContainerIds(containers))
  } catch (err) {
    // Redacted before it goes anywhere — pino, the row, the page, the worker.
    const message = safe(err instanceof Error ? err.message : String(err))
    logger.error({ resourceId, deploymentId, err: message }, "deploy failed")
    // No `down`: a failed gate leaves the stack as Compose left it (§3.8).
    markDeploymentFailed(deploymentId, message)
    publishDeployment({ deploymentId, resourceId, status: "failed" })
    publishStatus({ resourceId, state: hadCurrent ? "healthy" : "failed" })
    emit(`Deploy failed: ${message}`)
    markDeployLogFinished(deploymentId)
    logFinished(resourceId, deploymentId, "failed")
    throw new ComposeDeployError(message)
  } finally {
    // It holds the interpolated file, and so the secrets in it.
    removeComposeTmpDir(deploymentId)
  }
}

/** The peak-RSS line runDeploy logs, for the same reason (see logPeakRss). */
function logFinished(
  resourceId: string,
  deploymentId: string,
  outcome: "succeeded" | "failed",
): void {
  logger.info(
    {
      resourceId,
      deploymentId,
      outcome,
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
    },
    "deploy finished",
  )
}

/**
 * The running services' container ids. A finished one-shot is not followed:
 * its log stream would end at once and be re-tailed on every reconcile,
 * repeating its last lines into the buffer each time.
 */
export function runningContainerIds(
  containers: ReadonlyMap<string, ManagedContainer>,
): Map<string, string> {
  const out = new Map<string, string>()
  for (const [service, c] of containers) if (c.running) out.set(service, c.id)
  return out
}

/** Each service's container id and restart count before `up`. */
async function snapshot(
  resourceId: string,
): Promise<Map<string, ServiceBaseline>> {
  const out = new Map<string, ServiceBaseline>()
  const list = await docker.listManagedContainers().catch(() => [])
  for (const [service, c] of stackContainersOf(list, resourceId)) {
    const state = await docker.inspectContainer(c.id).catch(() => null)
    out.set(service, {
      containerId: c.id,
      restartCount: state?.restartCount ?? 0,
    })
  }
  return out
}

interface GateInput {
  resourceId: string
  services: readonly string[]
  transformed: Record<string, unknown>
  routed: readonly string[]
  port: number | null
  healthPath: string | null
  baseline: ReadonlyMap<string, ServiceBaseline>
  emit: (s: string) => void
}

function restartOf(model: Record<string, unknown>, service: string): unknown {
  const services = isRecord(model.services) ? model.services : {}
  const svc = services[service]
  return isRecord(svc) ? svc.restart : undefined
}

/**
 * The stack's gate (§3.8), under one deadline for every service. A routed
 * service passes the image deploy's own gate (HTTP, then HEALTHCHECK, then
 * uptime); every other service must be running and not restarted — or, as a
 * one-shot, have exited 0 — and all of them must hold that for 5 s together.
 * `--wait` is not used: it fails a one-shot that exits 0 (D65 item 8).
 *
 * Returns each service's container, for the resource row and the logs.
 */
async function gateStack(
  input: GateInput,
): Promise<Map<string, ManagedContainer>> {
  const { resourceId, services, routed, baseline, emit } = input
  const deadline = Date.now() + config.healthTimeoutSec * 1000
  const list = async () =>
    stackContainersOf(
      await docker.listManagedContainers().catch(() => []),
      resourceId,
    )

  for (const service of routed) {
    const c = (await list()).get(service)
    if (!c) {
      throw new ComposeDeployError(
        `Service ${service} has no container after docker compose up`,
      )
    }
    emit(`Checking ${service}...`)
    const before = baseline.get(service)
    await healthGate(
      c.id,
      input.port,
      input.healthPath,
      emit,
      deadline,
      before?.containerId === c.id ? before.restartCount : 0,
    )
  }

  const others = services.filter((s) => !routed.includes(s))
  if (others.length > 0) {
    emit(`Waiting for ${others.join(", ")} to stay up for 5s...`)
  }
  let goodSince: number | null = null
  for (;;) {
    const found = await list()
    const waiting: string[] = []
    for (const service of others) {
      const c = found.get(service)
      const state =
        c === undefined
          ? null
          : await docker.inspectContainer(c.id).catch(() => null)
      const verdict = serviceVerdict(
        {
          state: c?.state ?? null,
          containerId: c?.id ?? null,
          exitCode: c?.exitCode ?? null,
          restartCount: state?.restartCount ?? 0,
        },
        baseline.get(service),
        restartOf(input.transformed, service),
      )
      if (verdict.ok) continue
      if (verdict.final) {
        throw new ComposeDeployError(
          `Service ${service} ${verdict.reason} — check the logs above`,
        )
      }
      waiting.push(`${service} ${verdict.reason}`)
    }
    const now = Date.now()
    if (waiting.length === 0) {
      goodSince ??= now
      if (others.length === 0 || now - goodSince >= STABLE_MS) return found
    } else {
      goodSince = null
      if (now > deadline) {
        throw new ComposeDeployError(
          `The stack was not healthy within ${config.healthTimeoutSec}s: ${waiting.join("; ")}`,
        )
      }
    }
    await Bun.sleep(1000)
  }
}
