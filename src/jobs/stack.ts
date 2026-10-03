import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import { isIP } from "node:net"
import { resolve } from "node:path"
import {
  type CaddyClient,
  caddy,
  isRouteOfResource,
  routeIdForService,
} from "../caddy/client.ts"
import { config } from "../config.ts"
import {
  isStackContainer,
  LABEL_RESOURCE,
  LABEL_SERVICE,
  type ManagedContainer,
} from "../docker/client.ts"
import { composeCli, composeHome } from "../docker/compose.ts"
import { docker } from "../docker/impl.ts"
import { logger } from "../log.ts"
import {
  gainFirstHosts,
  type RoutingPlan,
  serviceContainerName,
} from "./compose-plan.ts"

/**
 * What the stack deploy, stop, remove, the scheduler and boot share: the one
 * ComposeCli, the temporary directories, and the resource's containers and
 * routes.
 */

/** The process's one Compose CLI, behind the Docker seam. */
export const compose = composeCli(docker)

/** Where each deploy writes its interpolated file; deleted after use (§3.2). */
export function composeTmpRoot(): string {
  return resolve(config.dataDir, "compose", "tmp")
}

/**
 * The temporary directory of one deploy. The id is a ULID from musdash's own
 * generator, but it is still checked before it is joined onto a path that is
 * later removed recursively: an id carrying `..` would escape the root.
 */
export function composeTmpDir(deploymentId: string): string {
  if (!/^[0-9A-Za-z]{1,64}$/.test(deploymentId)) {
    throw new Error(`unsafe deployment id for a Compose directory`)
  }
  return resolve(composeTmpRoot(), deploymentId)
}

/** Removes a deploy's temporary directory. Never throws: it runs in finally. */
export function removeComposeTmpDir(deploymentId: string): void {
  try {
    rmSync(composeTmpDir(deploymentId), { recursive: true, force: true })
  } catch (err) {
    logger.warn(
      { deploymentId, errorName: err instanceof Error ? err.name : typeof err },
      "could not remove a Compose temporary directory",
    )
  }
}

/**
 * Removes temporary directories older than `maxAgeMs` (0: all of them), and
 * returns how many went. They hold interpolated secrets, so a SIGKILL
 * mid-deploy must not leave one on disk: boot sweeps them all before the
 * worker starts, and the daily housekeeping sweeps any older than an hour.
 */
export function sweepComposeTmp(maxAgeMs: number): number {
  const root = composeTmpRoot()
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return 0
  }
  const cutoff = Date.now() - maxAgeMs
  let removed = 0
  for (const entry of entries) {
    const dir = resolve(root, entry)
    try {
      if (maxAgeMs > 0 && statSync(dir).mtimeMs >= cutoff) continue
      rmSync(dir, { recursive: true, force: true })
      removed++
    } catch (err) {
      logger.warn(
        { dir, errorName: err instanceof Error ? err.name : typeof err },
        "could not sweep a Compose temporary directory",
      )
    }
  }
  if (removed > 0) {
    logger.info({ removed }, "swept Compose temporary directories")
  }
  return removed
}

/**
 * At boot, before the worker can start a deploy: every temporary directory
 * is a leftover, and the Compose directories exist with their modes.
 */
export function prepareComposeDirs(): void {
  sweepComposeTmp(0)
  for (const dir of [resolve(config.dataDir, "compose"), composeTmpRoot()]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  mkdirSync(composeHome(), { recursive: true, mode: 0o700 })
}

/**
 * A resource's stack containers by service, from one container list. Where
 * two carry the same service — a leftover beside its replacement — the
 * running one wins.
 */
export function stackContainersOf(
  containers: readonly ManagedContainer[],
  resourceId: string,
): Map<string, ManagedContainer> {
  const out = new Map<string, ManagedContainer>()
  for (const c of containers) {
    if (!isStackContainer(c.labels)) continue
    if (c.labels[LABEL_RESOURCE] !== resourceId) continue
    const service = c.labels[LABEL_SERVICE]
    if (service === undefined) continue
    const existing = out.get(service)
    if (!existing || (c.running && !existing.running)) out.set(service, c)
  }
  return out
}

/**
 * Makes a stack's routes match its plan: one route per routed service, dialling
 * the service's container BY NAME on its port (D48), and no other route of
 * this resource. Returns the hosts new to Caddy — the ones that need a first
 * certificate — leaving out IP literals, which never get one.
 *
 * A host never goes unrouted on the way, even between two writes or after a
 * failed one — B moving from `--web`, which keeps other hosts, to `--api`
 * would otherwise be dropped from `--web` before `--api` has it. So the
 * writes go in three passes:
 *
 * 1. Gain: every route that gains a host another route of this resource holds
 *    now is written with its final hosts PLUS its current ones
 *    (gainFirstHosts). B is then on both routes.
 * 2. Final: every planned route is written with exactly its hosts. B leaves
 *    `--web` only now that `--api` has it.
 * 3. Delete: this resource's routes the plan no longer has.
 *
 * A write that throws fails the deploy where it stands, which at worst leaves
 * a host on two routes, never on none. Each new route is PUT at index 0 and an
 * existing one PATCHed in place (upsertRoute), so the dashboard's tail stays
 * last (C-1, D55) and is never deleted: deleteResourceRoutes only matches this
 * resource's ids. ensureRoute skips a write that changes nothing — every admin
 * write reloads the whole proxy (D30).
 *
 * `client` is injectable for the tests; production callers use the default.
 */
export async function applyStackRoutes(
  resourceId: string,
  plan: RoutingPlan,
  emit: (s: string) => void,
  client: CaddyClient = caddy,
): Promise<string[]> {
  // What this resource's routes hold before anything is written.
  const current = new Map<string, string[]>()
  for (const id of await client.listRouteIds()) {
    if (!isRouteOfResource(id, resourceId)) continue
    const stored = await client.readRoute(id)
    if (stored !== null) current.set(id, stored.hosts)
  }
  const known = new Set([...current.values()].flat())

  const wanted = new Map<string, { hosts: string[]; upstream: string }>()
  for (const [service, route] of plan.routes) {
    wanted.set(routeIdForService(resourceId, service), {
      hosts: route.hosts,
      upstream: `${serviceContainerName(resourceId, service)}:${route.port}`,
    })
  }

  const finalHosts = new Map([...wanted].map(([id, w]) => [id, w.hosts]))
  for (const [id, hosts] of gainFirstHosts(current, finalHosts)) {
    const upstream = wanted.get(id)?.upstream
    if (upstream !== undefined)
      await client.ensureRoute({ id, hosts, upstream })
  }

  const newHosts: string[] = []
  for (const [id, { hosts, upstream }] of wanted) {
    await client.ensureRoute({ id, hosts, upstream })
    // New to Caddy means on none of this resource's routes before: a host
    // that only moved between services already has its certificate.
    for (const host of hosts) {
      if (isIP(host) === 0 && !known.has(host) && !newHosts.includes(host)) {
        newHosts.push(host)
      }
    }
    emit(`Route switched to ${upstream} for ${hosts.join(", ")}`)
  }
  await deleteResourceRoutes(resourceId, new Set(wanted.keys()), client)
  return newHosts
}

/**
 * Deletes every route of a resource — its own and each service's — except the
 * ids in `keep`. Best-effort per route, like the other route deletions: a
 * missing route is the goal.
 */
export async function deleteResourceRoutes(
  resourceId: string,
  keep: ReadonlySet<string> = new Set(),
  client: CaddyClient = caddy,
): Promise<void> {
  let ids: string[]
  try {
    ids = await client.listRouteIds()
  } catch (err) {
    logger.warn(
      { resourceId, err: (err as Error).message },
      "could not list Caddy routes to remove a resource's",
    )
    return
  }
  for (const id of ids) {
    if (!isRouteOfResource(id, resourceId) || keep.has(id)) continue
    await client.deleteRoute(id).catch((err: unknown) => {
      logger.warn(
        { resourceId, route: id, err: (err as Error).message },
        "could not delete the Caddy route",
      )
    })
  }
}
