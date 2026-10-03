import {
  autoDomainFor,
  caddy,
  DASHBOARD_TAIL_ROUTE_IDS,
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
import type { Resource } from "../db/schema.ts"
import { docker } from "../docker/impl.ts"
import { logger } from "../log.ts"
import { getDashboardHost } from "../settings.ts"
import { serviceContainerName } from "./compose-plan.ts"

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
 * routeHosts for one service of a stack: the domains that name this service,
 * or name none (a row from before service routing), plus the auto subdomain —
 * which always belongs to the public service — minus the dashboard's.
 */
export function routeHostsForService(
  resourceId: string,
  resourceName: string,
  environmentName: string,
  service: string,
): string[] {
  const dashboard = getDashboardHost()
  const hosts = listDomains(resourceId)
    .filter((d) => d.serviceName === null || d.serviceName === service)
    .map((d) => d.host)
  const auto = autoDomainFor(resourceName, environmentName)
  if (auto && !hosts.includes(auto)) hosts.push(auto)
  return hosts.filter((h) => h !== dashboard)
}

/** What a wanted route is, and how to find its upstream when it has none. */
interface WantedRoute {
  resource: Resource
  hosts: string[]
  /** For a stack: the routed service and its port. Null for image and git. */
  service: { name: string; port: number } | null
}

/** The route a resource should have, or null when it should have none. */
function wantedRoute(resource: Resource): [string, WantedRoute] | null {
  if (resource.desiredState !== "running") return null
  const environment = getEnvironment(resource.environmentId)
  if (!environment) return null
  if (resource.kind === "compose") {
    const source = composeSource(resource)
    const name = source?.publicService ?? null
    const port = source?.publicPort ?? null
    if (name === null || port === null) return null
    const hosts = routeHostsForService(
      resource.id,
      resource.name,
      environment.name,
      name,
    )
    if (hosts.length === 0) return null
    return [
      routeIdForService(resource.id, name),
      { resource, hosts, service: { name, port } },
    ]
  }
  if (!resource.containerPort) return null
  const hosts = routeHosts(resource.id, resource.name, environment.name)
  if (hosts.length === 0) return null
  return [routeIdFor(resource.id), { resource, hosts, service: null }]
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
  id: string,
  route: WantedRoute,
): Promise<string | null> {
  const { resource, service } = route
  const existing = await caddy.getRouteUpstream(id)
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
 * Runs on the queue, so it never races a deploy: job concurrency is exactly 1.
 * ensureRoute writes only on a real difference, because every admin write
 * reloads the whole proxy. Best-effort per route: one broken container must not
 * stop the rest from being routed.
 */
export async function syncResourceRoutes(): Promise<void> {
  const wanted = new Map<string, WantedRoute>()
  for (const resource of listAllResources()) {
    const route = wantedRoute(resource)
    if (route !== null) wanted.set(route[0], route[1])
  }

  let written = 0
  for (const [id, route] of wanted) {
    const { resource, hosts } = route
    try {
      const upstream = await currentUpstream(id, route)
      if (upstream === null) continue
      const spec: RouteSpec = { id, hosts, upstream }
      if (await caddy.ensureRoute(spec)) written++
    } catch (err) {
      logger.warn(
        { resourceId: resource.id, err: (err as Error).message },
        "could not re-assert the resource's route",
      )
    }
  }

  let removed = 0
  for (const id of await caddy.listRouteIds()) {
    if (
      !id.startsWith(ROUTE_ID_PREFIX) ||
      DASHBOARD_TAIL_ROUTE_IDS.has(id) ||
      wanted.has(id)
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
