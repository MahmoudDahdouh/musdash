import {
  autoDomainFor,
  caddy,
  DASHBOARD_HOST_ROUTE_ID,
  DASHBOARD_ROUTE_ID,
  ROUTE_ID_PREFIX,
  type RouteSpec,
  routeIdFor,
} from "../caddy/client.ts"
import { getEnvironment, listAllResources, listDomains } from "../db/queries.ts"
import type { Resource } from "../db/schema.ts"
import { docker } from "../docker/impl.ts"
import { logger } from "../log.ts"
import { getDashboardHost } from "../settings.ts"

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

/** The hosts a resource should be routed on, or [] when it should not be. */
function wantedHosts(resource: Resource): string[] {
  if (resource.desiredState !== "running" || !resource.containerPort) return []
  const environment = getEnvironment(resource.environmentId)
  if (!environment) return []
  return routeHosts(resource.id, resource.name, environment.name)
}

/**
 * Where a wanted resource's route should point, or null to leave it alone.
 *
 * The running container's current IP, on the PORT THE ROUTE ALREADY DIALS. The
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
async function currentUpstream(resource: Resource): Promise<string | null> {
  const existing = await caddy.getRouteUpstream(routeIdFor(resource.id))
  const port = existing
    ? existing.slice(existing.lastIndexOf(":") + 1)
    : resource.containerPort
  if (resource.containerId && port) {
    const state = await docker
      .inspectContainer(resource.containerId)
      .catch(() => null)
    if (state?.running && state.ipAddress) return `${state.ipAddress}:${port}`
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
 * running container's current IP. That repairs a proxy recreated on a blank
 * config, a lost config volume, a reboot that handed the container a new IP,
 * and a domain edit. One whose container is momentarily down keeps its route
 * and its upstream, with the hosts still corrected: dropping the route in
 * between would only send its visitors to the dashboard.
 *
 * Any other musdash route is deleted — a stopped or deleted resource, one down
 * to zero hosts, one with no port. The dashboard's two routes are never
 * touched. A route with no host matcher would be a catch-all AHEAD of the
 * dashboard's, which is why "zero hosts" must mean "no route", not an empty
 * matcher.
 *
 * Runs on the queue, so it never races a deploy: job concurrency is exactly 1.
 * ensureRoute writes only on a real difference, because every admin write
 * reloads the whole proxy. Best-effort per route: one broken container must not
 * stop the rest from being routed.
 */
export async function syncResourceRoutes(): Promise<void> {
  const wanted = new Map<string, { resource: Resource; hosts: string[] }>()
  for (const resource of listAllResources()) {
    const hosts = wantedHosts(resource)
    if (hosts.length > 0) {
      wanted.set(routeIdFor(resource.id), { resource, hosts })
    }
  }

  let written = 0
  for (const [id, { resource, hosts }] of wanted) {
    try {
      const upstream = await currentUpstream(resource)
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
  const keep = new Set([DASHBOARD_ROUTE_ID, DASHBOARD_HOST_ROUTE_ID])
  for (const id of await caddy.listRouteIds()) {
    if (!id.startsWith(ROUTE_ID_PREFIX) || keep.has(id) || wanted.has(id)) {
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
