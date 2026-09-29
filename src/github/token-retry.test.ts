import { describe, expect, test } from "bun:test"
import { GitHubError } from "./api.ts"
import { dropIfCurrent, withTokenRetry } from "./token-retry.ts"

/**
 * The 401 retry rule: exactly one retry, only on a GitHubError 401, never after
 * a failed acquire. Plain stubs — the helper has no other dependencies.
 */

interface Recorder {
  acquired: number
  invalidated: string[]
  calls: string[]
}

function deps(tokens: string[], rec: Recorder) {
  return {
    acquire: () => {
      const token = tokens[rec.acquired] ?? "exhausted"
      rec.acquired++
      return Promise.resolve(token)
    },
    invalidate: (failed: string) => {
      rec.invalidated.push(failed)
    },
  }
}

function recorder(): Recorder {
  return { acquired: 0, invalidated: [], calls: [] }
}

describe("withTokenRetry", () => {
  test("a first call that succeeds acquires and calls once", async () => {
    const rec = recorder()
    const result = await withTokenRetry(deps(["t1"], rec), (token) => {
      rec.calls.push(token)
      return Promise.resolve("ok")
    })

    expect(result).toBe("ok")
    expect(rec.acquired).toBe(1)
    expect(rec.calls).toEqual(["t1"])
    expect(rec.invalidated).toEqual([])
  })

  test("a 401 invalidates the first token and retries with a fresh one", async () => {
    const rec = recorder()
    const result = await withTokenRetry(deps(["t1", "t2"], rec), (token) => {
      rec.calls.push(token)
      if (token === "t1") {
        return Promise.reject(new GitHubError("rejected", 401))
      }
      return Promise.resolve("ok")
    })

    expect(result).toBe("ok")
    expect(rec.acquired).toBe(2)
    expect(rec.invalidated).toEqual(["t1"])
    expect(rec.calls).toEqual(["t1", "t2"])
  })

  test("a second 401 surfaces as the same instance, after exactly two calls", async () => {
    const rec = recorder()
    const secondError = new GitHubError("still rejected", 401)
    const promise = withTokenRetry(deps(["t1", "t2"], rec), (token) => {
      rec.calls.push(token)
      return Promise.reject(
        token === "t1" ? new GitHubError("rejected", 401) : secondError,
      )
    })

    let caught: unknown
    try {
      await promise
    } catch (err) {
      caught = err
    }
    expect(caught).toBe(secondError)
    expect(rec.calls).toEqual(["t1", "t2"])
    expect(rec.invalidated).toEqual(["t1"])
  })

  for (const make of [
    () => new GitHubError("forbidden", 403),
    () => new GitHubError("not found", 404),
    () => new GitHubError("server error", 500),
    () => new TypeError("fetch failed"),
  ]) {
    const sample = make()
    test(`${sample.name} ${sample instanceof GitHubError ? sample.status : ""} is rethrown unchanged without a retry`, async () => {
      const rec = recorder()
      const thrown = make()
      let caught: unknown
      try {
        await withTokenRetry(deps(["t1", "t2"], rec), (token) => {
          rec.calls.push(token)
          return Promise.reject(thrown)
        })
      } catch (err) {
        caught = err
      }
      expect(caught).toBe(thrown)
      expect(rec.calls).toEqual(["t1"])
      expect(rec.acquired).toBe(1)
      expect(rec.invalidated).toEqual([])
    })
  }

  test("a rejected first acquire is never retried, even as a GitHubError 401", async () => {
    const rec = recorder()
    const mintFailure = new GitHubError("mint rejected", 401)
    let acquires = 0
    let caught: unknown
    try {
      await withTokenRetry(
        {
          acquire: () => {
            acquires++
            return Promise.reject(mintFailure)
          },
          invalidate: (failed) => {
            rec.invalidated.push(failed)
          },
        },
        (token) => {
          rec.calls.push(token)
          return Promise.resolve("ok")
        },
      )
    } catch (err) {
      caught = err
    }
    expect(caught).toBe(mintFailure)
    expect(acquires).toBe(1)
    expect(rec.calls).toEqual([])
    expect(rec.invalidated).toEqual([])
  })
})

describe("dropIfCurrent", () => {
  test("deletes the entry and returns true when it holds the failed token", () => {
    const cache = new Map([[7, { token: "old", expiresAt: 1 }]])
    expect(dropIfCurrent(cache, 7, "old")).toBe(true)
    expect(cache.has(7)).toBe(false)
  })

  test("leaves a newer token in place and returns false", () => {
    const cache = new Map([[7, { token: "new", expiresAt: 1 }]])
    expect(dropIfCurrent(cache, 7, "old")).toBe(false)
    expect(cache.get(7)?.token).toBe("new")
  })

  test("returns false when there is no entry", () => {
    const cache = new Map<number, { token: string }>()
    expect(dropIfCurrent(cache, 7, "old")).toBe(false)
  })
})
