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
