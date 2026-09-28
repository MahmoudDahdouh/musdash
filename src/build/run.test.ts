import { tmpdir } from "node:os"
import { describe, expect, test } from "bun:test"
import { runBuilder } from "./run.ts"
import type { BuildContext } from "./types.ts"

/**
 * These run a real subprocess, `sh`, in place of railpack or buildctl: what is
 * under test is how the runner ends a build and what it says about it, and the
 * one real failure it exists for was a build that stalled at BuildKit's memory
 * cap for the whole 30-minute timeout, then reported "railpack exited with code
 * 1" (P-9). Every script `exec`s its sleep so the kill reaches the process that
 * holds the pipes — a shell left waiting on a child would keep them open.
 */

function ctx(overrides: Partial<BuildContext> = {}): BuildContext {
  return {
    contextDir: tmpdir(),
    tag: "musdash/test:abc",
    cacheKey: "test",
    buildArgs: {},
    onLog: () => {},
    timeoutMs: 10_000,
    ...overrides,
  }
}

function sh(script: string, c: BuildContext): Promise<void> {
  return runBuilder("sh", ["-c", script], c, {}, tmpdir())
}

describe("runBuilder", () => {
  test("a silent build pinned at the memory cap is stopped as out of memory", async () => {
    const started = Date.now()
    const run = sh(
      "exec sleep 30",
      ctx({
        stall: { afterMs: 200, isStarved: () => Promise.resolve(true) },
        memoryAdvice: "ADVICE",
      }),
    )

    await expect(run).rejects.toThrow(/memory/)
    await expect(run).rejects.toThrow(/ADVICE/)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test("a silent build below the memory cap is left to finish", async () => {
    const run = sh(
      "exec sleep 0.8",
      ctx({
        stall: { afterMs: 100, isStarved: () => Promise.resolve(false) },
      }),
    )

    await expect(run).resolves.toBeUndefined()
  })

  test("output resets the silence clock", async () => {
    const run = sh(
      "for i in 1 2 3 4 5 6; do echo tick; sleep 0.15; done",
      ctx({
        stall: { afterMs: 400, isStarved: () => Promise.resolve(true) },
      }),
    )

    await expect(run).resolves.toBeUndefined()
  })

  test("a build that exits 0 is a success, whatever the stall check decided", async () => {
    // The stall verdict is asynchronous — a stats round-trip — so it can land
    // as the build finishes. Here it stops a builder that then exits 0, the
    // same outcome as a verdict arriving after a real success.
    const run = sh(
      "trap 'exit 0' TERM; sleep 30 >/dev/null 2>&1 & wait",
      ctx({ stall: { afterMs: 100, isStarved: () => Promise.resolve(true) } }),
    )

    await expect(run).resolves.toBeUndefined()
  })

  test("a build past the timeout says it timed out", async () => {
    const run = sh("exec sleep 30", ctx({ timeoutMs: 200 }))

    await expect(run).rejects.toThrow(/did not finish within/)
  })

  test("a stopped build ends even when a child still holds its pipes", async () => {
    // The builder is killed, but a process it started keeps stdout open. The
    // runner must not wait for that pipe to close, or it holds the one worker
    // until musdash restarts.
    const started = Date.now()
    const run = sh("sleep 30 & exec sleep 30", ctx({ timeoutMs: 200 }))

    await expect(run).rejects.toThrow(/did not finish within/)
    expect(Date.now() - started).toBeLessThan(8_000)
  })

  test("output during the stall check cancels the stop", async () => {
    // The verdict takes a stats round-trip; a line printed meanwhile means the
    // build is moving, so the verdict is stale.
    let calls = 0
    const run = sh(
      "sleep 0.3; echo moving; exec sleep 0.6",
      ctx({
        stall: {
          afterMs: 200,
          isStarved: async () => {
            calls += 1
            await Bun.sleep(calls === 1 ? 250 : 5_000)
            return true
          },
        },
      }),
    )

    await expect(run).resolves.toBeUndefined()
  })

  test("a step killed with exit code 137 is reported as out of memory", async () => {
    const run = sh(
      'echo "ERROR: process \\"/bin/sh -c npm ci\\" did not complete successfully: exit code: 137"; exit 1',
      ctx({ memoryAdvice: "ADVICE" }),
    )

    await expect(run).rejects.toThrow(/out of memory/)
    await expect(run).rejects.toThrow(/ADVICE/)
  })

  test("a step BuildKit could not give memory is reported as out of memory", async () => {
    // What the 1GB host printed for `next build` once BuildKit's swap was
    // full, 2026-09-28 (R-2): no exit code at all.
    const run = sh(
      'echo "#17 ERROR: process \\"npm run build\\" did not complete successfully: cannot allocate memory"; exit 1',
      ctx({ memoryAdvice: "ADVICE" }),
    )

    await expect(run).rejects.toThrow(/out of memory/)
    await expect(run).rejects.toThrow(/ADVICE/)
  })

  test("a Next.js build with Turbopack that runs out of memory names the webpack fix", async () => {
    // What the 2GB host printed before `next build` pinned BuildKit at its
    // 960 MiB cap; the same app built with webpack in under half of it (T-3).
    const run = sh(
      'echo "#18 1.297 ▲ Next.js 16.3.2 (Turbopack)"; exec sleep 30',
      ctx({
        stall: { afterMs: 200, isStarved: () => Promise.resolve(true) },
        memoryAdvice: "ADVICE",
      }),
    )

    await expect(run).rejects.toThrow(/--webpack/)
    await expect(run).rejects.toThrow(/RAILPACK_BUILD_CMD/)
    await expect(run).rejects.toThrow(/ADVICE/)
  })

  test("any other build that runs out of memory does not mention webpack", async () => {
    const run = sh(
      'echo "#18 1.297 ▲ Next.js 16.3.2 (webpack)"; echo "#18 ERROR: process \\"npm run build\\" did not complete successfully: exit code: 137"; exit 1',
      ctx({ memoryAdvice: "ADVICE" }),
    )

    await expect(run).rejects.toThrow(/out of memory/)
    await expect(run).rejects.not.toThrow(/--webpack/)
  })

  test("a gRPC ResourceExhausted that is not about memory is not called memory", async () => {
    // BuildKit's message-size error shares the status code, and an app's own
    // compiler output can name it too.
    const run = sh(
      'echo "error: rpc error: code = ResourceExhausted desc = grpc: received message larger than max (5242880 vs. 4194304)"; echo "src/api.ts:3:14 - error TS2339: Property Code.ResourceExhausted does not exist"; exit 1',
      ctx(),
    )

    await expect(run).rejects.toThrow(/sh exited with code 1/)
  })

  test("any other failure names the exit code", async () => {
    const run = sh("echo nope; exit 3", ctx())

    await expect(run).rejects.toThrow(/sh exited with code 3/)
  })
})
