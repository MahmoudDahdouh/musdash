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

  // FALLBACK ONLY. The public address is normally DERIVED from the dashboard
  // host (src/settings.ts getPublicUrl), because it is by definition
  // `https://` + that name. This stays for the one case derivation cannot
  // express: something else fronting musdash on a different name — a tunnel, an
  // external load balancer — where no dashboard host is set at all.
  MUSDASH_PUBLIC_URL: z.string().url().optional(),

  // The dashboard's own hostname — the FALLBACK for the `dashboard_host`
  // settings row, which the Settings page writes and which wins when present
  // (src/settings.ts). It stays here so a fresh box can be provisioned
  // non-interactively by install.sh. Unset is the normal state: the dashboard
  // route is then a catch-all answering on the bare server IP, which is the
  // only address a box without DNS has. Setting it ADDS a host-matched route
  // and lets Caddy obtain a certificate — Let's Encrypt will not issue for an
  // IP, so the catch-all stays alongside it as the fallback.
  // A BARE hostname: no scheme, no path, no port. It is written straight into a
  // Caddy host matcher, which matches the literal string — so "https://x.com"
  // produces a route that can never match, no certificate, and a clean startup
  // log. That failure is invisible, so it is rejected here instead.
  MUSDASH_DASHBOARD_HOST: z
    .string()
    .min(1)
    .refine((h) => !/[:/]/.test(h), {
      message:
        "must be a bare hostname with no scheme, path or port — " +
        "mus.example.com, not https://mus.example.com",
    })
    .optional(),

  // How a container reaches the host. Caddy is in a container, so 127.0.0.1
  // from inside it reaches the proxy, not the dashboard. `host-gateway` is the
  // Engine's own alias for the host's BRIDGE address, added to the proxy's
  // /etc/hosts via ExtraHosts. That it is the bridge address and not loopback
  // is why the dashboard cannot bind loopback — see bindHostname below.
  MUSDASH_HOST_GATEWAY: z.string().default("host-gateway"),

  MUSDASH_ACME_STAGING: bool.default(true), // D4
  MUSDASH_CADDY_ADMIN: z.string().url().default("http://127.0.0.1:2019"), // D2

  // The build daemon's address, loopback for the same reason the Caddy admin
  // API is: BuildKit runs arbitrary build steps and its API is unauthenticated,
  // so it must never be reachable off the box.
  MUSDASH_BUILDKIT_ADDR: z.string().default("tcp://127.0.0.1:1234"),
  MUSDASH_BUILD_CACHE_GB: z.coerce.number().int().positive().default(10),

  // Verification only. A cached build proves nothing about what reaches the
  // build log, so DoD item 9 — build-time secrets never appear in build output
  // — can only be checked with the build steps forced to actually execute.
  MUSDASH_BUILD_NO_CACHE: bool.default(false),
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
  dashboardHost: env.MUSDASH_DASHBOARD_HOST?.toLowerCase(),
  hostGatewayIp: env.MUSDASH_HOST_GATEWAY,
  acmeEmail: env.MUSDASH_ACME_EMAIL,
  acmeStaging: env.MUSDASH_ACME_STAGING,
  // Trailing slash stripped so callers can join paths without doubling it.
  publicUrl: env.MUSDASH_PUBLIC_URL?.replace(/\/$/, ""),
  caddyAdmin: env.MUSDASH_CADDY_ADMIN.replace(/\/$/, ""),

  buildkitAddr: env.MUSDASH_BUILDKIT_ADDR,
  buildCacheGb: env.MUSDASH_BUILD_CACHE_GB,
  buildNoCache: env.MUSDASH_BUILD_NO_CACHE,
  railpackBin: env.MUSDASH_RAILPACK_BIN,
  buildctlBin: env.MUSDASH_BUILDCTL_BIN,

  defaultMemoryMb: env.MUSDASH_DEFAULT_MEMORY_MB,
  healthTimeoutSec: env.MUSDASH_HEALTH_TIMEOUT_SEC,
  logLevel: env.MUSDASH_LOG_LEVEL,

  isProduction: process.env.NODE_ENV === "production",
})

/**
 * The /etc/hosts name Caddy uses to reach the dashboard's host.
 *
 * `host-gateway` is the ADDRESS the Engine substitutes, so the alias on the
 * left of an ExtraHosts entry is ours to choose. Defined here rather than in
 * the proxy bootstrap because the Caddy client needs it too, and bootstrap
 * already imports the client.
 */
export const HOST_ALIAS = "musdash-host"

export type Config = typeof config

/**
 * The dashboard always binds every interface. D23 supersedes D3 and D21.
 *
 * §12 and the older decisions said "127.0.0.1 in production, reached through
 * Caddy". That is unachievable with Caddy in a container: the proxy dials the
 * host through `host-gateway`, which the Engine resolves to the host's BRIDGE
 * address (docker0, typically 172.17.0.1) — not loopback. A socket bound to
 * 127.0.0.1 cannot accept that connection, so narrowing the bind does not
 * harden the dashboard, it disconnects it.
 *
 * The boundary therefore moves from an implicit bind address to an explicit
 * firewall rule, which install.sh now creates. That is the honest place for it:
 * the old rule was already untrue in practice, since install.sh set
 * MUSDASH_BIND_ALL=true on every install without a dashboard host. What is
 * exposed without a firewall is the login form, /health and /assets — every
 * other route is behind a session and the global CSRF gate.
 */
export function bindHostname(): string {
  return "0.0.0.0"
}
