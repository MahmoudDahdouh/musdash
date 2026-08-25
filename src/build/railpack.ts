import { config } from "../config.ts"
import { BuildError, type BuildContext } from "./types.ts"

/**
 * Zero-config builds via Railpack (DECISIONS: Railpack, not Nixpacks).
 *
 * Railpack detects the language and framework, generates a build plan, drives
 * BuildKit over `BUILDKIT_HOST`, and loads the finished image into the Docker
 * daemon itself — so unlike the Dockerfile path there is no tarball to stream
 * back. Verified against railpack 0.37.0.
 *
 * Invoked as a subprocess rather than reimplemented, per the shell-out
 * invariant: a subprocess costs transient memory, not resident memory.
 */

export async function buildWithRailpack(ctx: BuildContext): Promise<void> {
  const args = [
    "build",
    ctx.contextDir,
    "--name",
    ctx.tag,
    // Plain progress: the default "auto" emits TTY control sequences, which
    // would reach the deploy log panel as escape-code noise.
    "--progress",
    "plain",
    // Scopes the layer cache per resource. Without it every resource shares one
    // cache key and a build for one app evicts another's layers — the
    // difference between a 20-second and a 3-minute redeploy.
    //
    // Railpack has no `--no-cache` flag, so a forced-cold build is expressed as
    // a cache key nothing has written to yet rather than as a missing flag.
    // The suffix keeps the key inside cacheDir's charset and 64-char limit; the
    // throwaway namespace it creates is reclaimed by the daemon's own GC (D18).
    "--cache-key",
    ctx.noCache ? `${ctx.cacheKey}-nocache-${Date.now()}` : ctx.cacheKey,
  ]
  for (const [k, v] of Object.entries(ctx.buildArgs)) {
    args.push("--env", `${k}=${v}`)
  }

  await runBuilder(config.railpackBin, args, ctx, {
    BUILDKIT_HOST: config.buildkitAddr,
  })
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
): Promise<void> {
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn([bin, ...args], {
      // The build context is passed as an argument, never as the working
      // directory, so nothing here depends on where musdash was started.
      cwd: config.buildsDir,
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    })
  } catch (cause) {
    throw new BuildError(
      `could not run ${bin}: ${(cause as Error).message}. Is it installed and on PATH?`,
    )
  }

  const timer = setTimeout(() => {
    proc.kill()
  }, ctx.timeoutMs)

  try {
    await Promise.all([
      pump(proc.stdout, ctx.onLog),
      pump(proc.stderr, ctx.onLog),
    ])
    const code = await proc.exited
    if (code !== 0) {
      throw new BuildError(`${bin} exited with code ${code}`)
    }
  } finally {
    clearTimeout(timer)
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
): Promise<void> {
  if (!(stream instanceof ReadableStream)) return
  const reader = (stream as ReadableStream<Uint8Array>).getReader()
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
