import { config } from "../config.ts"
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
  for (const [k, v] of Object.entries(ctx.buildArgs)) {
    args.push("--env", `${k}=${v}`)
  }

  await runBuilder(config.railpackBin, args, ctx, {
    BUILDKIT_HOST: config.buildkitAddr,
  })
}
