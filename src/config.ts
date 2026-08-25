import { mkdirSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { z } from "zod"

/**
 * Configuration is read from the environment exactly once, at startup, and
 * frozen. A getter that re-read `process.env` per call would be slower and
 * could return different answers at different points in a request.
 *
 * Defaults follow PHASES.md §18, with two deliberate deviations recorded in
 * docs/DECISIONS.md — D2 (Caddy admin on loopback, because musdash runs on the
 * host and cannot resolve container-name DNS) and D4 (ACME staging defaults on,
 * so a careless dev run cannot burn the Let's Encrypt rate limit).
 */

const bool = z
  .string()
  .transform((v) => v.toLowerCase())
  .pipe(z.enum(["true", "false", "1", "0"]))
  .transform((v) => v === "true" || v === "1")

const schema = z.object({
  MUSDASH_PORT: z.coerce.number().int().min(1).max(65535).default(8000),
  MUSDASH_DATA_DIR: z.string().default("./data"),
  MUSDASH_DOCKER_SOCKET: z.string().default("/var/run/docker.sock"),

  // Optional so a fresh install still boots and can reach the setup page.
  // Absence is fatal only where a domain is actually needed (route creation).
  MUSDASH_WILDCARD_DOMAIN: z.string().min(1).optional(),
  MUSDASH_ACME_EMAIL: z.string().email().optional(),

  // Where this dashboard is reachable from the public internet. Optional for the
  // same reason the wildcard domain is — a fresh install must boot and reach the
  // setup page — but GitHub App registration cannot work without it, so its
  // absence is a clear error at manifest-build time rather than at startup.
  MUSDASH_PUBLIC_URL: z.string().url().optional(),

  MUSDASH_ACME_STAGING: bool.default(true), // D4
  MUSDASH_CADDY_ADMIN: z.string().url().default("http://127.0.0.1:2019"), // D2

  // The build daemon's address, loopback for the same reason the Caddy admin
  // API is: BuildKit runs arbitrary build steps and its API is unauthenticated,
  // so it must never be reachable off the box.
  MUSDASH_BUILDKIT_ADDR: z.string().default("tcp://127.0.0.1:1234"),
  MUSDASH_BUILD_CACHE_GB: z.coerce.number().int().positive().default(10),
  // Both are external binaries invoked via Bun.spawn (shell out, never
  // reimplement). Configurable rather than assumed on PATH so a packaged
  // install can place them wherever it likes.
  MUSDASH_RAILPACK_BIN: z.string().default("railpack"),
  MUSDASH_BUILDCTL_BIN: z.string().default("buildctl"),
  MUSDASH_NETWORK: z.string().default("musdash"),
  MUSDASH_DEFAULT_MEMORY_MB: z.coerce.number().int().positive().default(512),
  MUSDASH_HEALTH_TIMEOUT_SEC: z.coerce.number().int().positive().default(60),
  MUSDASH_LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
})

const parsed = schema.safeParse(process.env)
if (!parsed.success) {
  const detail = parsed.error.issues
    .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n")
  throw new Error(`Invalid configuration:\n${detail}`)
}

const env = parsed.data

const dataDir = isAbsolute(env.MUSDASH_DATA_DIR)
  ? env.MUSDASH_DATA_DIR
  : resolve(process.cwd(), env.MUSDASH_DATA_DIR)
mkdirSync(dataDir, { recursive: true })

export const config = Object.freeze({
  port: env.MUSDASH_PORT,
  dataDir,
  dbPath: resolve(dataDir, "musdash.db"),
  secretKeyPath: resolve(dataDir, "secret.key"),
  logDir: resolve(dataDir, "logs"),
  // Build contexts are extracted here and deleted when the build finishes,
  // success or failure — they are the second-largest disk leak after images.
  buildsDir: resolve(dataDir, "builds"),
  // Deliberately NOT inside buildsDir: a build directory is deleted when its
  // build ends, which would take the layer cache with it every time.
  buildCacheDir: resolve(dataDir, "build-cache"),

  dockerSocket: env.MUSDASH_DOCKER_SOCKET,
  network: env.MUSDASH_NETWORK,

  wildcardDomain: env.MUSDASH_WILDCARD_DOMAIN,
  acmeEmail: env.MUSDASH_ACME_EMAIL,
  acmeStaging: env.MUSDASH_ACME_STAGING,
  // Trailing slash stripped so callers can join paths without doubling it.
  publicUrl: env.MUSDASH_PUBLIC_URL?.replace(/\/$/, ""),
  caddyAdmin: env.MUSDASH_CADDY_ADMIN.replace(/\/$/, ""),

  buildkitAddr: env.MUSDASH_BUILDKIT_ADDR,
  buildCacheGb: env.MUSDASH_BUILD_CACHE_GB,
  railpackBin: env.MUSDASH_RAILPACK_BIN,
  buildctlBin: env.MUSDASH_BUILDCTL_BIN,

  defaultMemoryMb: env.MUSDASH_DEFAULT_MEMORY_MB,
  healthTimeoutSec: env.MUSDASH_HEALTH_TIMEOUT_SEC,
  logLevel: env.MUSDASH_LOG_LEVEL,

  isProduction: process.env.NODE_ENV === "production",
})

export type Config = typeof config

/**
 * D3: the dashboard is reached through Caddy, so the port binds to loopback.
 * But a fresh install has no admin account and possibly no DNS yet, so while
 * the users table is empty we bind all interfaces — otherwise the operator is
 * locked out of the box they just installed. The window closes automatically
 * the moment an account exists.
 */
export function bindHostname(hasAdminUser: boolean): string {
  if (!config.isProduction) return "0.0.0.0"
  return hasAdminUser ? "127.0.0.1" : "0.0.0.0"
}
