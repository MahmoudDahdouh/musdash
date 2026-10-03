/**
 * Runs a subprocess and streams its output line by line: the pump every
 * long-running external tool shares — the builders (railpack, buildctl) and
 * `docker compose pull|up|stop|down`.
 *
 * What it guarantees, each learned the hard way in the build path:
 *
 * - stdout and stderr are read concurrently and merged. BuildKit and Compose
 *   both write progress to stderr and results to stdout; reading one after the
 *   other blocks on the first while the second's pipe fills, and the process
 *   deadlocks at the pipe buffer size.
 * - A partial line is held until the next chunk completes it. Emitting it
 *   early would defeat redaction: a secret bisected by a chunk boundary
 *   matches nothing and reaches the log intact.
 * - A hard timeout, and a stop the caller can ask for, both end the process
 *   with SIGTERM and then SIGKILL after a grace period — each tool cancels its
 *   work cleanly on SIGTERM; one that cannot is killed.
 * - Once the process exits, the pipes get a short drain window and are then
 *   abandoned. A child the tool started can inherit them and outlive it, and
 *   waiting for that one would hold the single worker indefinitely.
 */

/**
 * How long a stopped process gets to exit after SIGTERM before SIGKILL.
 */
const KILL_GRACE_MS = 10_000

/**
 * How long the output pipes get to drain once the process has exited.
 */
const DRAIN_MS = 2_000

/** How many stderr lines are kept for the caller's error message. */
const DEFAULT_STDERR_TAIL = 20

export interface StreamingOptions {
  /** Program and arguments. An array, never a shell string. */
  argv: string[]
  cwd: string
  /**
   * The WHOLE environment of the process; nothing is inherited that the
   * caller does not pass. (runBuilder passes process.env on purpose; the
   * Compose CLI passes only its fixed three.)
   */
  env: Readonly<Record<string, string | undefined>>
  /** Hard bound, after which the process is stopped. */
  timeoutMs: number
  /** Every complete line of stdout and stderr, in arrival order. */
  onLine: (line: string) => void
  /** Aborting stops the process the way the timeout does. */
  signal?: AbortSignal
  /** How many trailing stderr lines to return; default 20. */
  stderrTailLines?: number
}

export interface StreamingResult {
  exitCode: number
  /**
   * Why the process was stopped, if it was; the first reason wins. A stop
   * asked for after the process had already exited is no stop at all.
   */
  stopped: "timeout" | "aborted" | null
  /** The last stderr lines, oldest first — for an error message. */
  stderrTail: string[]
}

/** The process could not be started at all (e.g. not installed). */
export class SpawnError extends Error {
  override readonly name = "SpawnError"
  constructor(
    message: string,
    /** The system error code, e.g. ENOENT, when there is one. */
    readonly code: string | undefined,
  ) {
    super(message)
  }
}

export async function spawnStreaming(
  opts: StreamingOptions,
): Promise<StreamingResult> {
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(opts.argv, {
      cwd: opts.cwd,
      env: opts.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
  } catch (cause) {
    const code: unknown =
      cause instanceof Error && "code" in cause ? cause.code : undefined
    throw new SpawnError(
      cause instanceof Error ? cause.message : String(cause),
      typeof code === "string" ? code : undefined,
    )
  }

  let stopped: StreamingResult["stopped"] = null
  let killTimer: Timer | null = null
  // Set the moment the process exits. A stop that arrives afterwards — a
  // verdict computed while the process was finishing — changes nothing.
  let exited = false
  void proc.exited.then(() => {
    exited = true
  })
  const stop = (why: "timeout" | "aborted") => {
    if (stopped !== null || exited) return
    stopped = why
    proc.kill()
    killTimer = setTimeout(() => proc.kill("SIGKILL"), KILL_GRACE_MS)
  }

  const timer = setTimeout(() => stop("timeout"), opts.timeoutMs)
  const onAbort = () => stop("aborted")
  if (opts.signal?.aborted) onAbort()
  opts.signal?.addEventListener("abort", onAbort, { once: true })

  const tailSize = opts.stderrTailLines ?? DEFAULT_STDERR_TAIL
  const stderrTail: string[] = []
  const onStderr = (line: string) => {
    stderrTail.push(line)
    if (stderrTail.length > tailSize) stderrTail.shift()
    opts.onLine(line)
  }

  try {
    const readers: { cancel(): Promise<void> }[] = []
    // Observed from the start: the process can run for the whole timeout
    // before anything awaits these, and a pipe error in that time must not be
    // an unhandled rejection. It still surfaces through `finished` below if it
    // lands before the drain window ends.
    const finished = Promise.all([
      pump(proc.stdout, opts.onLine, readers),
      pump(proc.stderr, onStderr, readers),
    ]).then(() => true)
    finished.catch(() => {})
    const exitCode = await proc.exited
    // Normally the pipes close with the process and this returns at once.
    const drained = await Promise.race([
      finished,
      Bun.sleep(DRAIN_MS).then(() => false),
    ])
    if (!drained) {
      // Cancelling ends the pending reads; its own failure changes nothing.
      for (const reader of readers) void reader.cancel().catch(() => {})
    }
    return { exitCode, stopped, stderrTail }
  } finally {
    clearTimeout(timer)
    if (killTimer) clearTimeout(killTimer)
    opts.signal?.removeEventListener("abort", onAbort)
  }
}

/**
 * Streams a pipe line by line into the sink, holding a partial tail until the
 * next chunk completes it (see the module comment for why).
 */
async function pump(
  // Bun types a spawned pipe as a union with a file descriptor, because the
  // same field carries either depending on the stdio mode requested. Both are
  // "pipe" here, so the stream branch is the only reachable one — narrowed
  // rather than cast, so a future stdio change fails loudly instead of at
  // runtime.
  stream: unknown,
  onLine: (line: string) => void,
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
    for (const line of lines) onLine(line)
  }
  if (partial) onLine(partial)
}
