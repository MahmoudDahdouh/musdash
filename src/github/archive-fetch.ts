import { readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { GitHubError } from "./api.ts"

/**
 * The repository archive download: codeload's signed URL streamed into `tar`.
 *
 * Pure on purpose — no database, config or logger — so every stop and every
 * retry can be exercised against a local server. `tarball.ts` binds it to
 * ghFetch, the installation-token wrapper and pino (D58).
 *
 * The signed URL codeload is reached through is a credential: it grants read
 * access to the archive. It is only ever a `fetch()` argument here, never part
 * of a message, an error's cause, or anything else that could reach a log.
 */

export interface ArchiveTimings {
  /** No bytes for this long → the attempt is stopped as a stall. */
  stallMs: number
  /** ONE deadline for the whole download, both attempts together. */
  capMs: number
  /** SIGTERM → SIGKILL. */
  killGraceMs: number
  /** How long tar's stderr may stay open after tar exits. */
  drainMs: number
  /** Watchdog tick. */
  watchIntervalMs: number
}

export const ARCHIVE_TIMINGS: Readonly<ArchiveTimings> = {
  stallMs: 60_000,
  capMs: 15 * 60_000,
  killGraceMs: 5_000,
  drainMs: 2_000,
  watchIntervalMs: 5_000,
}

export type ArchiveFailure =
  "stall" | "cap" | "network" | "tar" | "spawn" | "empty" | "no-redirect"

export class ArchiveError extends Error {
  override readonly name = "ArchiveError"
  readonly failure: ArchiveFailure
  /** Bytes this attempt received from codeload. */
  readonly bytes: number

  constructor(message: string, failure: ArchiveFailure, bytes = 0) {
    super(message)
    this.failure = failure
    this.bytes = bytes
  }
}

export type RetryReason =
  | { kind: "stall"; bytes: number }
  /** 500–599 from either hop. */
  | { kind: "http"; status: number }
  /** GitHubError status 0: ghFetch got no response in time. */
  | { kind: "timeout" }
  /** ArchiveError "network": codeload unreachable or the body broke off. */
  | { kind: "network" }

/**
 * Why a failed download is worth one more attempt; null = never retry.
 *
 * Only failures a second attempt can plausibly fix. A 4xx will answer the same
 * way again, the cap has no time left to give, and a tar failure with no
 * network fault or stall recorded is the archive or the disk, not the link.
 * A mint that times out or 5xxs inside withInstallationToken is part of the
 * api hop, so it is retried with it.
 */
export function retryReason(err: unknown): RetryReason | null {
  if (err instanceof ArchiveError) {
    if (err.failure === "stall") return { kind: "stall", bytes: err.bytes }
    if (err.failure === "network") return { kind: "network" }
    return null
  }
  if (err instanceof GitHubError) {
    if (err.status === 0) return { kind: "timeout" }
    if (err.status >= 500 && err.status <= 599) {
      return { kind: "http", status: err.status }
    }
  }
  return null
}

function megabytes(bytes: number): string {
  return (bytes / 1_048_576).toFixed(1)
}

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`
}

/** "15 minutes", "1 minute", "12 seconds" — the same wording as build/run.ts. */
function duration(ms: number): string {
  const [n, unit] =
    ms >= 60_000
      ? [Math.round(ms / 60_000), "minute"]
      : [Math.round(ms / 1000), "second"]
  return `${n} ${unit}${n === 1 ? "" : "s"}`
}

/** The deploy-log line written once, just before the second attempt. */
export function retryLine(
  reason: RetryReason,
  timings: Pick<ArchiveTimings, "stallMs">,
): string {
  switch (reason.kind) {
    case "stall":
      return `Archive download stalled (no data for ${seconds(timings.stallMs)} after ${megabytes(reason.bytes)} MB); retrying once`
    case "http":
      return `Archive download failed (GitHub answered ${reason.status}); retrying once`
    case "timeout":
      return "Archive download failed (GitHub did not respond); retrying once"
    case "network":
      return "Archive download failed (connection lost); retrying once"
  }
}

export interface ArchiveAttempt {
  /** Validated owner/name; used in messages only. */
  repo: string
  dest: string
  /** Epoch ms, shared by both attempts. */
  deadline: number
  timings: ArchiveTimings
  /** The api.github.com hop (redirect:"manual"). ghFetch has already thrown on non-2xx/3xx. */
  locate: () => Promise<Response>
}

type StopReason = "stall" | "cap"

/**
 * One attempt: the api hop, then codeload, then `tar`. Never settles while its
 * tar process is still running, and leaves no timer or reader open behind it.
 *
 * The body is handed to Bun.spawn as stdin rather than pumped by hand: a
 * manual write loop over the response body deadlocks once the pipe fills,
 * because nothing is reading the other end while the loop blocks. Letting Bun
 * own the pumping keeps memory flat — the whole point of streaming rather than
 * buffering a tarball that can be hundreds of megabytes.
 *
 * --strip-components=1 removes GitHub's `{owner}-{repo}-{sha}/` wrapper.
 */
export async function fetchArchive(a: ArchiveAttempt): Promise<void> {
  const { repo, dest, deadline, timings } = a
  let bytes = 0

  const stopError = (why: StopReason): ArchiveError =>
    why === "stall"
      ? new ArchiveError(
          `The archive download for ${repo} stalled: no data for ${seconds(timings.stallMs)} after ${megabytes(bytes)} MB, so it was stopped`,
          "stall",
          bytes,
        )
      : new ArchiveError(
          `The archive download for ${repo} did not finish within ${duration(timings.capMs)}, so it was stopped`,
          "cap",
          bytes,
        )

  // The cap is shared with the first attempt: a retry that starts after it
  // has already passed must not make even one more request.
  if (Date.now() >= deadline) throw stopError("cap")

  const res = await a.locate()
  // Cancelled on every path, the redirect included: this body is still under
  // ghFetch's 15s signal and is never read. Its own failure changes nothing.
  void res.body?.cancel().catch(() => {})
  const location = res.headers.get("location")
  // A non-redirect body is not streamed: ghFetch's 15s signal governs it, so
  // anything larger than 15s of transfer would be truncated into a gzip error.
  if (res.status < 300 || res.status >= 400 || !location) {
    throw new ArchiveError(
      `GitHub did not redirect the archive request for ${repo} (status ${res.status})`,
      "no-redirect",
    )
  }

  // Why the attempt was stopped, if it was. Decided before anything is
  // aborted or killed, so the error names the cause: a SIGTERM-killed tar
  // exits 143 and an aborted body looks like a truncated gzip, and neither
  // says the network went quiet.
  let stopped: StopReason | null = null
  // Set the moment tar exits. A watchdog tick that lands after that must
  // change nothing — no kill, no verdict.
  let exited = false
  let proc: TarProcess | null = null
  let killTimer: Timer | null = null
  // Only ever cancelled from outside the read loop, so the narrow shape is all
  // that is kept.
  let upstream: { cancel(): Promise<void> } | null = null
  // Set BEFORE the upstream reader is cancelled, so the read that cancel ends
  // is not mistaken for the connection breaking.
  let sourceCancelled = false
  let readFailed = false
  let stderrReader: { cancel(): Promise<void> } | null = null
  const controller = new AbortController()

  const cancelSource = () => {
    if (sourceCancelled) return
    sourceCancelled = true
    if (upstream) void upstream.cancel().catch(() => {})
  }

  const stop = (why: StopReason) => {
    if (stopped !== null || exited) return
    stopped = why
    // Abort and cancel first so gzip sees end-of-file; then ask tar to stop,
    // and make it stop if it has not after the grace period.
    controller.abort()
    cancelSource()
    const running = proc
    if (running) {
      running.kill()
      killTimer = setTimeout(() => running.kill("SIGKILL"), timings.killGraceMs)
    }
  }

  // Started before the codeload request, so a host that never sends headers
  // is a stall too.
  let lastByteAt = Date.now()
  const watchdog = setInterval(() => {
    if (stopped !== null || exited) return
    const now = Date.now()
    if (now >= deadline) stop("cap")
    else if (now - lastByteAt >= timings.stallMs) stop("stall")
  }, timings.watchIntervalMs)

  try {
    let archive: Response
    try {
      archive = await fetch(location, {
        headers: { "user-agent": "musdash" },
        signal: controller.signal,
      })
    } catch {
      if (stopped !== null) throw stopError(stopped)
      // Fixed text only: the runtime's message and cause can carry the URL.
      throw new ArchiveError(
        `The archive download for ${repo} could not reach GitHub's archive host`,
        "network",
      )
    }
    lastByteAt = Date.now()
    if (stopped !== null) {
      void archive.body?.cancel().catch(() => {})
      throw stopError(stopped)
    }
    if (!archive.ok) {
      void archive.body?.cancel().catch(() => {})
      throw new GitHubError(
        `GitHub's archive host returned ${archive.status} for ${repo}`,
        archive.status,
      )
    }
    if (!archive.body) {
      throw new ArchiveError(
        `GitHub returned an empty archive for ${repo}`,
        "empty",
      )
    }
    const source = archive.body.getReader()
    upstream = source

    // The byte counter sits between the body and tar. Pull-based with
    // highWaterMark 0, so it holds nothing itself: each pull is one read,
    // made only when Bun wants more for tar's stdin. Measured on Bun 1.4.2
    // (the pinned runtime) with a 400MB body into a paused consumer: +9 MB
    // RSS through this wrapper against +5 MB for the native body (D58).
    //
    // A read that fails closes the wrapper rather than erroring it: tar then
    // sees a truncated gzip and exits, and `readFailed` names the real cause.
    let wrapperClosed = false
    const stdin = new ReadableStream<Uint8Array>(
      {
        async pull(ctl) {
          let chunk: Awaited<ReturnType<typeof source.read>>
          try {
            chunk = await source.read()
          } catch {
            if (stopped === null && !sourceCancelled) readFailed = true
            if (!wrapperClosed) {
              wrapperClosed = true
              ctl.close()
            }
            return
          }
          if (wrapperClosed) return
          if (chunk.done) {
            wrapperClosed = true
            ctl.close()
            return
          }
          bytes += chunk.value.byteLength
          lastByteAt = Date.now()
          ctl.enqueue(chunk.value)
        },
        cancel() {
          wrapperClosed = true
          cancelSource()
        },
      },
      { highWaterMark: 0 },
    )

    let tar: TarProcess
    try {
      tar = spawnTar(dest, stdin)
    } catch (err) {
      throw new ArchiveError(
        `could not run tar — is it installed and on PATH? (${err instanceof Error ? err.message : String(err)})`,
        "spawn",
        bytes,
      )
    }
    proc = tar
    void tar.exited.then(() => {
      exited = true
    })

    // stderr is drained concurrently with the wait: an undrained pipe blocks
    // tar as soon as its buffer fills, and nothing would ever read it if we
    // waited for exit first.
    const errReader = tar.stderr.getReader()
    stderrReader = errReader
    const decoder = new TextDecoder()
    let stderr = ""
    const stderrDone = (async () => {
      try {
        for (;;) {
          const { done, value } = await errReader.read()
          if (done) return
          stderr += decoder.decode(value, { stream: true })
        }
      } catch {
        // A broken stderr pipe only costs the diagnostic text; tar's exit
        // code still decides the outcome below.
      }
    })()

    const code = await tar.exited
    // Normally stderr closes with tar and this returns at once. But GNU
    // `tar -z` runs gzip as a child that inherits the pipe and can outlive a
    // killed tar; waiting for it would hold the single worker.
    let drainTimer: Timer | null = null
    const drained = await Promise.race([
      stderrDone.then(() => true),
      new Promise<boolean>((resolve) => {
        drainTimer = setTimeout(() => resolve(false), timings.drainMs)
      }),
    ])
    if (drainTimer) clearTimeout(drainTimer)
    if (!drained) void errReader.cancel().catch(() => {})

    // A tar that exits 0 extracted the archive, whatever the watchdog decided
    // while it ran: a stop that crossed the last byte in flight changes nothing.
    if (code === 0) return
    // Never from the exit code: a SIGTERM-killed tar exits 143.
    if (stopped !== null) throw stopError(stopped)
    if (readFailed) {
      throw new ArchiveError(
        `The archive download for ${repo} lost its connection after ${megabytes(bytes)} MB`,
        "network",
        bytes,
      )
    }
    throw new ArchiveError(
      `tar exited ${code}: ${stderr.trim() || "no output"}`,
      "tar",
      bytes,
    )
  } finally {
    clearInterval(watchdog)
    if (killTimer) clearTimeout(killTimer)
    controller.abort()
    cancelSource()
    if (stderrReader) void stderrReader.cancel().catch(() => {})
  }
}

type TarProcess = Bun.Subprocess<ReadableStream<Uint8Array>, "ignore", "pipe">

function spawnTar(dest: string, stdin: ReadableStream<Uint8Array>): TarProcess {
  return Bun.spawn(["tar", "-xz", "--strip-components=1", "-C", dest], {
    stdin,
    stdout: "ignore",
    stderr: "pipe",
  })
}

export interface OneRetry {
  capMs: number
  attempt: (deadline: number) => Promise<void>
  wipe: () => void
  onRetry: (reason: RetryReason) => void
}

/**
 * Runs `attempt`, and once more if its failure is one retryReason accepts.
 *
 * The deadline is fixed once, before the first attempt, so both share the cap.
 * The attempt has settled — its tar has exited — before `wipe` runs, so the
 * retry never extracts over a half-written tree. Never a third attempt; the
 * second one's error surfaces unchanged.
 */
export async function withOneRetry(r: OneRetry): Promise<void> {
  const deadline = Date.now() + r.capMs
  try {
    await r.attempt(deadline)
    return
  } catch (err) {
    const reason = retryReason(err)
    if (reason === null) throw err
    r.onRetry(reason)
  }
  r.wipe()
  await r.attempt(deadline)
}

/**
 * Removes every entry of `dir`; never `dir` itself, never its parent.
 *
 * In place because the build directory is created and removed by its owner
 * (`buildFromSource`); this only clears what a failed attempt left inside it.
 * rmSync does not follow symlinks, so a link the archive planted is removed as
 * a link and nothing outside `dir` is touched.
 */
export function emptyDirInPlace(dir: string): void {
  for (const name of readdirSync(dir)) {
    rmSync(join(dir, name), { recursive: true, force: true })
  }
}

export interface ArchiveDownload {
  repo: string
  dest: string
  timings: ArchiveTimings
  locate: () => Promise<Response>
  onRetry: (reason: RetryReason) => void
}

/** The whole download: one attempt, and one retry on a transient failure. */
export function downloadArchive(d: ArchiveDownload): Promise<void> {
  return withOneRetry({
    capMs: d.timings.capMs,
    attempt: (deadline) =>
      fetchArchive({
        repo: d.repo,
        dest: d.dest,
        deadline,
        timings: d.timings,
        locate: d.locate,
      }),
    wipe: () => emptyDirInPlace(d.dest),
    onRetry: d.onRetry,
  })
}
