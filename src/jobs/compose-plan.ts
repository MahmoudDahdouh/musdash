import { createHash } from "node:crypto"
import { generateSecret, parsePlaceholder } from "../compose/placeholders.ts"
import type { ComposeSource, Reference } from "../compose/types.ts"

/**
 * The pure decisions behind a stack's deploy, gate, reconcile and create —
 * kept apart from the jobs that act on them so each can be tested without a
 * daemon, a database or a clock. No Docker, database, config or logger here.
 */

/**
 * The Compose project of a resource: `musdash-<resourceId lowercased>`.
 * Compose accepts `[a-z0-9_-]`, and a ULID lowercased is exactly that.
 */
export function composeProject(resourceId: string): string {
  return `musdash-${resourceId.toLowerCase()}`
}

/**
 * What Compose names a service's one container. Deterministic, because
 * container_name and replicas above 1 are refused (§3.2), and what a route
 * dials — by name, never by IP (D48).
 */
export function serviceContainerName(
  resourceId: string,
  service: string,
): string {
  return `${composeProject(resourceId)}-${service}-1`
}

/**
 * `deployments.image` for a stack, which has no single image: the column is
 * NOT NULL and the deployments table should stay readable, so it names the
 * file by the first 12 hex of its SHA-256 (§3.1). Two deploys of the same
 * text carry the same descriptor, which is what lets a second Deploy press
 * fold into a queued one.
 */
export function composeDescriptor(composeFile: string): string {
  const hex = createHash("sha256").update(composeFile, "utf8").digest("hex")
  return `compose@sha256:${hex.slice(0, 12)}`
}

/**
 * The service whose container stands for the whole stack on the resource row
 * (resources.container_id): the public one, else the first. That keeps
 * resourceState() — which reads only whether a container id is set — the same
 * for every kind.
 */
export function primaryService(
  source: Pick<ComposeSource, "publicService" | "services">,
): string | null {
  return source.publicService ?? source.services[0] ?? null
}

/**
 * The services that get a route and join the shared network: the public one,
 * when it has a port and at least one host to answer on. Everything else stays
 * on the stack's own network (§3.4).
 */
export function routedServicesFor(
  source: Pick<ComposeSource, "publicService" | "publicPort">,
  hostCount: number,
): string[] {
  if (source.publicService === null || source.publicPort === null) return []
  return hostCount > 0 ? [source.publicService] : []
}

/**
 * Whether a service's restart policy leaves a clean exit alone — a one-shot
 * (a migration, a seed) that is done, not down. `on-failure` restarts only a
 * failure, so an exit 0 under it is finished too.
 */
export function isOneShot(restart: unknown): boolean {
  return (
    restart === "no" ||
    (typeof restart === "string" && restart.startsWith("on-failure"))
  )
}

/** What the gate sees of one service container on one poll. */
export interface ServiceObservation {
  /** The Engine's state word from the container list; null when missing. */
  state: string | null
  containerId: string | null
  exitCode: number | null
  restartCount: number
}

/** The service container as it was before `up`, if it existed. */
export interface ServiceBaseline {
  containerId: string
  restartCount: number
}

export type ServiceVerdict =
  | { ok: true }
  /** `final`: waiting longer cannot change the answer, so fail now. */
  | { ok: false; final: boolean; reason: string }

/**
 * The gate's rule for a service with no route (§3.8): running and not
 * restarted, or finished cleanly when it is a one-shot.
 *
 * Restarts are counted from the baseline: Compose leaves an unchanged
 * service's container running across a deploy, with whatever restart count
 * its earlier life gave it, so only a restart SINCE `up` means it crashed. A
 * container `up` created or recreated has a new id and starts from zero.
 */
export function serviceVerdict(
  obs: ServiceObservation,
  baseline: ServiceBaseline | undefined,
  restart: unknown,
): ServiceVerdict {
  if (obs.containerId === null || obs.state === null) {
    return { ok: false, final: false, reason: "has no container" }
  }
  const before =
    baseline !== undefined && baseline.containerId === obs.containerId
      ? baseline.restartCount
      : 0
  const restarts = obs.restartCount - before
  if (restarts > 0) {
    return {
      ok: false,
      final: true,
      reason: `crashed and Docker restarted it (${restarts} ${restarts === 1 ? "restart" : "restarts"})`,
    }
  }
  if (obs.state === "running") return { ok: true }
  if (obs.state === "exited") {
    if (obs.exitCode === 0 && isOneShot(restart)) return { ok: true }
    if (obs.exitCode !== null && obs.exitCode !== 0) {
      return {
        ok: false,
        final: true,
        reason: `exited with code ${obs.exitCode}`,
      }
    }
    // Exit 0 under a policy that restarts it: Docker is about to, and the
    // restart count decides on the next poll.
    return { ok: false, final: false, reason: "exited" }
  }
  return { ok: false, final: false, reason: `is ${obs.state}` }
}

/** What the reconciler sees of one service container. */
export interface StackContainerView {
  running: boolean
  state: string
  exitCode: number | null
}

/**
 * The services of a stack that need a redeploy: those with no container, or
 * one that is neither running nor finished cleanly. The container list carries
 * no restart policy, so any exit 0 is read as a finished one-shot — a service
 * that exits 0 under `unless-stopped` is brought back by Docker itself.
 */
export function stackServicesDown(
  services: readonly string[],
  containers: ReadonlyMap<string, StackContainerView>,
): string[] {
  return services.filter((service) => {
    const c = containers.get(service)
    if (c === undefined) return true
    if (c.running) return false
    return !(c.state === "exited" && c.exitCode === 0)
  })
}

/** A generated placeholder value, ready to store as a resource variable. */
export interface PlaceholderVar {
  key: string
  value: string
}

/**
 * The placeholder variables to create for a file's references (§3.5).
 *
 * Secret placeholders (password, user, base64) are generated for every name
 * the file references that is not already resolvable for the resource.
 * Route placeholders (fqdn, url) are filled only when `route` is given — at
 * create — and only for the public service on the public port (or no port),
 * from the auto domain; anything else is left unset, and the deploy's
 * missing-variable check names it.
 */
export function placeholderVars(
  references: readonly Reference[],
  resolvable: ReadonlySet<string>,
  route: {
    publicService: string | null
    publicPort: number | null
    autoHost: string | null
  } | null,
): PlaceholderVar[] {
  const out: PlaceholderVar[] = []
  for (const ref of references) {
    if (resolvable.has(ref.name)) continue
    const p = parsePlaceholder(ref.name)
    if (p === null) continue
    if (p.kind === "password" || p.kind === "user" || p.kind === "base64") {
      out.push({ key: p.name, value: generateSecret(p.kind) })
      continue
    }
    if (route === null || route.autoHost === null) continue
    if (route.publicService === null || p.service !== route.publicService) {
      continue
    }
    if (p.port !== undefined && p.port !== route.publicPort) continue
    out.push({
      key: p.name,
      value: p.kind === "fqdn" ? route.autoHost : `https://${route.autoHost}`,
    })
  }
  return out
}
