import { LABEL_RESOURCE, type VolumeUsage } from "../docker/client.ts"
import { RESOURCE_ID_RE } from "./select.ts"

/**
 * One cached measurement of every stack volume's size, shared by every page
 * that shows one.
 *
 * Kept free of the logger, config, database and Docker client — the split
 * repo-cache.ts uses — so every rule is testable with a fake clock and a stub
 * fetch. index.ts binds one instance to docker.volumeUsage.
 *
 * Why cache at all: the Engine's `/system/df` has no filter. It walks the
 * files of EVERY volume on the host to size them, which on a host with a
 * large database takes seconds and real I/O. Doing that per page load would
 * make the dashboard the busiest thing on the disk, so one measurement serves
 * every caller for ttlMs, and a failure is remembered for failureTtlMs so a
 * daemon that cannot answer is not asked again on every load.
 *
 * Why it is bounded: this lives in the one process whose RSS is capped at
 * 100MB. Only name, resource id and size are kept per volume — never labels —
 * and only for the maxResources resources holding the most data.
 *
 * No timers: expiry is checked on get, so an idle dashboard holds no handle.
 */

export const VOLUME_SIZES_TTL_MS = 10 * 60_000
export const VOLUME_SIZES_FAILURE_TTL_MS = 60_000
export const VOLUME_SIZES_MAX_RESOURCES = 64

export interface VolumeSizeEntry {
  name: string
  resourceId: string
  sizeBytes: number | null
}

export type VolumeSizes =
  | { known: true; takenAt: number; volumes: readonly VolumeSizeEntry[] }
  | { known: false }

export interface VolumeSizeCache {
  /**
   * Never rejects, even when fetch throws synchronously. Concurrent callers
   * share one in-flight fetch.
   */
  get(fetch: () => Promise<readonly VolumeUsage[]>): Promise<VolumeSizes>
  stats(): { resources: number; volumes: number; inFlight: boolean }
}

export interface VolumeSizeCacheOptions {
  /** A measurement younger than this is served without a fetch. */
  ttlMs: number
  /** A failure younger than this is served as `{known:false}` without a fetch. */
  failureTtlMs: number
  /** Resource ids kept per measurement. */
  maxResources: number
  now?: () => number
}

const UNKNOWN: VolumeSizes = { known: false }

/**
 * The snapshot of a measurement: volumes whose `musdash.resource_id` is a
 * resource id, the rest (sidecars, anything hand-made) dropped. Above
 * maxResources ids, the ones holding the most are kept — a size the Engine
 * did not compute counts as 0 — ties broken by id ascending so the choice is
 * the same on every run.
 */
function snapshotOf(
  list: readonly VolumeUsage[],
  maxResources: number,
  takenAt: number,
): VolumeSizes {
  const byResource = new Map<
    string,
    { total: number; vols: VolumeSizeEntry[] }
  >()
  for (const v of list) {
    const resourceId = v.labels[LABEL_RESOURCE]
    if (typeof resourceId !== "string" || !RESOURCE_ID_RE.test(resourceId)) {
      continue
    }
    let group = byResource.get(resourceId)
    if (!group) {
      group = { total: 0, vols: [] }
      byResource.set(resourceId, group)
    }
    group.total += v.sizeBytes ?? 0
    group.vols.push({ name: v.name, resourceId, sizeBytes: v.sizeBytes })
  }

  const kept = [...byResource.entries()]
    .sort(([idA, a], [idB, b]) =>
      a.total !== b.total ? b.total - a.total : idA < idB ? -1 : 1,
    )
    .slice(0, Math.max(0, maxResources))

  const volumes = kept
    .flatMap(([, group]) => group.vols)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return { known: true, takenAt, volumes }
}

export function createVolumeSizeCache(
  options: VolumeSizeCacheOptions,
): VolumeSizeCache {
  const now = options.now ?? Date.now
  /** The last result, success or failure, and how long it may be served. */
  let stored: { sizes: VolumeSizes; at: number; ttlMs: number } | null = null
  /** The measurement in progress, shared by every caller that arrives during it. */
  let inFlight: Promise<VolumeSizes> | null = null

  async function refresh(
    fetch: () => Promise<readonly VolumeUsage[]>,
  ): Promise<VolumeSizes> {
    try {
      // Wrapped so a fetch that throws synchronously rejects like any other
      // failure instead of escaping get().
      const list = await new Promise<readonly VolumeUsage[]>((resolve) => {
        resolve(fetch())
      })
      const at = now()
      const sizes = snapshotOf(list, options.maxResources, at)
      stored = { sizes, at, ttlMs: options.ttlMs }
      return sizes
    } catch {
      // Not swallowed: the bound fetch (index.ts) logs its own failure, and
      // this layer has no logger by design. What it owes callers is an answer
      // that says "unknown", remembered so the daemon is not asked again on
      // every page load while it cannot answer.
      stored = { sizes: UNKNOWN, at: now(), ttlMs: options.failureTtlMs }
      return UNKNOWN
    }
  }

  return {
    get(fetch) {
      // The freshness check and the inFlight assignment below MUST stay in one
      // synchronous block, as in repo-cache.ts: they are atomic only because
      // nothing awaits between them, and an await here starts a second df.
      const at = now()
      if (stored && at - stored.at < stored.ttlMs) {
        return Promise.resolve(stored.sizes)
      }
      if (inFlight) return inFlight

      const promise = refresh(fetch).finally(() => {
        if (inFlight === promise) inFlight = null
      })
      inFlight = promise
      return promise
    },

    stats() {
      const sizes = stored?.sizes
      if (!sizes?.known) {
        return { resources: 0, volumes: 0, inFlight: inFlight !== null }
      }
      return {
        resources: new Set(sizes.volumes.map((v) => v.resourceId)).size,
        volumes: sizes.volumes.length,
        inFlight: inFlight !== null,
      }
    },
  }
}
