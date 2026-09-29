import { config } from "../config.ts"
import { logger } from "../log.ts"
import { BuildError, type BuildContext } from "./types.ts"

/**
 * How BuildKit reports a step that ran out of memory. The builder itself then
 * exits 1, which on its own says nothing. Two shapes, both seen on the 1GB
 * host, both in BuildKit's own step-failure sentence:
 *
 * - the step's exit status, 137 being 128 + SIGKILL: `process "/bin/sh -c npm
 *   ci" did not complete successfully: exit code: 137`;
 * - with swap full, no exit status at all: `process "npm run build" did not
 *   complete successfully: cannot allocate memory` (R-2).
 *
 * Anchored to that sentence, because the check sees every line of the build,
 * the app's own compiler output included. The `ResourceExhausted` that follows
 * the second shape is left out: it is a general gRPC status that BuildKit also
 * uses for an oversized message, and an app can print it too.
 */
const MEMORY_KILL =
  /did not complete successfully: (?:exit code: 137\b|cannot allocate memory)/i

/**
 * The banner `next build` prints when it compiles with Turbopack: by default on
 * Next.js 16, with `--turbopack` on 15. Unanchored, because BuildKit prefixes
 * each line with its step, and open after the name, because the parentheses
 * can list more modes.
 */
const TURBOPACK = /Next\.js [\d.]+\S* \(Turbopack\b/

/**
 * Added to an out-of-memory message when the build was Next.js on Turbopack.
 * Measured on the 2GB host: Turbopack needed about 1.25 GiB for an app with
 * one page and stalled below that, while `next build --webpack` peaked at
 * 408 MiB and built inside BuildKit's 960 MiB cap (T-3, D52).
 */
const TURBOPACK_ADVICE =
  "This Next.js build used Turbopack, which needs about 1.25 GiB of memory; webpack needs about half. On Next.js 16, build with `next build --webpack` — for a Railpack build with npm, add the build variable `RAILPACK_BUILD_CMD=npm run build -- --webpack` on this resource, not its project or environment: every app there inherits it, and Next.js 15 and older reject the flag. On Next.js 15, remove `--turbopack` from the build script."

/**
 * What `next build` before Next.js 16 prints when given `--webpack`, a flag it
 * does not have. The usual source is the advice above set as a project or
 * environment variable, which reaches every Next.js app there whatever its
 * version: a Next.js 13 app on the 2GB host failed this way, and the exit code
 * alone said nothing about why (D52).
 */
const WEBPACK_FLAG_REJECTED = /Unknown or unexpected option: --webpack\b/

/** Added to a failed build's message when `next build` rejected `--webpack`. */
const WEBPACK_FLAG_ADVICE =
  "This Next.js version has no `--webpack` flag: before Next.js 16 it builds with webpack already. Remove `--webpack` from the build command. If `RAILPACK_BUILD_CMD` adds it and is inherited from the project or environment, set it only on the resource that needs it."

/**
 * The same rejection when musdash added the flag itself (next-webpack.ts): the
 * app's package.json named Next.js 16 or newer but the installed `next` was
 * older. No variable was inherited from anywhere, so the advice above would
 * send the user looking for one that does not exist.
 */
const WEBPACK_FLAG_AUTO_ADVICE =
  "musdash added `--webpack` to this build because the app's package.json names Next.js 16 or newer, but the installed Next.js is older and has no such flag. Set the build variable `RAILPACK_BUILD_CMD` on this resource — `RAILPACK_BUILD_CMD=npm run build`, for example — to choose the build command yourself; musdash then leaves it alone."

/** The longest a silent build waits between starvation checks. */
const STALL_POLL_MAX_MS = 15_000

/**
 * How long a stopped builder gets to exit after SIGTERM before SIGKILL. Both
 * railpack and buildctl cancel their solve on SIGTERM, which is the polite way
 * to ask the daemon to stop; one that cannot even do that is killed.
 */
const KILL_GRACE_MS = 10_000

/**
 * How long the output pipes get to drain once the builder has exited. A
 * process the builder started can inherit them and outlive it; waiting for
 * that one to close them would hold the single worker indefinitely.
 */
const DRAIN_MS = 2_000

/** "30 minutes", "1 minute", "12 seconds". */
function duration(ms: number): string {
  const [n, unit] =
    ms >= 60_000
      ? [Math.round(ms / 60_000), "minute"]
      : [Math.round(ms / 1000), "second"]
  return `${n} ${unit}${n === 1 ? "" : "s"}`
}

/**
 * Runs a build subprocess, streaming both streams through the redactor.
 *
 * stdout and stderr are read concurrently and merged: BuildKit writes progress
 * to stderr and results to stdout, so consuming them in sequence would block on
 * one while the other's pipe filled, and the build would deadlock at the buffer
 * size rather than finish.
 */
export async function runBuilder(
  bin: string,
  args: string[],
  ctx: BuildContext,
  env: Record<string, string>,
  cwd: string = config.buildsDir,
): Promise<void> {
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn([bin, ...args], {
      // The build context is passed as an argument, never as the working
      // directory, so nothing here depends on where musdash was started.
      cwd,
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    })
  } catch (cause) {
    throw new BuildError(
      `could not run ${bin}: ${(cause as Error).message}. Is it installed and on PATH?`,
    )
  }

  // Why the build was stopped, if it was. Decided before the process exits, so
  // the error names the cause rather than the builder's exit code: a stopped
  // railpack exits 1 with "context canceled", which reads as a code failure.
  let stopped: "timeout" | "starved" | null = null
  let killTimer: Timer | null = null
  // Set the moment the process exits, ahead of the code below. The stall
  // verdict is a stats round-trip that can land after the build has finished,
  // and must then change nothing — no kill, no verdict.
  let exited = false
  void proc.exited.then(() => {
    exited = true
  })
  const stop = (why: "timeout" | "starved") => {
    if (stopped !== null || exited) return
    stopped = why
    proc.kill()
    killTimer = setTimeout(() => proc.kill("SIGKILL"), KILL_GRACE_MS)
  }

  let lastOutputAt = Date.now()
  let sawMemoryKill = false
  let sawTurbopack = false
  let sawWebpackFlagRejected = false
  const onLog = (line: string) => {
    lastOutputAt = Date.now()
    if (MEMORY_KILL.test(line)) sawMemoryKill = true
    if (TURBOPACK.test(line)) sawTurbopack = true
    if (WEBPACK_FLAG_REJECTED.test(line)) sawWebpackFlagRejected = true
    ctx.onLog(line)
  }

  const timer = setTimeout(() => stop("timeout"), ctx.timeoutMs)

  // A build starved at BuildKit's cap is not killed: the kernel reclaims the
  // step's file pages over and over instead of OOM-killing it, and the build
  // prints nothing until the timeout ends it 30 minutes later (P-9). Silence alone is not enough to stop a
  // build — a long compile is silent too — so the daemon's memory is asked
  // about only once the build has been quiet for stall.afterMs, and the build
  // is stopped only if the daemon is pinned at its cap.
  const stall = ctx.stall
  let watchdog: Timer | null = null
  if (stall) {
    let checking = false
    watchdog = setInterval(
      () => {
        if (checking || stopped !== null) return
        if (Date.now() - lastOutputAt < stall.afterMs) return
        checking = true
        stall
          .isStarved()
          .then(
            (starved) => {
              // Still silent: a line printed during the round-trip means the
              // build is moving and the verdict is stale.
              const silent = Date.now() - lastOutputAt >= stall.afterMs
              if (starved && silent) stop("starved")
            },
            (err: unknown) => {
              logger.warn(
                { err: (err as Error).message },
                "could not read BuildKit's memory for the stall check",
              )
            },
          )
          .finally(() => {
            checking = false
          })
      },
      Math.max(50, Math.min(STALL_POLL_MAX_MS, stall.afterMs / 4)),
    )
  }

  // Read when a message is built, not now: whether the build was Turbopack is
  // known only from its output.
  const advice = () =>
    [sawTurbopack ? TURBOPACK_ADVICE : "", ctx.memoryAdvice ?? ""]
      .filter(Boolean)
      .map((a) => ` ${a}`)
      .join("")
  try {
    const readers: { cancel(): Promise<void> }[] = []
    // Observed from the start: the process can run for the whole timeout
    // before anything awaits these, and a pipe error in that time must not be
    // an unhandled rejection. It still surfaces through `finished` below if it
    // lands before the drain window ends; after that, it is about output
    // nobody is waiting for any more.
    const finished = Promise.all([
      pump(proc.stdout, onLog, readers),
      pump(proc.stderr, onLog, readers),
    ]).then(() => true)
    finished.catch(() => {})
    const code = await proc.exited
    // Normally the pipes close with the process and this returns at once.
    const drained = await Promise.race([
      finished,
      Bun.sleep(DRAIN_MS).then(() => false),
    ])
    if (!drained) {
      // Cancelling ends the pending reads; its own failure changes nothing.
      for (const reader of readers) void reader.cancel().catch(() => {})
    }
    // A builder that exits 0 built the image, whatever was decided about it
    // while it ran: a stop that crossed its last line in flight changes nothing.
    if (code === 0) return
    if (stopped === "starved") {
      throw new BuildError(
        `the build ran out of memory: BuildKit sat at its memory limit with no output for ${duration(stall?.afterMs ?? 0)}, so it was stopped.${advice()}`,
      )
    }
    if (stopped === "timeout") {
      throw new BuildError(
        `the build did not finish within ${duration(ctx.timeoutMs)} and was stopped`,
      )
    }
    if (sawMemoryKill) {
      throw new BuildError(`a build step ran out of memory.${advice()}`)
    }
    if (sawWebpackFlagRejected) {
      const flagAdvice =
        ctx.railpackBuildCmd === undefined
          ? WEBPACK_FLAG_ADVICE
          : WEBPACK_FLAG_AUTO_ADVICE
      throw new BuildError(`${bin} exited with code ${code}. ${flagAdvice}`)
    }
    throw new BuildError(`${bin} exited with code ${code}`)
  } finally {
    clearTimeout(timer)
    if (killTimer) clearTimeout(killTimer)
    if (watchdog) clearInterval(watchdog)
  }
}

/**
 * Streams a pipe line by line into the log sink.
 *
 * Lines split across chunk boundaries exactly as Docker log frames do, so the
 * partial tail is held until the next chunk completes it. Emitting a partial
 * line would also defeat redaction: a secret bisected by a chunk boundary
 * matches nothing and reaches the log intact.
 */
async function pump(
  // Bun types a spawned pipe as a union with a file descriptor, because the
  // same field carries either depending on the stdio mode requested. Both are
  // "pipe" here, so the stream branch is the only reachable one — narrowed
  // rather than cast, so a future stdio change fails loudly instead of at
  // runtime.
  stream: unknown,
  onLog: (line: string) => void,
  /** Collects the reader, so the caller can cancel one left open. */
  readers: { cancel(): Promise<void> }[],
): Promise<void> {
  if (!(stream instanceof ReadableStream)) return
  const reader = (stream as ReadableStream<Uint8Array>).getReader()
  readers.push(reader)
  const decoder = new TextDecoder()
  let partial = ""

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    partial += decoder.decode(value, { stream: true })
    const lines = partial.split("\n")
    partial = lines.pop() ?? ""
    for (const line of lines) onLog(line)
  }
  if (partial) onLog(partial)
}
