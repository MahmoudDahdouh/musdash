import { isRecord, parseInteger } from "./validate.ts"

/**
 * Stage E of the Compose pipeline (docs/PHASE-3-PLAN.md §3.2): what musdash
 * adds to a validated, normalised model before `compose up`.
 *
 *   - ownership labels on every service and declared volume, which is how the
 *     reconciler and the volume list find them (§3.7, §3.9);
 *   - a hard memory limit and swap off on every service (invariant, D38);
 *   - `restart: unless-stopped` unless the file chose (`"no"` is a one-shot);
 *   - the capped json-file log driver, so container logs cannot fill the
 *     disk (§3.12);
 *   - the shared network, only on services that have a domain (§3.4, D65
 *     item 6: service names collide as aliases on a shared network).
 *
 * Nothing else is touched. Compose has already `$$`-escaped every value
 * (D65 item 14) and `up` runs on this output with no user environment, so
 * re-escaping or unescaping any string would change what the user wrote.
 *
 * Pure; returns a new object and never mutates its input.
 */

export interface TransformContext {
  project: string
  resourceId: string
  projectId: string
  /** The shared musdash network's name (config.network). */
  network: string
  routedServices: readonly string[]
  defaultMemoryBytes: number
}

/** The model broke transformModel's precondition: validateModel passes it. */
export class ComposeModelError extends Error {
  // Set explicitly: the release binary is minified.
  override readonly name = "ComposeModelError"
}

const LOGGING = {
  driver: "json-file",
  options: { "max-size": "10m", "max-file": "2" },
} as const

/** Labels as a map. Compose normalises them to one; a list is folded in. */
function labelMap(labels: unknown): Record<string, unknown> {
  if (isRecord(labels)) return { ...labels }
  if (!Array.isArray(labels)) return {}
  const entries: [string, string][] = []
  for (const l of labels) {
    if (typeof l !== "string") continue
    const eq = l.indexOf("=")
    entries.push(eq === -1 ? [l, ""] : [l.slice(0, eq), l.slice(eq + 1)])
  }
  return Object.fromEntries(entries)
}

function deployMemory(svc: Record<string, unknown>): unknown {
  const deploy = isRecord(svc.deploy) ? svc.deploy : {}
  const resources = isRecord(deploy.resources) ? deploy.resources : {}
  const limits = isRecord(resources.limits) ? resources.limits : {}
  return limits.memory
}

/**
 * The limit Docker will enforce: `mem_limit`, else the deploy limit. Compose
 * refuses a file that sets both to different values (D65 item 1).
 */
function effectiveMemory(svc: Record<string, unknown>): number | null {
  const mem = svc.mem_limit
  if (mem !== undefined && mem !== null) return parseInteger(mem)
  const deploy = deployMemory(svc)
  if (deploy !== undefined && deploy !== null) return parseInteger(deploy)
  return null
}

function transformService(
  name: string,
  svc: Record<string, unknown>,
  ctx: TransformContext,
  routed: boolean,
): void {
  // No musdash.deployment_id: a label change makes Compose recreate the
  // container (D65 item 7), so a per-deploy label would restart the database
  // on every deploy. These four are constant for the resource's life.
  svc.labels = {
    ...labelMap(svc.labels),
    "musdash.managed": "true",
    "musdash.resource_id": ctx.resourceId,
    "musdash.project_id": ctx.projectId,
    "musdash.service": name,
  }

  let limit = effectiveMemory(svc)
  if (limit === null) {
    const mem = svc.mem_limit ?? deployMemory(svc)
    if (mem !== undefined && mem !== null) {
      throw new ComposeModelError(
        `service ${name} has an unreadable memory limit`,
      )
    }
    limit = ctx.defaultMemoryBytes
    svc.mem_limit = String(limit)
  }
  if (limit <= 0) {
    throw new ComposeModelError(`service ${name} has no memory limit`)
  }
  // Swap off (D38): Docker's memswap is memory plus swap, so equal means none.
  svc.memswap_limit = String(limit)

  if (svc.restart === undefined || svc.restart === null) {
    svc.restart = "unless-stopped"
  }
  svc.logging = structuredClone(LOGGING)

  if (routed) {
    const networks = svc.networks
    let map: Record<string, unknown>
    if (isRecord(networks)) {
      map = { ...networks }
    } else if (Array.isArray(networks)) {
      map = Object.fromEntries(
        networks
          .filter((n): n is string => typeof n === "string")
          .map((n) => [n, null]),
      )
    } else {
      // A service with no networks key is on the stack's default network;
      // naming one network would take it off that, so default is kept.
      map = { default: null }
    }
    map.musdash = null
    svc.networks = map
  }
}

/**
 * Precondition: validateModel returned [] for this model and these routed
 * services. Returns a new model; the input is not mutated.
 */
export function transformModel(
  model: unknown,
  ctx: TransformContext,
): Record<string, unknown> {
  if (!isRecord(model) || !isRecord(model.services)) {
    throw new ComposeModelError("model has no services")
  }
  const out: Record<string, unknown> = structuredClone(model)
  out.name = ctx.project

  const services = isRecord(out.services) ? out.services : {}
  const routed = new Set(ctx.routedServices)
  let anyRouted = false
  for (const [name, svc] of Object.entries(services)) {
    if (!isRecord(svc)) {
      throw new ComposeModelError(`service ${name} is not a mapping`)
    }
    const isRouted = routed.has(name)
    anyRouted ||= isRouted
    transformService(name, svc, ctx, isRouted)
  }

  if (anyRouted) {
    out.networks = {
      ...(isRecord(out.networks) ? out.networks : {}),
      musdash: { name: ctx.network, external: true },
    }
  }

  // Volume labels are constant for the resource's life too: a changed label
  // on a volume makes Compose ask to recreate it. They are how a volume kept
  // after its resource is deleted is still found (§3.7).
  if (isRecord(out.volumes)) {
    out.volumes = Object.fromEntries(
      Object.entries(out.volumes).map(([key, v]) => {
        const vol = isRecord(v) ? v : {}
        vol.labels = {
          ...labelMap(vol.labels),
          "musdash.managed": "true",
          "musdash.resource_id": ctx.resourceId,
          "musdash.project_id": ctx.projectId,
          "musdash.volume": key,
        }
        return [key, vol]
      }),
    )
  }
  return out
}

/**
 * The sum of every service's memory limit in bytes, which becomes the
 * resource's `memory_limit_mb` (§3.1). Read after the transform, when every
 * service has one.
 */
export function stackMemoryBytes(model: unknown): number {
  if (!isRecord(model) || !isRecord(model.services)) return 0
  let total = 0
  for (const svc of Object.values(model.services)) {
    if (!isRecord(svc)) continue
    const bytes = effectiveMemory(svc)
    if (bytes !== null && bytes > 0) total += bytes
  }
  return total
}
