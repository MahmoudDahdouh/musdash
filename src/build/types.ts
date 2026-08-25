/**
 * Shared build types, in their own module so the strategy implementations do
 * not import each other.
 */

export type BuildPack = "dockerfile" | "railpack"

export interface BuildContext {
  /** Directory holding the source to build. */
  contextDir: string
  /** Image reference to produce, e.g. `musdash/web:01J...`. */
  tag: string
  /**
   * Cache scope. Per resource rather than per deployment: a per-deployment key
   * would miss on every build and make the cache pointless, while a global key
   * lets one app evict another's layers.
   */
  cacheKey: string
  /**
   * Build-time variables. These reach the build log unless redacted, which is
   * why `onLog` is expected to be a redacting sink rather than a raw one.
   */
  buildArgs: Record<string, string>
  /** Path to the Dockerfile, relative to contextDir. Dockerfile strategy only. */
  dockerfilePath?: string
  /**
   * Skips the layer cache. Not a user-facing option: it exists so a verification
   * run can force the build steps to actually execute, since a cached build
   * proves nothing about what reaches the log.
   */
  noCache?: boolean
  /** Receives build output line by line, already redacted. */
  onLog: (line: string) => void
  /** Hard bound on the subprocess, after which it is killed. */
  timeoutMs: number
}

export class BuildError extends Error {
  override readonly name = "BuildError"
}
