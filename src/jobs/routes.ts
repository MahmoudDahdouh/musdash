import { autoDomainFor, caddy, routeIdFor } from "../caddy/client.ts"
import {
  getEnvironment,
  listDomains,
  listRunningResources,
} from "../db/queries.ts"
import { docker } from "../docker/impl.ts"
import { logger } from "../log.ts"

/**
 * Every hostname a resource answers on: its attached domains plus the auto
 * subdomain, when a wildcard domain is configured.
 */
export function routeHosts(
  resourceId: string,
  resourceName: string,
  environmentName: string,
): string[] {
  const hosts = listDomains(resourceId).map((d) => d.host)
  const auto = autoDomainFor(resourceName, environmentName)
  if (auto && !hosts.includes(auto)) hosts.push(auto)
  return hosts
}

/**
 * Re-asserts every running resource's route from the database.
 *
 * The routes live in two places — the database says what should be served, and
 * Caddy's persisted config is what is served — and nothing reconciled the two.
 * That left three ways for a site to go dark with the database still correct: a
 * proxy recreated on a fresh config (the D29 migration does exactly that), a
 * lost config volume, and a reboot that hands a container a different IP than
 * the one its route dials.
 *
 * Runs on the queue from ensureCaddy(), so it never races a deploy: job
 * concurrency is exactly 1. ensureRoute writes only on a real difference,
 * because every admin write reloads the whole proxy.
 *
 * Read-only toward Docker (inspect), and best-effort per resource: one broken
 * container must not stop the rest from being routed.
 */
export async function syncResourceRoutes(): Promise<void> {
  let changed = 0
  for (const resource of listRunningResources()) {
    if (!resource.containerId || !resource.containerPort) continue
    const environment = getEnvironment(resource.environmentId)
    if (!environment) continue
    const hosts = routeHosts(resource.id, resource.name, environment.name)
    if (hosts.length === 0) continue

    try {
      const state = await docker.inspectContainer(resource.containerId)
      // A stopped container is the reconciler's to redeploy, and the deploy
      // writes the route; pointing one at a dead address here gains nothing.
      if (!state.running || !state.ipAddress) continue
      const wrote = await caddy.ensureRoute({
        id: routeIdFor(resource.id),
        hosts,
        upstream: `${state.ipAddress}:${resource.containerPort}`,
      })
      if (wrote) changed++
    } catch (err) {
      logger.warn(
        { resourceId: resource.id, err: (err as Error).message },
        "could not re-assert the resource's route",
      )
    }
  }
  if (changed > 0) {
    logger.info({ changed }, "re-asserted resource routes in Caddy")
  }
}
