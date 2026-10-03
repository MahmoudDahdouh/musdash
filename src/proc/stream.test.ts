import { tmpdir } from "node:os"
import { describe, expect, test } from "bun:test"
import { SpawnError, spawnStreaming } from "./stream.ts"

/**
 * The pump shared by the builders and the Compose CLI. These run a real `sh`;
 * every long-running script `exec`s its sleep so a kill reaches the process
 * that holds the pipes.
 */

const ENV = { PATH: "/usr/bin:/bin" }

function run(
  script: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
) {
  const lines: string[] = []
  const result = spawnStreaming({
    argv: ["sh", "-c", script],
    cwd: tmpdir(),
    env: ENV,
    timeoutMs: opts.timeoutMs ?? 10_000,
    onLine: (line) => lines.push(line),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
  return { lines, result }
}

describe("spawnStreaming", () => {
  test("a line split across chunks is emitted whole, once", async () => {
    // Three writes, far enough apart to arrive as separate chunks: a line
    // emitted in pieces would defeat redaction of a secret it contains.
    const { lines, result } = run(
      "printf 'sec'; sleep 0.2; printf 'ret\\nsec'; sleep 0.2; printf 'ond\\n'; printf tail",
    )
    const r = await result
    expect(r.exitCode).toBe(0)
    expect(r.stopped).toBeNull()
    expect(lines).toEqual(["secret", "second", "tail"])
  })

  test("a process past the timeout is stopped and says so", async () => {
    const started = Date.now()
    const { result } = run("exec sleep 30", { timeoutMs: 200 })
    const r = await result
    expect(r.stopped).toBe("timeout")
    expect(r.exitCode).not.toBe(0)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test("an abort stops the process, and the first reason wins", async () => {
    const controller = new AbortController()
    const { result } = run("exec sleep 30", {
      timeoutMs: 5_000,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 100)
    const r = await result
    expect(r.stopped).toBe("aborted")
  })

  test("a stop asked for after the process exited is no stop", async () => {
    const controller = new AbortController()
    const { result } = run("exit 3", { signal: controller.signal })
    const r = await result
    controller.abort()
    expect(r.exitCode).toBe(3)
    expect(r.stopped).toBeNull()
  })

  test("stderr's last lines come back for the error message", async () => {
    const { lines, result } = run(
      "echo out; echo first >&2; echo last >&2; exit 1",
    )
    const r = await result
    expect(r.exitCode).toBe(1)
    expect(r.stderrTail).toEqual(["first", "last"])
    expect(lines).toContain("out")
  })

  test("the environment is exactly what the caller passes", async () => {
    // A variable of this process must not reach the child.
    process.env.MUSDASH_STREAM_TEST = "inherited"
    try {
      const { lines, result } = run('echo "[$MUSDASH_STREAM_TEST]"')
      await result
      expect(lines).toEqual(["[]"])
    } finally {
      delete process.env.MUSDASH_STREAM_TEST
    }
  })

  test("a program that does not exist is a SpawnError with its code", async () => {
    const attempt = spawnStreaming({
      argv: ["musdash-no-such-program"],
      cwd: tmpdir(),
      env: ENV,
      timeoutMs: 1_000,
      onLine: () => {},
    })
    await expect(attempt).rejects.toBeInstanceOf(SpawnError)
    await attempt.catch((err: unknown) => {
      expect(err instanceof SpawnError ? err.code : null).toBe("ENOENT")
    })
  })
})
