import { describe, expect, test } from "bun:test"
import type { VolumeUsage } from "../docker/client.ts"
import {
  createVolumeSizeCache,
  VOLUME_SIZES_FAILURE_TTL_MS,
  VOLUME_SIZES_MAX_RESOURCES,
  VOLUME_SIZES_TTL_MS,
  type VolumeSizeCache,
} from "./sizes.ts"

/**
 * Every test drives a fake clock and counts fetches, because the rules under
 * test are all "does this get make the Engine walk every volume or not".
 */

const T0 = 1_000_000
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

/** The i-th of a run of resource ids; ascending i is ascending id. */
function rid(i: number): string {
  const a = CROCKFORD[Math.floor(i / 32)] as string
  const b = CROCKFORD[i % 32] as string
  return `01J9ZX7Q8M5N3P4R6S7T8V9W${a}${b}`
}

function usage(
  resourceId: string | null,
  name: string,
  sizeBytes: number | null,
): VolumeUsage {
  return {
    name,
    labels: resourceId === null ? {} : { "musdash.resource_id": resourceId },
    sizeBytes,
    refCount: 0,
  }
}

function harness(): {
  cache: VolumeSizeCache
  clock: { now: number }
} {
  const clock = { now: T0 }
  const cache = createVolumeSizeCache({
    ttlMs: VOLUME_SIZES_TTL_MS,
    failureTtlMs: VOLUME_SIZES_FAILURE_TTL_MS,
    maxResources: VOLUME_SIZES_MAX_RESOURCES,
    now: () => clock.now,
  })
  return { cache, clock }
}

function counting(list: readonly VolumeUsage[]): {
  fetch: () => Promise<readonly VolumeUsage[]>
  calls: () => number
} {
  let calls = 0
  return {
    fetch: () => {
      calls++
      return Promise.resolve(list)
    },
    calls: () => calls,
  }
}

const ONE = [usage(rid(0), "musdash-x_data", 42)]

describe("createVolumeSizeCache", () => {
  test("concurrent gets share one fetch and one snapshot", async () => {
    const { cache } = harness()
    let release: (list: readonly VolumeUsage[]) => void = () => undefined
    let calls = 0
    const fetch = (): Promise<readonly VolumeUsage[]> => {
      calls++
      return new Promise((resolve) => {
        release = resolve
      })
    }

    const pending = Array.from({ length: 5 }, () => cache.get(fetch))
    expect(cache.stats().inFlight).toBe(true)
    release(ONE)
    const results = await Promise.all(pending)

    expect(calls).toBe(1)
    const [first] = results
    expect(first).toEqual({
      known: true,
      takenAt: T0,
      volumes: [{ name: "musdash-x_data", resourceId: rid(0), sizeBytes: 42 }],
    })
    for (const r of results) expect(r).toBe(first as (typeof results)[number])
    expect(cache.stats().inFlight).toBe(false)
  })

  test("serves a success without fetching until the TTL passes", async () => {
    const { cache, clock } = harness()
    const stub = counting(ONE)

    await cache.get(stub.fetch)
    clock.now = T0 + VOLUME_SIZES_TTL_MS - 1
    const cached = await cache.get(stub.fetch)
    expect(stub.calls()).toBe(1)
    expect(cached.known).toBe(true)

    clock.now = T0 + VOLUME_SIZES_TTL_MS
    await cache.get(stub.fetch)
    expect(stub.calls()).toBe(2)
  })

  const failures: Record<string, () => Promise<readonly VolumeUsage[]>> = {
    "a rejected fetch": () => Promise.reject(new Error("daemon down")),
    "a fetch that throws synchronously": () => {
      throw new Error("no socket")
    },
  }

  for (const [why, failing] of Object.entries(failures)) {
    test(`${why} resolves unknown and is not retried for a minute`, async () => {
      const { cache, clock } = harness()
      let calls = 0
      const fetch = (): Promise<readonly VolumeUsage[]> => {
        calls++
        return failing()
      }

      expect(await cache.get(fetch)).toEqual({ known: false })
      clock.now = T0 + VOLUME_SIZES_FAILURE_TTL_MS - 1
      expect(await cache.get(fetch)).toEqual({ known: false })
      expect(calls).toBe(1)

      clock.now = T0 + VOLUME_SIZES_FAILURE_TTL_MS
      await cache.get(fetch)
      expect(calls).toBe(2)
    })
  }

  test("keeps the 64 resources holding the most, ties by id, ULID ids only", async () => {
    const { cache } = harness()
    const list: VolumeUsage[] = []
    // ids 10..69: distinct totals well above the tied group, so size must
    // beat id order — sorting by id alone would keep 0..63 instead.
    for (let i = 10; i < 70; i++) {
      list.push(usage(rid(i), `big-${i}-a`, 1_000 + i))
      if (i % 2 === 0) list.push(usage(rid(i), `big-${i}-b`, null))
    }
    // ids 0..9: every total is 7, made up three ways — so only the id
    // tie-break decides which four of them stay.
    for (let i = 0; i < 10; i++) {
      if (i % 3 === 0) list.push(usage(rid(i), `tie-${i}`, 7))
      else if (i % 3 === 1) {
        list.push(usage(rid(i), `tie-${i}-a`, 3))
        list.push(usage(rid(i), `tie-${i}-b`, 4))
      } else {
        list.push(usage(rid(i), `tie-${i}-a`, 7))
        list.push(usage(rid(i), `tie-${i}-b`, null))
      }
    }
    // Never a resource's: the sidecars, a non-ULID id, a lower-cased ULID.
    list.push(usage(null, "musdash-caddy-data", 9e12))
    list.push(usage(null, "musdash-caddy-config", 9e12))
    list.push(usage(null, "musdash-buildkit-cache", 9e12))
    list.push(usage("not-a-ulid", "hand-made", 9e12))
    list.push(usage(rid(5).toLowerCase(), "lower", 9e12))
    list.reverse()

    const sizes = await cache.get(() => Promise.resolve(list))
    if (!sizes.known) throw new Error("expected a known snapshot")
    const kept = new Set(sizes.volumes.map((v) => v.resourceId))

    expect(kept.size).toBe(64)
    const expected = new Set<string>()
    for (let i = 10; i < 70; i++) expected.add(rid(i))
    for (let i = 0; i < 4; i++) expected.add(rid(i))
    expect(kept).toEqual(expected)
    expect(cache.stats().resources).toBe(64)

    const names = sizes.volumes.map((v) => v.name)
    for (const absent of [
      "musdash-caddy-data",
      "musdash-caddy-config",
      "musdash-buildkit-cache",
      "hand-made",
      "lower",
    ]) {
      expect(names).not.toContain(absent)
    }
    // Only name, id and size are kept — never labels.
    for (const v of sizes.volumes) {
      expect(Object.keys(v).sort()).toEqual(["name", "resourceId", "sizeBytes"])
    }
  })
})
