import { describe, expect, test } from "bun:test"
import {
  createGate,
  GateBusyError,
  hashPassword,
  needsRehash,
  verifyPassword,
} from "./password.ts"

/**
 * Two things here are one careless edit away from a silent regression (D34):
 * a gate that fails to release locks the only user out for good, and a misread
 * `memoryCost` unit either brings back the 64 MiB-per-login peak (V-3) or ships
 * a trivially weak hash. Neither shows up in a manual click-through.
 */

interface Deferred {
  promise: Promise<void>
  resolve: () => void
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Lets every pending continuation run before the test looks again. */
function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

// Bun's own example of a default-parameter hash (bun-types bun.d.ts). A LITERAL
// on purpose: generating it with Bun's hasher here would put a second call site
// outside src/password.ts, which criterion 2 forbids.
const OLD_DEFAULT_HASH =
  "$argon2id$v=19$m=65536,t=2,p=1$ddbcyBcbAcagei7wSkZFiouX6TqnUQHmTyS5mxGCzeM$+3OIaFatZ3n6LtMhUlfWbgJyNp7h8/oIsLK+LzZO+WI"

describe("parameters", () => {
  test("hashPassword encodes m=7168 KiB, t=5, p=1 and verifies", async () => {
    const hash = await hashPassword("correct horse battery")
    expect(hash.startsWith("$argon2id$v=19$m=7168,t=5,p=1$")).toBe(true)
    expect(await verifyPassword("correct horse battery", hash)).toBe(true)
    expect(await verifyPassword("wrong horse battery", hash)).toBe(false)
  })

  test("needsRehash is false only for the current parameters", async () => {
    const current = await hashPassword("correct horse battery")
    expect(needsRehash(current)).toBe(false)
    expect(needsRehash(OLD_DEFAULT_HASH)).toBe(true)
    expect(
      needsRehash(
        "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy",
      ),
    ).toBe(true)
    expect(needsRehash("not-a-hash")).toBe(true)
  })
})

describe("createGate", () => {
  test("runs one task at a time, in submission order", async () => {
    const gate = createGate(8)
    const blockers = Array.from({ length: 5 }, deferred)
    const started: number[] = []
    let running = 0
    let maxRunning = 0

    const runs = blockers.map((b, i) =>
      gate.run(async () => {
        running += 1
        maxRunning = Math.max(maxRunning, running)
        started.push(i)
        await b.promise
        running -= 1
        return i
      }),
    )

    for (const b of blockers) {
      await settle()
      expect(gate.active).toBe(1)
      b.resolve()
    }
    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3, 4])
    expect(maxRunning).toBe(1)
    expect(started).toEqual([0, 1, 2, 3, 4])
    expect(gate.active).toBe(0)
    expect(gate.waiting).toBe(0)
  })

  test("rejects beyond maxWaiting without calling the task", async () => {
    const gate = createGate(2)
    const first = deferred()
    const running = gate.run(() => first.promise)
    const waitA = gate.run(() => Promise.resolve("a"))
    const waitB = gate.run(() => Promise.resolve("b"))
    await settle()
    expect(gate.active).toBe(1)
    expect(gate.waiting).toBe(2)

    let called = false
    const overflow = gate.run(() => {
      called = true
      return Promise.resolve("overflow")
    })
    // Raced against a short timer rather than awaited directly: when the bound
    // is broken the overflow task is queued instead of refused, so awaiting it
    // would wait for `first` forever. A broken bound then left `bun test`
    // spinning without exiting, hanging CI instead of failing it.
    const outcome = await Promise.race([
      overflow.then(
        () => "accepted",
        (err: unknown) => err,
      ),
      Bun.sleep(200).then(() => "still queued"),
    ])
    first.resolve()
    expect(outcome).toBeInstanceOf(GateBusyError)
    expect(called).toBe(false)
    await running
    const accepted = gate.run(() => Promise.resolve("after"))
    expect(await waitA).toBe("a")
    expect(await waitB).toBe("b")
    expect(await accepted).toBe("after")
  })

  test("a rejecting task and a sync-throwing task each release the gate", async () => {
    const gate = createGate(8)
    const hold = deferred()
    const head = gate.run(() => hold.promise)

    const rejects = gate.run(() => Promise.reject(new Error("rejected")))
    const throwsSync = gate.run((): Promise<string> => {
      throw new TypeError("thrown")
    })
    const next = gate.run(() => Promise.resolve("next ran"))

    hold.resolve()
    await head
    const rejectsErr = await rejects.catch((e: unknown) => e)
    expect(rejectsErr).toBeInstanceOf(Error)
    expect(rejectsErr).not.toBeInstanceOf(GateBusyError)
    expect(rejectsErr).toHaveProperty("message", "rejected")

    const throwErr = await throwsSync.catch((e: unknown) => e)
    expect(throwErr).toBeInstanceOf(TypeError)
    expect(throwErr).toHaveProperty("message", "thrown")

    expect(await next).toBe("next ran")
    expect(gate.active).toBe(0)
    expect(gate.waiting).toBe(0)
  })
})
