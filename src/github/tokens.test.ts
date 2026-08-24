import { describe, expect, test } from "bun:test"

/**
 * The token cache's concurrency behaviour, which is the one piece of Checkpoint
 * 4 with real logic rather than plumbing — the same category as job claiming.
 *
 * The module under test reads the database for App credentials, so rather than
 * standing up a database these tests exercise the exact caching algorithm in
 * isolation. What is being proven is the promise bookkeeping, and that is
 * reproduced here verbatim from tokens.ts.
 */

interface Cached {
  token: string
  expiresAt: number
}

function makeCache(mint: () => Promise<Cached>, skewMs = 60_000) {
  const cache = new Map<number, Cached>()
  const inFlight = new Map<number, Promise<string>>()

  return {
    cache,
    get(id: number): Promise<string> {
      const hit = cache.get(id)
      if (hit && hit.expiresAt - skewMs > Date.now()) {
        return Promise.resolve(hit.token)
      }
      const pending = inFlight.get(id)
      if (pending) return pending

      const promise = mint()
        .then((m) => {
          cache.set(id, m)
          return m.token
        })
        .finally(() => {
          inFlight.delete(id)
        })
      inFlight.set(id, promise)
      return promise
    },
  }
}

describe("installation token cache", () => {
  test("collapses concurrent misses into one mint", async () => {
    let mints = 0
    const c = makeCache(async () => {
      mints++
      await Bun.sleep(20)
      return { token: "tok", expiresAt: Date.now() + 3_600_000 }
    })

    const results = await Promise.all(
      Array.from({ length: 20 }, () => c.get(1)),
    )

    expect(mints).toBe(1)
    expect(results.every((t) => t === "tok")).toBe(true)
  })

  test("serves a cached token without minting again", async () => {
    let mints = 0
    const c = makeCache(() => {
      mints++
      return Promise.resolve({
        token: `tok${mints}`,
        expiresAt: Date.now() + 3_600_000,
      })
    })

    expect(await c.get(1)).toBe("tok1")
    expect(await c.get(1)).toBe("tok1")
    expect(mints).toBe(1)
  })

  test("re-mints once the token is inside the skew window", async () => {
    let mints = 0
    const c = makeCache(() => {
      mints++
      // Already within the 60s refresh skew, so it is never considered fresh.
      return Promise.resolve({
        token: `tok${mints}`,
        expiresAt: Date.now() + 30_000,
      })
    })

    expect(await c.get(1)).toBe("tok1")
    expect(await c.get(1)).toBe("tok2")
    expect(mints).toBe(2)
  })

  test("a failed mint does not poison the cache", async () => {
    // The reason cleanup uses .finally rather than .then: with .then, the
    // rejected promise stays in the in-flight map and every later call awaits
    // the same failure forever.
    let attempts = 0
    const c = makeCache(() => {
      attempts++
      if (attempts === 1) return Promise.reject(new Error("network blip"))
      return Promise.resolve({
        token: "recovered",
        expiresAt: Date.now() + 3_600_000,
      })
    })

    await expect(c.get(1)).rejects.toThrow("network blip")
    expect(await c.get(1)).toBe("recovered")
    expect(attempts).toBe(2)
  })

  test("keeps separate tokens per installation", async () => {
    let mints = 0
    const c = makeCache(() => {
      mints++
      return Promise.resolve({
        token: `tok${mints}`,
        expiresAt: Date.now() + 3_600_000,
      })
    })

    const [a, b] = await Promise.all([c.get(1), c.get(2)])
    expect(a).not.toBe(b)
    expect(mints).toBe(2)
  })
})
