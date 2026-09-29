import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GitHubError } from "./api.ts"
import {
  ArchiveError,
  type ArchiveTimings,
  downloadArchive,
  fetchArchive,
  type RetryReason,
} from "./archive-fetch.ts"

/**
 * The archive download against a real local server and a real `tar`: the
 * stops, the retry and the wipe are all about how a stream, a subprocess and a
 * watchdog interleave, which a mocked fetch would not exercise.
 */

const REPO = "owner/name"

const TIMINGS: ArchiveTimings = {
  stallMs: 300,
  watchIntervalMs: 50,
  killGraceMs: 500,
  drainMs: 200,
  capMs: 10_000,
}

/** Upper bound on how long a stopped attempt may take to settle. */
const STALL_BOUND_MS =
  TIMINGS.stallMs + TIMINGS.watchIntervalMs + TIMINGS.killGraceMs + 1000

const temps: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "musdash-archive-"))
  temps.push(dir)
  return dir
}

let GOOD: Uint8Array
let FIRST: Uint8Array

/** A real gzipped tarball of `files` (paths under `wrapper/`), in that order. */
function makeArchive(files: Record<string, Uint8Array | string>): Uint8Array {
  const dir = tempDir()
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path)
    mkdirSync(join(full, ".."), { recursive: true })
    writeFileSync(full, content)
  }
  const out = join(dir, "out.tgz")
  const tar = Bun.spawnSync(["tar", "-czf", out, ...Object.keys(files)], {
    cwd: dir,
  })
  if (tar.exitCode !== 0) throw new Error("could not build a test archive")
  return new Uint8Array(readFileSync(out))
}

beforeAll(() => {
  GOOD = makeArchive({
    "wrapper/README.md": "# hello\n",
    "wrapper/app/index.js": "console.log('hi')\n",
  })
  FIRST = makeArchive({
    "wrapper/only-in-first.txt": "first attempt\n",
    // 1 MiB rather than the brief's 256 KiB: GNU gzip 1.12 fills a 256 KiB
    // input buffer (or reaches end-of-file) before it decodes anything, so a
    // half-archive smaller than that reaches tar as nothing at all, and the
    // first attempt would leave nothing behind for the wipe to remove.
    "wrapper/pad.bin": randomBytes(1024 * 1024),
  })
})

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

/** The first half of FIRST, then a connection that never sends another byte. */
function partialThenHang(): Response {
  const half = FIRST.subarray(0, Math.floor(FIRST.length / 2))
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(half)
      },
    }),
  )
}

interface Codeload {
  location: string
  hits: () => number
  stop: () => Promise<void>
}

/**
 * A local codeload whose nth request (from 1) is answered by `respond(n)`.
 *
 * `hang()` is a response that never arrives while the test runs. It is
 * released when the server stops: Bun 1.3.11's `stop(true)` waits for a
 * pending handler, so a promise that truly never settled would hang the test.
 */
function codeload(
  respond: (
    n: number,
    hang: () => Promise<Response>,
  ) => Response | Promise<Response>,
): Codeload {
  let hits = 0
  const release: (() => void)[] = []
  const hang = () =>
    new Promise<Response>((resolve) => {
      release.push(() => resolve(new Response(null, { status: 503 })))
    })
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req): Response | Promise<Response> {
      if (new URL(req.url).pathname !== "/archive") {
        return new Response(null, { status: 418 })
      }
      hits += 1
      return respond(hits, hang)
    },
  })
  return {
    location: `http://127.0.0.1:${server.port}/archive`,
    hits: () => hits,
    stop: () => {
      for (const r of release) r()
      // Forced: the hanging bodies would otherwise hold it open.
      return server.stop(true)
    },
  }
}

/** The api hop, answering with a redirect to `location` and counting calls. */
function locator(location: string): {
  locate: () => Promise<Response>
  calls: () => number
} {
  let calls = 0
  return {
    locate: () => {
      calls += 1
      return Promise.resolve(
        new Response(null, { status: 302, headers: { location } }),
      )
    },
    calls: () => calls,
  }
}

/** The settled rejection of `p`, or a failure if it resolved. */
async function rejection(p: Promise<void>): Promise<unknown> {
  try {
    await p
  } catch (err) {
    return err
  }
  throw new Error("expected the download to fail")
}

describe("fetchArchive stops a stalled download", () => {
  test("(a) a body that stops mid-archive is a stall", async () => {
    const server = codeload(() => partialThenHang())
    try {
      const { locate } = locator(server.location)
      const started = Date.now()
      const err = await rejection(
        fetchArchive({
          repo: REPO,
          dest: tempDir(),
          deadline: Date.now() + TIMINGS.capMs,
          timings: TIMINGS,
          locate,
        }),
      )
      const elapsed = Date.now() - started
      expect(err).toBeInstanceOf(ArchiveError)
      const archiveErr = err as ArchiveError
      expect(archiveErr.failure).toBe("stall")
      expect(archiveErr.message).toMatch(
        /^The archive download for owner\/name stalled: no data for \d+s after \d+\.\d MB, so it was stopped$/,
      )
      expect(elapsed).toBeLessThan(STALL_BOUND_MS)
    } finally {
      await server.stop()
    }
  })

  test("(b) a host that never sends headers is a stall at 0 bytes", async () => {
    const server = codeload((_n, hang) => hang())
    try {
      const { locate } = locator(server.location)
      const started = Date.now()
      const err = await rejection(
        fetchArchive({
          repo: REPO,
          dest: tempDir(),
          deadline: Date.now() + TIMINGS.capMs,
          timings: TIMINGS,
          locate,
        }),
      )
      const elapsed = Date.now() - started
      expect(err).toBeInstanceOf(ArchiveError)
      const archiveErr = err as ArchiveError
      expect(archiveErr.failure).toBe("stall")
      expect(archiveErr.bytes).toBe(0)
      expect(archiveErr.message).toContain("after 0.0 MB")
      expect(elapsed).toBeLessThan(STALL_BOUND_MS)
    } finally {
      await server.stop()
    }
  })
})

describe("downloadArchive retries once", () => {
  test("(c1) a 503 from codeload is retried and the second attempt extracts", async () => {
    const server = codeload((n) =>
      n === 1 ? new Response("busy", { status: 503 }) : new Response(GOOD),
    )
    try {
      const { locate, calls } = locator(server.location)
      const dest = tempDir()
      const reasons: RetryReason[] = []
      await downloadArchive({
        repo: REPO,
        dest,
        timings: TIMINGS,
        locate,
        onRetry: (reason) => reasons.push(reason),
      })
      expect(server.hits()).toBe(2)
      expect(calls()).toBe(2)
      expect(reasons).toEqual([{ kind: "http", status: 503 }])
      expect(existsSync(join(dest, "README.md"))).toBe(true)
    } finally {
      await server.stop()
    }
  })

  test("(c2) a stall is retried into an emptied destination, in place", async () => {
    const server = codeload((n) =>
      n === 1 ? partialThenHang() : new Response(GOOD),
    )
    try {
      const { locate } = locator(server.location)
      const parent = tempDir()
      const dest = join(parent, "dest")
      mkdirSync(dest)
      writeFileSync(join(parent, "sibling.txt"), "not ours\n")
      const reasons: RetryReason[] = []
      let firstAttemptWrote = false
      await downloadArchive({
        repo: REPO,
        dest,
        timings: TIMINGS,
        locate,
        onRetry: (reason) => {
          reasons.push(reason)
          firstAttemptWrote = existsSync(join(dest, "only-in-first.txt"))
        },
      })
      expect(reasons).toHaveLength(1)
      expect(reasons[0]?.kind).toBe("stall")
      expect(firstAttemptWrote).toBe(true)
      expect(existsSync(join(dest, "only-in-first.txt"))).toBe(false)
      expect(existsSync(join(dest, "pad.bin"))).toBe(false)
      expect(existsSync(join(dest, "README.md"))).toBe(true)
      expect(existsSync(join(parent, "sibling.txt"))).toBe(true)
      expect(existsSync(dest)).toBe(true)
    } finally {
      await server.stop()
    }
  })
})

describe("a connection lost mid-body", () => {
  test("(g) is a network failure, retried once, and says how far it got", async () => {
    // Bun.serve cannot drop a connection mid-body, so a raw socket does: the
    // headers and part of FIRST, then the connection closes. Both runtimes
    // reject the body read with "socket connection was closed unexpectedly";
    // this pins that fetchArchive classifies it as a lost connection, not as
    // tar's truncated-gzip error.
    let hits = 0
    const half = FIRST.subarray(0, Math.floor(FIRST.length / 2))
    const server = createServer((socket) => {
      socket.once("data", () => {
        hits += 1
        socket.write(
          `HTTP/1.1 200 OK\r\nContent-Length: ${FIRST.length}\r\n\r\n`,
        )
        socket.write(half, () => socket.destroy())
      })
    })
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve)
    })
    try {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      const { locate, calls } = locator(`http://127.0.0.1:${port}/archive`)
      const reasons: RetryReason[] = []
      const err = await rejection(
        downloadArchive({
          repo: REPO,
          dest: tempDir(),
          timings: TIMINGS,
          locate,
          onRetry: (reason) => reasons.push(reason),
        }),
      )
      expect(err).toBeInstanceOf(ArchiveError)
      expect(err instanceof ArchiveError ? err.failure : "").toBe("network")
      expect(err instanceof Error ? err.message : "").toMatch(
        /^The archive download for owner\/name lost its connection after \d+\.\d MB$/,
      )
      expect(reasons).toEqual([{ kind: "network" }])
      expect(hits).toBe(2)
      expect(calls()).toBe(2)
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    }
  })
})

describe("downloadArchive does not retry", () => {
  test("(d) a 404 from codeload, or a 4xx from the api hop", async () => {
    const server = codeload(() => new Response("gone", { status: 404 }))
    try {
      const { locate } = locator(server.location)
      let retries = 0
      const err = await rejection(
        downloadArchive({
          repo: REPO,
          dest: tempDir(),
          timings: TIMINGS,
          locate,
          onRetry: () => {
            retries += 1
          },
        }),
      )
      expect(err).toBeInstanceOf(GitHubError)
      expect((err as GitHubError).status).toBe(404)
      expect((err as GitHubError).message).toBe(
        "GitHub's archive host returned 404 for owner/name",
      )
      expect(server.hits()).toBe(1)
      expect(retries).toBe(0)
    } finally {
      await server.stop()
    }

    const apiErr = new GitHubError("x", 404)
    let locates = 0
    let retries = 0
    const err = await rejection(
      downloadArchive({
        repo: REPO,
        dest: tempDir(),
        timings: TIMINGS,
        locate: () => {
          locates += 1
          return Promise.reject(apiErr)
        },
        onRetry: () => {
          retries += 1
        },
      }),
    )
    expect(err).toBe(apiErr)
    expect(locates).toBe(1)
    expect(retries).toBe(0)
  })

  test("(e) a trickle that never finishes hits the cap", async () => {
    const timers = new Set<Timer>()
    const server = codeload(() => {
      let at = 0
      let timer: Timer | undefined
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            timer = setInterval(() => {
              if (at >= FIRST.length) return
              try {
                controller.enqueue(FIRST.subarray(at, at + 1))
                at += 1
              } catch {
                clearInterval(timer)
              }
            }, 20)
            timers.add(timer)
          },
          cancel() {
            clearInterval(timer)
          },
        }),
      )
    })
    try {
      const { locate } = locator(server.location)
      const timings = { ...TIMINGS, capMs: 800 }
      let retries = 0
      const started = Date.now()
      const err = await rejection(
        downloadArchive({
          repo: REPO,
          dest: tempDir(),
          timings,
          locate,
          onRetry: () => {
            retries += 1
          },
        }),
      )
      const elapsed = Date.now() - started
      expect(err).toBeInstanceOf(ArchiveError)
      const archiveErr = err as ArchiveError
      expect(archiveErr.failure).toBe("cap")
      expect(archiveErr.message).toMatch(
        /^The archive download for owner\/name did not finish within .+, so it was stopped$/,
      )
      expect(server.hits()).toBe(1)
      expect(retries).toBe(0)
      expect(elapsed).toBeLessThan(
        timings.capMs + timings.watchIntervalMs + timings.killGraceMs + 1000,
      )
    } finally {
      for (const timer of timers) clearInterval(timer)
      await server.stop()
    }
  })

  test("(f) a body that is not a gzip is a tar failure", async () => {
    const server = codeload(() => new Response(randomBytes(4096)))
    try {
      const { locate } = locator(server.location)
      let retries = 0
      const err = await rejection(
        downloadArchive({
          repo: REPO,
          dest: tempDir(),
          timings: TIMINGS,
          locate,
          onRetry: () => {
            retries += 1
          },
        }),
      )
      expect(err).toBeInstanceOf(ArchiveError)
      const archiveErr = err as ArchiveError
      expect(archiveErr.failure).toBe("tar")
      expect(archiveErr.message).toMatch(/^tar exited [1-9]\d*: /)
      expect(server.hits()).toBe(1)
      expect(retries).toBe(0)
    } finally {
      await server.stop()
    }
  })
})
