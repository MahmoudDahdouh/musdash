import { config } from "../config.ts"
import { logger } from "../log.ts"
import { BuildError, type BuildContext } from "./types.ts"

/**
 * How BuildKit reports a step the kernel killed for memory: the step's exit
 * status, 137 being 128 + SIGKILL, inside a line like `process "/bin/sh -c npm
 * ci" did not complete successfully: exit code: 137`. The builder itself then
 * exits 1, which on its own says nothing.
 */
const MEMORY_KILL = /exit code: 137\b/

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
  const onLog = (line: string) => {
    lastOutputAt = Date.now()
    if (MEMORY_KILL.test(line)) sawMemoryKill = true
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

  const advice = ctx.memoryAdvice ? ` ${ctx.memoryAdvice}` : ""
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
        `the build ran out of memory: BuildKit sat at its memory limit with no output for ${duration(stall?.afterMs ?? 0)}, so it was stopped.${advice}`,
      )
    }
    if (stopped === "timeout") {
      throw new BuildError(
        `the build did not finish within ${duration(ctx.timeoutMs)} and was stopped`,
      )
    }
    if (sawMemoryKill) {
      throw new BuildError(
        `a build step ran out of memory and was killed (exit code 137).${advice}`,
      )
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
