import { mkdirSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { z } from "zod"

/**
 * Configuration is read from the environment exactly once, at startup, and
 * frozen. A getter that re-read `process.env` per call would be slower and
 * could return different answers at different points in a request.
 *
 * Defaults follow PHASES.md §18, with two deliberate deviations recorded in
 * docs/DECISIONS.md — D2 (Caddy admin on loopback, because mosdash runs on the
 * host and cannot resolve container-name DNS) and D4 (ACME staging defaults on,
 * so a careless dev run cannot burn the Let's Encrypt rate limit).
 */

const bool = z
  .string()
  .transform((v) => v.toLowerCase())
  .pipe(z.enum(["true", "false", "1", "0"]))
  .transform((v) => v === "true" || v === "1")

const schema = z.object({
  MOSDASH_PORT: z.coerce.number().int().min(1).max(65535).default(8000),
  MOSDASH_DATA_DIR: z.string().default("./data"),
  MOSDASH_DOCKER_SOCKET: z.string().default("/var/run/docker.sock"),

  // Optional so a fresh install still boots and can reach the setup page.
  // Absence is fatal only where a domain is actually needed (route creation).
  MOSDASH_WILDCARD_DOMAIN: z.string().min(1).optional(),
  MOSDASH_ACME_EMAIL: z.string().email().optional(),

  MOSDASH_ACME_STAGING: bool.default(true), // D4
  MOSDASH_CADDY_ADMIN: z.string().url().default("http://127.0.0.1:2019"), // D2
  MOSDASH_NETWORK: z.string().default("mosdash"),
  MOSDASH_DEFAULT_MEMORY_MB: z.coerce.number().int().positive().default(512),
  MOSDASH_HEALTH_TIMEOUT_SEC: z.coerce.number().int().positive().default(60),
  MOSDASH_LOG_LEVEL: z
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

const dataDir = isAbsolute(env.MOSDASH_DATA_DIR)
  ? env.MOSDASH_DATA_DIR
  : resolve(process.cwd(), env.MOSDASH_DATA_DIR)
mkdirSync(dataDir, { recursive: true })

export const config = Object.freeze({
  port: env.MOSDASH_PORT,
  dataDir,
  dbPath: resolve(dataDir, "mosdash.db"),
  secretKeyPath: resolve(dataDir, "secret.key"),
  logDir: resolve(dataDir, "logs"),

  dockerSocket: env.MOSDASH_DOCKER_SOCKET,
  network: env.MOSDASH_NETWORK,

  wildcardDomain: env.MOSDASH_WILDCARD_DOMAIN,
  acmeEmail: env.MOSDASH_ACME_EMAIL,
  acmeStaging: env.MOSDASH_ACME_STAGING,
  caddyAdmin: env.MOSDASH_CADDY_ADMIN.replace(/\/$/, ""),

  defaultMemoryMb: env.MOSDASH_DEFAULT_MEMORY_MB,
  healthTimeoutSec: env.MOSDASH_HEALTH_TIMEOUT_SEC,
  logLevel: env.MOSDASH_LOG_LEVEL,

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
