import { describe, expect, test } from "bun:test"
import {
  createRepoCache,
  REPO_CACHE_MAX_ENTRIES,
  REPO_CACHE_MAX_ITEMS,
  REPO_LIST_STALE_MAX_AGE_MS,
  REPO_LIST_TTL_MS,
  type RepoCache,
} from "./repo-cache.ts"

/**
 * Every test drives a fake clock and counts fetches, because the rules under
 * test are all "does this get go to GitHub or not".
 */

const MINUTE = 60_000
const T0 = 1_000_000

interface Harness {
  cache: RepoCache<string>
  clock: { now: number }
}

function harness(): Harness {
  const clock = { now: T0 }
  const cache = createRepoCache<string>({
    ttlMs: REPO_LIST_TTL_MS,
    staleMaxAgeMs: REPO_LIST_STALE_MAX_AGE_MS,
    maxEntries: REPO_CACHE_MAX_ENTRIES,
    maxItems: REPO_CACHE_MAX_ITEMS,
    now: () => clock.now,
  })
  return { cache, clock }
}

/** A fetch stub that counts its calls and resolves to `items`. */
function counting(items: readonly string[]): {
  fetch: () => Promise<readonly string[]>
  calls: () => number
} {
  let calls = 0
  return {
    fetch: () => {
      calls++
      return Promise.resolve(items)
    },
    calls: () => calls,
  }
}

function list(n: number, prefix = "r"): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`)
}

describe("createRepoCache", () => {
  test("serves a stored list inside the TTL and refetches at exactly the TTL", async () => {
    const { cache, clock } = harness()
    const stub = counting(["a/b"])

    await cache.get(1, stub.fetch)
    clock.now = T0 + REPO_LIST_TTL_MS - 1
    const hit = await cache.get(1, stub.fetch)
    expect(stub.calls()).toBe(1)
    expect(hit).toEqual({ items: ["a/b"], stale: null })

    clock.now = T0 + REPO_LIST_TTL_MS
    await cache.get(1, stub.fetch)
    expect(stub.calls()).toBe(2)
  })

  test("20 concurrent gets on a cold id fetch once and share the items", async () => {
    const { cache } = harness()
    const stub = counting(["a/b", "c/d"])

    const results = await Promise.all(
      Array.from({ length: 20 }, () => cache.get(7, stub.fetch)),
    )
    expect(stub.calls()).toBe(1)
    for (const result of results) {
      expect(result.items).toEqual(["a/b", "c/d"])
      expect(result.stale).toBeNull()
    }
  })

  test("a failed fetch with nothing stored rejects with the original error and is not cached", async () => {
    const { cache } = harness()
    const boom = new Error("GitHub 500")

    await expect(cache.get(1, () => Promise.reject(boom))).rejects.toBe(boom)
    expect(cache.stats().entries).toBe(0)

    const stub = counting(["a/b"])
    const result = await cache.get(1, stub.fetch)
    expect(stub.calls()).toBe(1)
    expect(result.items).toEqual(["a/b"])
  })

  test("a failed refresh serves the older list as stale, up to and including the max age", async () => {
    const { cache, clock } = harness()
    await cache.get(1, () => Promise.resolve(["old/repo"]))

    const boom = new Error("GitHub timeout")
    clock.now = T0 + 10 * MINUTE
    const served = await cache.get(1, () => Promise.reject(boom))
    expect(served.items).toEqual(["old/repo"])
    expect(served.stale?.ageMs).toBe(600_000)
    expect(served.stale?.error).toBe(boom)

    clock.now = T0 + REPO_LIST_STALE_MAX_AGE_MS
    const edge = await cache.get(1, () => Promise.reject(boom))
    expect(edge.items).toEqual(["old/repo"])
    expect(edge.stale?.ageMs).toBe(REPO_LIST_STALE_MAX_AGE_MS)
  })

  test("a failed refresh past the max age rejects", async () => {
    const { cache, clock } = harness()
    await cache.get(1, () => Promise.resolve(["old/repo"]))

    const boom = new Error("GitHub timeout")
    clock.now = T0 + REPO_LIST_STALE_MAX_AGE_MS + 1
    await expect(cache.get(1, () => Promise.reject(boom))).rejects.toBe(boom)
  })

  test("the 17th installation evicts the oldest entry", async () => {
    const { cache, clock } = harness()
    for (let id = 1; id <= 17; id++) {
      clock.now = T0 + id
      await cache.get(id, () => Promise.resolve([`repo${id}`]))
    }
    expect(cache.stats().entries).toBe(16)

    const stub = counting(["repo1"])
    await cache.get(1, stub.fetch)
    expect(stub.calls()).toBe(1)
  })

  test("the item budget evicts older lists and never stores an oversized one", async () => {
    const { cache, clock } = harness()
    await cache.get(1, () => Promise.resolve(list(3_000, "a")))
    clock.now = T0 + 1
    await cache.get(2, () => Promise.resolve(list(2_500, "b")))
    expect(cache.stats()).toEqual({ entries: 1, items: 2_500 })

    // Oversized for a cold id: returned, not stored.
    clock.now = T0 + 2
    const big = list(REPO_CACHE_MAX_ITEMS + 1, "c")
    const result = await cache.get(3, () => Promise.resolve(big))
    expect(result.items).toHaveLength(REPO_CACHE_MAX_ITEMS + 1)
    expect(cache.stats()).toEqual({ entries: 1, items: 2_500 })
    const again = counting(big)
    await cache.get(3, again.fetch)
    expect(again.calls()).toBe(1)

    // Oversized for an id that had an entry: the entry goes too.
    clock.now = T0 + REPO_LIST_TTL_MS + 1
    await cache.get(2, () => Promise.resolve(big))
    expect(cache.stats()).toEqual({ entries: 0, items: 0 })
  })

  test("entries past the max age are swept by the next get of any id", async () => {
    const { cache, clock } = harness()
    await cache.get(1, () => Promise.resolve(["one"]))
    clock.now = T0 + REPO_LIST_STALE_MAX_AGE_MS + 1
    await cache.get(2, () => Promise.resolve(["two"]))
    expect(cache.stats()).toEqual({ entries: 1, items: 1 })

    // The survivor is id 2: it is served from the cache, id 1 is fetched.
    const two = counting(["two"])
    await cache.get(2, two.fetch)
    expect(two.calls()).toBe(0)
    const one = counting(["one"])
    await cache.get(1, one.fetch)
    expect(one.calls()).toBe(1)
  })

  test("forget and clear drop entries", async () => {
    const { cache } = harness()
    await cache.get(1, () => Promise.resolve(["a"]))
    await cache.get(2, () => Promise.resolve(["b"]))

    cache.forget(1)
    const stub = counting(["a"])
    await cache.get(1, stub.fetch)
    expect(stub.calls()).toBe(1)

    cache.clear()
    expect(cache.stats()).toEqual({ entries: 0, items: 0 })
  })

  test("forget during an in-flight fetch: the caller still gets items, nothing is stored, the next get refetches", async () => {
    const { cache } = harness()
    let release: (items: readonly string[]) => void = () => undefined
    const first = cache.get(
      1,
      () =>
        new Promise<readonly string[]>((resolve) => {
          release = resolve
        }),
    )

    cache.forget(1)
    const second = counting(["fresh"])
    const secondResult = cache.get(1, second.fetch)
    expect(second.calls()).toBe(1)

    release(["from-before-forget"])
    expect((await first).items).toEqual(["from-before-forget"])
    expect((await secondResult).items).toEqual(["fresh"])
    // Only the second list is stored: it started after the forget, the first
    // started before it and describes a grant the forget said is gone.
    expect(cache.stats()).toEqual({ entries: 1, items: 1 })
  })

  test("forget during an in-flight fetch leaves no entry behind", async () => {
    const { cache } = harness()
    let release: (items: readonly string[]) => void = () => undefined
    const first = cache.get(
      1,
      () =>
        new Promise<readonly string[]>((resolve) => {
          release = resolve
        }),
    )
    cache.forget(1)
    release(["stale-grant"])
    expect((await first).items).toEqual(["stale-grant"])
    expect(cache.stats().entries).toBe(0)
  })
})
