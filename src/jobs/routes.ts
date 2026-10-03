import {
  autoDomainFor,
  caddy,
  DASHBOARD_TAIL_ROUTE_IDS,
  isRouteOfResource,
  ROUTE_ID_PREFIX,
  type RouteSpec,
  routeIdFor,
  routeIdForService,
} from "../caddy/client.ts"
import { config } from "../config.ts"
import {
  composeSource,
  getEnvironment,
  listAllResources,
  listDomains,
} from "../db/queries.ts"
import type { ComposeSource } from "../compose/types.ts"
import type { Resource } from "../db/schema.ts"
import { docker } from "../docker/impl.ts"
import { logger } from "../log.ts"
import { getDashboardHost } from "../settings.ts"
import {
  gainFirstHosts,
  type RoutingPlan,
  routingPlan,
  serviceContainerName,
  unionHosts,
} from "./compose-plan.ts"

/**
 * Every hostname a resource answers on: its attached domains plus the auto
 * subdomain, when a wildcard domain is configured — minus the dashboard's own.
 *
 * Resource routes sit ahead of the dashboard's in Caddy (C-1), so a resource
 * carrying the dashboard's hostname would take that name, and every login typed
 * through it, from the next deploy on. The domain form refuses it, but an auto
 * subdomain can collide too, and so can a dashboard host set later. Filtering
 * here is what makes the guarantee hold whichever way the collision arrived
 * (N-3).
 */
export function routeHosts(
  resourceId: string,
  resourceName: string,
  environmentName: string,
): string[] {
  const dashboard = getDashboardHost()
  const hosts = listDomains(resourceId).map((d) => d.host)
  const auto = autoDomainFor(resourceName, environmentName)
  if (auto && !hosts.includes(auto)) hosts.push(auto)
  return hosts.filter((h) => h !== dashboard)
}

/**
 * A stack's routing plan as the database has it now: its domain rows, the
 * public service and port, the auto subdomain, and the dashboard host to keep
 * out (routingPlan). The deploy, the sync and the resource page all read this
 * one function, so a stack is never routed one way by a deploy and another by
 * the next sync.
 */
export function routingPlanFor(
  resource: Resource,
  environmentName: string,
  source: ComposeSource,
): RoutingPlan {
  return routingPlan({
    domains: listDomains(resource.id),
    publicService: source.publicService,
    publicPort: source.publicPort,
    autoHost: autoDomainFor(resource.name, environmentName),
    dashboardHost: getDashboardHost(),
  })
}

/** What a wanted route is, and how to find its upstream when it has none. */
interface WantedRoute {
  resource: Resource
  hosts: string[]
  /** For a stack: the routed service and its port. Null for image and git. */
  service: { name: string; port: number } | null
}

/**
 * The routes a resource should have: none, one for an image or git resource,
 * and one per routed service of a stack (each with at least one host — the
 * plan holds no empty route, and an empty host matcher would answer on every
 * address).
 */
function wantedRoutes(resource: Resource): [string, WantedRoute][] {
  if (resource.desiredState !== "running") return []
  const environment = getEnvironment(resource.environmentId)
  if (!environment) return []
  if (resource.kind === "compose") {
    const source = composeSource(resource)
    if (source === null) return []
    const plan = routingPlanFor(resource, environment.name, source)
    return [...plan.routes].map(([name, route]) => [
      routeIdForService(resource.id, name),
      { resource, hosts: route.hosts, service: { name, port: route.port } },
    ])
  }
  if (!resource.containerPort) return []
  const hosts = routeHosts(resource.id, resource.name, environment.name)
  if (hosts.length === 0) return []
  return [[routeIdFor(resource.id), { resource, hosts, service: null }]]
}

/**
 * Where a wanted resource's route should point, or null to leave it alone.
 *
 * The running container's NAME, on the PORT THE ROUTE ALREADY DIALS — the name
 * survives a reboot where the IP does not (L-7), and a route written before
 * that change still dials an IP, which this rewrites on the next sync. The
 * port in the database can be ahead of the running container — changed in
 * Settings for the next deploy — and repointing a live route at a port the
 * container does not listen on yet is an outage caused by a sync. The database
 * port is used only when there is no route to take it from; changing a live
 * route's port is the deploy's job, after its health gate.
 *
 * When the container is momentarily down, the route keeps the upstream it
 * already has — but it is still rewritten, because its HOSTS must match the
 * database regardless: a name that just became the dashboard's, or a domain
 * just deleted, would otherwise stay on the route, and unless-stopped brings
 * the container back without any deploy or sync to correct it (N-3). No route
 * and no container means nothing to point at; the next deploy writes it.
 */
async function currentUpstream(
  route: WantedRoute,
  existing: string | null,
): Promise<string | null> {
  const { resource, service } = route
  const port = existing
    ? existing.slice(existing.lastIndexOf(":") + 1)
    : (service?.port ?? resource.containerPort)
  // A stack service is looked up by the name Compose gives it, and dialled
  // only when it is on the shared network: the deploy joins a service to it
  // only once it is routed (§3.4), so a public service chosen in Settings
  // since the last deploy is not reachable until the next one.
  const container =
    service === null
      ? resource.containerId
      : serviceContainerName(resource.id, service.name)
  if (container && port) {
    const state = await docker.inspectContainer(container).catch(() => null)
    if (
      state?.running &&
      (service === null || state.networks.includes(config.network))
    ) {
      return `${state.name}:${port}`
    }
  }
  return existing
}

/**
 * Writes one resource's routes, and returns how many writes it made and which
 * of its routes must survive the stale-route sweep.
 *
 * A stack can move a host between two of its routes, so the writes go in the
 * passes applyStackRoutes uses: first every route that gains a host another
 * of its routes holds now, written with its current hosts as well
 * (gainFirstHosts); then every route with its final hosts; the sweep deletes
 * the rest last. A host is therefore on two routes for a moment, never on
 * none — and a write that fails leaves it where it was.
 *
 * A host is PENDING when its planned service route cannot be written yet: no
 * route exists, and the service is not on the musdash network until a deploy
 * joins it (currentUpstream returns null). Dropping it from the route it is on
 * now would leave it on none until that deploy, so any route holding a
 * pending host keeps it, and is not deleted while it does. A host whose
 * first-pass write failed is pending for the same reason. Pending hosts come
 * from the routing plan, so they are only hosts the database still gives this
 * resource, and never the dashboard's.
 *
 * Image and git resources have one route, so no host can move between two:
 * the first pass and pending hosts never apply, and their writes are exactly
 * one ensureRoute, as before.
 */
async function syncResource(
  resource: Resource,
  ownIds: readonly string[],
): Promise<{ written: number; keep: string[] }> {
  const stored = new Map<string, { hosts: string[]; upstream: string | null }>()
  for (const id of ownIds) {
    const route = await caddy.readRoute(id)
    if (route !== null) stored.set(id, route)
  }
  const current = new Map([...stored].map(([id, r]) => [id, r.hosts]))

  const writable = new Map<string, RouteSpec>()
  const pending = new Set<string>()
  const keep: string[] = []
  for (const [id, route] of wantedRoutes(resource)) {
    keep.push(id)
    const upstream = await currentUpstream(
      route,
      stored.get(id)?.upstream ?? null,
    )
    if (upstream !== null) {
      writable.set(id, { id, hosts: route.hosts, upstream })
    } else if (route.service !== null) {
      for (const h of route.hosts) pending.add(h)
    }
  }

  let written = 0
  const write = async (spec: RouteSpec): Promise<boolean> => {
    try {
      if (await caddy.ensureRoute(spec)) written++
      return true
    } catch (err) {
      logger.warn(
        { resourceId: resource.id, err: (err as Error).message },
        "could not re-assert the resource's route",
      )
      return false
    }
  }

  const finalHosts = new Map([...writable].map(([id, s]) => [id, s.hosts]))
  for (const [id, hosts] of gainFirstHosts(current, finalHosts)) {
    const spec = writable.get(id)
    if (spec === undefined || (await write({ ...spec, hosts }))) continue
    for (const h of spec.hosts) pending.add(h)
  }

  for (const id of new Set([...writable.keys(), ...stored.keys()])) {
    const held = (current.get(id) ?? []).filter((h) => pending.has(h))
    const hosts = unionHosts(finalHosts.get(id) ?? [], held)
    const spec = writable.get(id)
    if (spec !== undefined) {
      await write({ ...spec, hosts })
      continue
    }
    // Not planned, or not writable: it survives only while it holds a
    // pending host, rewritten without the hosts it should no longer carry.
    if (hosts.length === 0) continue
    keep.push(id)
    const upstream = stored.get(id)?.upstream ?? null
    if (upstream !== null) await write({ id, hosts, upstream })
  }
  return { written, keep }
}

/**
 * Makes Caddy's resource routes match the database.
 *
 * The routes live in two places — the database says what should be served, and
 * Caddy's persisted config is what is served — and nothing reconciled the two.
 * Runs from ensureCaddy() on every bootstrap, and as the `sync_routes` job
 * whenever a domain is added or removed.
 *
 * A resource that should be served — desired running, with a port and at least
 * one host — has its route written with the database's hosts, pointed at the
 * running container by name. That repairs a proxy recreated on a blank config,
 * a lost config volume, a route still dialling an IP from before L-7, and a
 * domain edit. One whose container is momentarily down keeps its route
 * and its upstream, with the hosts still corrected: dropping the route in
 * between would only send its visitors to the final 404.
 *
 * Any other musdash route is deleted — a stopped or deleted resource, one down
 * to zero hosts, one with no port. The dashboard's tail routes
 * (DASHBOARD_TAIL_ROUTE_IDS) are never touched — an id missing from that set
 * would be deleted here on every domain change. A route with no host matcher
 * would answer on every address AHEAD of the tail, swallowing the dashboard and
 * the final 404 alike, which is why "zero hosts" must mean "no route", not an
 * empty matcher.
 *
 * A stack's routes are written so that no host is ever unrouted on the way —
 * see syncResource.
 *
 * Runs on the queue, so it never races a deploy: job concurrency is exactly 1.
 * ensureRoute writes only on a real difference, because every admin write
 * reloads the whole proxy. Best-effort per route: one broken container must not
 * stop the rest from being routed.
 */
export async function syncResourceRoutes(): Promise<void> {
  // Listed once, before any write: a route this sync writes is wanted, so it
  // can never be one of the stale ones deleted below.
  const existing = await caddy.listRouteIds()
  const keep = new Set<string>()
  let written = 0
  for (const resource of listAllResources()) {
    const ownIds = existing.filter((id) => isRouteOfResource(id, resource.id))
    try {
      const result = await syncResource(resource, ownIds)
      written += result.written
      for (const id of result.keep) keep.add(id)
    } catch (err) {
      // What its routes hold could not be read, so nothing safe can be
      // removed: they stay as they are until the next sync.
      for (const id of ownIds) keep.add(id)
      logger.warn(
        { resourceId: resource.id, err: (err as Error).message },
        "could not sync the resource's routes; left them as they are",
      )
    }
  }

  let removed = 0
  for (const id of existing) {
    if (
      !id.startsWith(ROUTE_ID_PREFIX) ||
      DASHBOARD_TAIL_ROUTE_IDS.has(id) ||
      keep.has(id)
    ) {
      continue
    }
    try {
      await caddy.deleteRoute(id)
      removed++
    } catch (err) {
      logger.warn(
        { route: id, err: (err as Error).message },
        "could not remove a stale route",
      )
    }
  }

  if (written > 0 || removed > 0) {
    logger.info(
      { written, removed },
      "brought Caddy's routes in line with the database",
    )
  }
}
