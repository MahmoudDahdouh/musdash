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

/** What the routing plan reads of a domain row; structural, so no db import. */
export interface RoutingDomain {
  id: string
  host: string
  serviceName: string | null
  containerPort: number | null
}

/** One routed service: the port Caddy dials and the hosts it answers on. */
export interface ServiceRoute {
  port: number
  hosts: string[]
}

export interface RoutingPlan {
  /** Only services with at least one host; insertion order is row order. */
  routes: Map<string, ServiceRoute>
  /** Rows left out because their service is already routed on another port. */
  conflicts: { host: string; service: string; port: number }[]
}

/**
 * Which host goes to which service of a stack, on which port (D66). The one
 * answer the deploy, `sync_routes` and the resource page all read, so a stack
 * is never routed one way by a deploy and another by the next sync.
 *
 * - A row with no service (written before per-service routing), and the auto
 *   subdomain, belong to the public service on the public port — and to
 *   nothing when either is unset.
 * - A row with a service and a port goes to that service.
 * - A service has ONE port: the public port for the public service, else the
 *   port of its first row. A later row asking for another port is a conflict,
 *   left out of the routes rather than silently dialled on the wrong port.
 * - Hosts are lower-cased and each is routed once, the first claim winning,
 *   so an explicit row beats the implicit auto subdomain. The dashboard's own
 *   host is never routed: resource routes sit ahead of the dashboard's in
 *   Caddy, so a stack carrying it would take the dashboard login (N-3).
 */
export function routingPlan(input: {
  domains: readonly RoutingDomain[]
  publicService: string | null
  publicPort: number | null
  autoHost: string | null
  dashboardHost: string | null | undefined
}): RoutingPlan {
  const dashboard = input.dashboardHost?.toLowerCase() ?? null
  const pub =
    input.publicService !== null && input.publicPort !== null
      ? { service: input.publicService, port: input.publicPort }
      : null
  const ports = new Map<string, number>()
  if (pub !== null) ports.set(pub.service, pub.port)
  const routes = new Map<string, ServiceRoute>()
  const conflicts: RoutingPlan["conflicts"] = []
  const claimed = new Set<string>()

  const assign = (rawHost: string, service: string, port: number): void => {
    const host = rawHost.toLowerCase()
    // The port is fixed before the dashboard filter, so servicePortFor —
    // which sees every row — agrees with this on which port a service has.
    let servicePort = ports.get(service)
    if (servicePort === undefined) {
      servicePort = port
      ports.set(service, port)
    }
    if (host === dashboard || claimed.has(host)) return
    claimed.add(host)
    if (port !== servicePort) {
      conflicts.push({ host, service, port })
      return
    }
    const route = routes.get(service)
    if (route === undefined) {
      routes.set(service, { port: servicePort, hosts: [host] })
    } else {
      route.hosts.push(host)
    }
  }

  for (const d of input.domains) {
    if (d.serviceName === null) {
      if (pub !== null) assign(d.host, pub.service, pub.port)
    } else if (d.containerPort !== null) {
      assign(d.host, d.serviceName, d.containerPort)
    }
  }
  if (input.autoHost !== null && pub !== null) {
    assign(input.autoHost, pub.service, pub.port)
  }
  return { routes, conflicts }
}

/**
 * The port `service` is already routed on, ignoring the row `excludeDomainId`
 * (the one being moved); the public port for the public service; null when
 * nothing fixes it yet. What the domain forms check a requested port against,
 * by the same rule routingPlan applies.
 */
export function servicePortFor(
  domains: readonly RoutingDomain[],
  source: Pick<ComposeSource, "publicService" | "publicPort">,
  service: string,
  excludeDomainId?: string,
): number | null {
  if (service === source.publicService && source.publicPort !== null) {
    return source.publicPort
  }
  for (const d of domains) {
    if (d.id === excludeDomainId) continue
    if (d.serviceName === service && d.containerPort !== null) {
      return d.containerPort
    }
  }
  return null
}

/**
 * Whether adding or moving a domain onto `service` at `port` needs a deploy
 * rather than a route sync. Only what the change touches counts — the target —
 * so an unrelated service's state never turns a sync into a redeploy.
 *
 * - The target is not on the musdash network: neither the last `compose up`
 *   joined it (`routedServices`) nor was it routed before the change. Only a
 *   deploy joins a service to the network Caddy dials it on. A service routed
 *   before counts as joined, which also keeps a stack saved before S3 — whose
 *   `routedServices` defaults to [] — from redeploying on every change.
 * - The target was routed on another port: moving a live route's port is the
 *   deploy's job, after its health gate — `sync_routes` keeps a live route's
 *   port (see currentUpstream).
 */
export function routingChangeNeedsDeploy(
  before: RoutingPlan,
  routedServices: readonly string[],
  service: string,
  port: number,
): boolean {
  const prev = before.routes.get(service)
  if (prev === undefined) return !routedServices.includes(service)
  return prev.port !== port
}

/**
 * `first`, then each host of `rest` it lacks. `first`'s order is kept, so a
 * union that adds nothing is identical to `first` — and ensureRoute, which
 * compares the whole route, then skips the write.
 */
export function unionHosts(
  first: readonly string[],
  rest: readonly string[],
): string[] {
  const out = [...first]
  for (const h of rest) if (!out.includes(h)) out.push(h)
  return out
}

/**
 * The first pass of writing one resource's routes: every route that gains a
 * host ANOTHER route of the same resource holds now, with the hosts it should
 * end with plus the ones it holds now. Written before any route loses a host,
 * so a host moving between two routes of a stack is on both for a moment and
 * never on none — even if a later write fails.
 *
 * A route gaining only hosts no route of this resource holds is left to the
 * final pass: there is nothing to keep routed, and an extra write would cost
 * a proxy reload (D30). That also leaves a one-route resource — image or git —
 * with exactly the writes it had before.
 *
 * `current` and `final` map route id to hosts, lower-cased.
 */
export function gainFirstHosts(
  current: ReadonlyMap<string, readonly string[]>,
  final: ReadonlyMap<string, readonly string[]>,
): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const [id, hosts] of final) {
    const mine = current.get(id) ?? []
    const gainsHeldHost = hosts.some(
      (h) =>
        !mine.includes(h) &&
        [...current].some(([other, held]) => other !== id && held.includes(h)),
    )
    if (gainsHeldHost) out.set(id, unionHosts(hosts, mine))
  }
  return out
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
