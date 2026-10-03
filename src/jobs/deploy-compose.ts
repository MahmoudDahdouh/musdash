import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
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
  listDomains,
  markDeploymentFailed,
  resolveEnvVars,
  setComposeSource,
  updateDeployment,
  updateResource,
} from "../db/queries.ts"
import type { Domain } from "../db/schema.ts"
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
  type RoutingPlan,
  type ServiceBaseline,
  type ServiceRoute,
  serviceVerdict,
} from "./compose-plan.ts"
import type { DeployPayload } from "./deploy.ts"
import { awaitCertificates, healthGate } from "./health-gate.ts"
import { routingPlanFor } from "./routes.ts"
import {
  applyStackRoutes,
  compose,
  composeTmpDir,
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

    // The routing plan, read once: the same answer `sync_routes` and the
    // resource page give (routingPlanFor). Only its services join the shared
    // network; everything else stays on the stack's own (§3.4).
    const rows = listDomains(resourceId)
    const plan = routingPlanFor(resource, environment.name, source)
    const routed = [...plan.routes.keys()]

    // A domain still pointing at a service this file no longer has. Refused
    // before `up`, so the running stack and its routes are left alone rather
    // than half-replaced by a stack its domains cannot reach.
    checkDroppedServices(model, rows, plan, source.publicService)

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

    // 10. what `up` joined to the shared network, recorded at once — before
    // the gate, which may fail — because the services ARE joined from here
    // on, whatever the gate says. A later domain change reads this to tell a
    // route sync (service already reachable) from a deploy (it is not).
    recordRoutedServices(resourceId, routed)

    // 11. the gate, every service under one deadline.
    const containers = await gateStack({
      resourceId,
      services,
      transformed,
      routes: plan.routes,
      publicService: source.publicService,
      healthPath: resource.healthPath,
      baseline,
      emit,
    })
    emit("Health check passed")

    // 12. the routes: one per routed service, dialled by container name
    // (D48), all written before any other route of this resource is removed.
    for (const c of plan.conflicts) {
      emit(
        `Skipping ${c.host}: it asks for port ${c.port} of ${c.service}, which is routed on another port (a service has one port)`,
      )
    }
    if (
      plan.routes.size === 0 &&
      (rows.length > 0 || source.publicService !== null)
    ) {
      emit(
        "No service has both a domain and a port — skipping the route (add a domain on the Domains tab to expose one)",
      )
    }
    const newHosts = await applyStackRoutes(resourceId, plan, emit)
    // One wait over every new host, under one deadline, whichever service it
    // routes to.
    if (newHosts.length > 0) {
      await awaitCertificates(resourceId, newHosts, emit)
    }

    // 13. record success. The source is read again: Settings may have saved a
    // new file while this ran, and only `services` and `memoryMb` are this
    // deploy's to write — `routedServices` it wrote after `up`, and the fresh
    // read carries it.
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

/**
 * Refuses a file that dropped a service a domain points at: every service a
 * domain row names, and the public service when the plan routes it, must be
 * a service of the normalised model. The message names the services and
 * their hosts only — never a value. A model with no services is left to
 * validateModel, whose `no-services` says what is actually wrong.
 */
function checkDroppedServices(
  model: unknown,
  rows: readonly Domain[],
  plan: RoutingPlan,
  publicService: string | null,
): void {
  if (!(isRecord(model) && isRecord(model.services))) return
  const present = new Set(Object.keys(model.services))
  const dropped = new Map<string, string[]>()
  const add = (service: string, host: string): void => {
    if (present.has(service)) return
    const hosts = dropped.get(service) ?? []
    if (!hosts.includes(host)) hosts.push(host)
    dropped.set(service, hosts)
  }
  for (const d of rows) {
    if (d.serviceName !== null) add(d.serviceName, d.host)
  }
  if (publicService !== null) {
    for (const host of plan.routes.get(publicService)?.hosts ?? []) {
      add(publicService, host)
    }
  }
  if (dropped.size === 0) return
  const parts = [...dropped].map(
    ([service, hosts]) => `${service} (domains: ${hosts.join(", ")})`,
  )
  throw new ComposeDeployError(
    `The Compose file no longer has ${dropped.size === 1 ? "the service" : "the services"} ${parts.join("; ")}. ` +
      "Move those domains to another service on the Domains tab, or put the service back in the file.",
  )
}

/**
 * Writes which services this deploy joined to the shared network into a
 * freshly read source, so a Settings save made while the deploy ran is kept.
 */
function recordRoutedServices(resourceId: string, routed: string[]): void {
  const fresh = getResource(resourceId)
  const freshSource = fresh ? composeSource(fresh) : null
  if (freshSource === null) return
  setComposeSource(resourceId, { ...freshSource, routedServices: routed })
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
  /** The plan's routes: each routed service is gated on its own port. */
  routes: ReadonlyMap<string, ServiceRoute>
  /** The only service the resource's health path applies to. */
  publicService: string | null
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
  const { resourceId, services, routes, baseline, emit } = input
  const deadline = Date.now() + config.healthTimeoutSec * 1000
  const list = async () =>
    stackContainersOf(
      await docker.listManagedContainers().catch(() => []),
      resourceId,
    )

  for (const [service, route] of routes) {
    const c = (await list()).get(service)
    if (!c) {
      throw new ComposeDeployError(
        `Service ${service} has no container after docker compose up`,
      )
    }
    emit(`Checking ${service}...`)
    const before = baseline.get(service)
    // The health path is a setting of the public service; another routed
    // service is gated on its own port by HEALTHCHECK or uptime instead.
    await healthGate(
      c.id,
      route.port,
      service === input.publicService ? input.healthPath : null,
      emit,
      deadline,
      before?.containerId === c.id ? before.restartCount : 0,
    )
  }

  const others = services.filter((s) => !routes.has(s))
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
