import { config } from "../config.ts"
import { logger } from "../log.ts"
import { runBuilder } from "./run.ts"
import type { BuildContext } from "./types.ts"

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
    // Scopes the cache MOUNTS (npm, apt, mise downloads) per resource, so one
    // app's build cannot read another's. The layer cache is not scoped by it:
    // layers are content-addressed and shared across the whole daemon, and
    // they survive between builds only as long as the daemon's gc allows (D52).
    "--cache-key",
    ctx.cacheKey,
  ]
  // A forced-cold build. Railpack 0.37.0 has the flag; a throwaway cache key,
  // used before, emptied only the mounts and still reused every layer (D52).
  if (ctx.noCache) args.push("--no-cache")
  args.push(...envArgs(ctx.buildArgs))
  // After the user's variables, and only ever when none of them is
  // RAILPACK_BUILD_CMD: the decision refuses to switch if the user set it, so
  // this never overrides a command they chose. One argv element — no shell
  // here; Railpack's own shell sees only next-webpack.ts's restricted charset.
  if (ctx.railpackBuildCmd !== undefined) {
    args.push("--env", `RAILPACK_BUILD_CMD=${ctx.railpackBuildCmd}`)
  }

  await runBuilder(config.railpackBin, args, ctx, {
    BUILDKIT_HOST: config.buildkitAddr,
  })
}

/**
 * The user's build variables as Railpack `--env` flags. `railpackInfo` passes
 * exactly these too, so the plan it reports is the plan the build runs —
 * RAILPACK_CONFIG_FILE and every other RAILPACK_* variable included.
 */
function envArgs(buildArgs: Readonly<Record<string, string>>): string[] {
  return Object.entries(buildArgs).flatMap(([k, v]) => ["--env", `${k}=${v}`])
}

/**
 * `railpack info` is plan generation only — no BuildKit — and took 0.13 s and
 * about 26 MB peak on the 2GB host (railpack 0.37.0). The limits are for a
 * repository built to make it misbehave, not for the normal case.
 */
const INFO_TIMEOUT_MS = 30_000
const INFO_MAX_BYTES = 4 * 1024 * 1024

/**
 * The parsed output of `railpack info --format json` for a build context, or
 * null when it could not be had: the binary would not start, exited non-zero,
 * ran past 30 s, printed more than 4 MiB, or printed something that is not
 * JSON. Never throws; a null only means the webpack switch is not made.
 *
 * Nothing about the run is logged but the kind of failure and the exit code:
 * the arguments carry the user's build variables, which may be secrets, and
 * stderr is discarded unread for the same reason (and so its pipe cannot fill
 * and stall the process).
 */
export async function railpackInfo(
  contextDir: string,
  buildArgs: Readonly<Record<string, string>>,
): Promise<unknown> {
  let proc: Bun.Subprocess<"ignore", "pipe", "ignore">
  try {
    proc = Bun.spawn(
      [
        config.railpackBin,
        "info",
        "--format",
        "json",
        ...envArgs(buildArgs),
        contextDir,
      ],
      {
        cwd: config.buildsDir,
        env: { ...process.env },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      },
    )
  } catch {
    logger.warn({ failure: "spawn" }, "railpack info could not be run")
    return null
  }

  const reader = proc.stdout.getReader()
  let timer: Timer | undefined
  const timedOut = new Promise<"timeout">((done) => {
    timer = setTimeout(() => done("timeout"), INFO_TIMEOUT_MS)
  })
  const fail = (failure: string, code?: number | null) => {
    proc.kill("SIGKILL")
    void reader.cancel().catch(() => {})
    logger.warn({ failure, code }, "railpack info gave no usable answer")
    return null
  }
  try {
    const reading = readAll(reader, INFO_MAX_BYTES)
    // On a timeout the read loses the race and is cancelled; it must not
    // surface later as an unhandled rejection.
    reading.catch(() => {})
    const out = await Promise.race([reading, timedOut])
    if (out === "timeout") return fail("timeout")
    if (out === null) return fail("output-too-large")
    // The output ended; the process normally exits with it, but is not
    // waited on past the same deadline.
    const code = await Promise.race([proc.exited, timedOut])
    if (code === "timeout") return fail("timeout")
    if (code !== 0) return fail("exit", code)
    try {
      const parsed: unknown = JSON.parse(out)
      return parsed
    } catch {
      return fail("invalid-json")
    }
  } catch {
    return fail("read")
  } finally {
    clearTimeout(timer)
  }
}

/** The stream's text, or null once it passes `maxBytes`. */
async function readAll(
  reader: {
    read(): Promise<{ done: true } | { done: false; value: Uint8Array }>
  },
  maxBytes: number,
): Promise<string | null> {
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    total += chunk.value.byteLength
    if (total > maxBytes) return null
    chunks.push(chunk.value)
  }
  return Buffer.concat(chunks).toString("utf8")
}
