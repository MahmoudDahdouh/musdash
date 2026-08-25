import { config, HOST_ALIAS } from "../config.ts"
import { logger } from "../log.ts"

/**
 * Caddy admin API wrapper.
 *
 * Caddy runs as a container musdash manages. Its admin API is never published
 * to the host beyond loopback: anyone who reaches port 2019 can replace the
 * entire configuration, unauthenticated.
 *
 * Routes are addressed by `@id` so each can be replaced or deleted
 * independently — without ids, changing one route means rewriting the whole
 * array and racing every other writer.
 */

const SERVER = "srv0"

/**
 * Every admin-API call is bounded.
 *
 * Job concurrency is exactly 1 and the worker awaits its handler with no
 * timeout of its own, so a single fetch that never settles — a half-open
 * connection to a port something else is holding, or a Caddy wedged mid-reload
 * — parks the one worker every user deploy is queued behind, indefinitely. The
 * 15-minute lease is no rescue either: recoverExpiredLeases() runs only at
 * startWorker().
 *
 * The bound is on request() rather than on ping() alone because upsertRoute
 * sits on the deploy critical path and has the identical hang shape.
 */
const REQUEST_TIMEOUT_MS = 5_000

export class CaddyError extends Error {
  override readonly name = "CaddyError"
}

export interface RouteSpec {
  /** Stable id: `musdash-<resourceId>`. */
  id: string
  /** Empty means catch-all: no host matcher, so it answers on any address. */
  hosts: string[]
  /** Container IP or name, plus port. */
  upstream: string
}

/**
 * Whether a fetched Caddy config already carries the named HTTP server.
 *
 * Narrows step by step from `unknown` rather than casting: the body is whatever
 * the admin API returned, and a config resumed from an autosave can be shaped
 * almost any way.
 */
function hasServer(cfg: unknown, name: string): boolean {
  if (cfg === null || typeof cfg !== "object") return false
  const apps = (cfg as { apps?: unknown }).apps
  if (apps === null || typeof apps !== "object") return false
  const http = (apps as { http?: unknown }).http
  if (http === null || typeof http !== "object") return false
  const servers = (http as { servers?: unknown }).servers
  if (servers === null || typeof servers !== "object") return false
  return name in (servers as Record<string, unknown>)
}

function routeBody(spec: RouteSpec): unknown {
  return {
    "@id": spec.id,
    // An empty matcher array is not the same as a matcher with no hosts: the
    // latter matches nothing. Omit `match` outright to get a catch-all.
    ...(spec.hosts.length > 0 ? { match: [{ host: spec.hosts }] } : {}),
    handle: [
      {
        handler: "reverse_proxy",
        upstreams: [{ dial: spec.upstream }],
      },
    ],
    terminal: true,
  }
}

export class CaddyClient {
  constructor(private readonly admin: string = config.caddyAdmin) {}

  private async request(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    try {
      return await fetch(`${this.admin}${path}`, {
        ...init,
        // Callers may pass their own signal; nothing does today, and the
        // fallback keeps the door open without a second parameter.
        signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (cause) {
      throw new CaddyError(
        `cannot reach the Caddy admin API at ${this.admin}: ${(cause as Error).message}`,
      )
    }
  }

  private async expectOk(path: string, init: RequestInit): Promise<void> {
    const res = await this.request(path, init)
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new CaddyError(`caddy ${path} -> ${res.status} ${body}`.trim())
    }
    await res.arrayBuffer().catch(() => undefined)
  }

  private json(body: unknown): RequestInit {
    return {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.request("/config/")).ok
    } catch {
      return false
    }
  }

  /**
   * The names of the configured HTTP servers, or null if the admin API did not
   * answer.
   *
   * Three states the old code conflated into one boolean: null means
   * unreachable; an empty array means the admin API answered but no HTTP app
   * exists yet — the legitimate state of a fresh `--resume` start on an empty
   * volume, which ensureBaseConfig() then fills in; a non-empty array means
   * servers are configured. A 404 is a real answer from a live admin API, so it
   * maps to the empty array, not to null.
   */
  async listeningServers(): Promise<string[] | null> {
    try {
      const res = await this.request(`/config/apps/http/servers/`)
      if (!res.ok) {
        await res.arrayBuffer().catch(() => undefined)
        return res.status === 404 ? [] : null
      }
      const body: unknown = await res.json()
      if (body === null || typeof body !== "object") return []
      return Object.keys(body as Record<string, unknown>)
    } catch {
      return null
    }
  }

  /**
   * Installs the base config: one HTTP server on 80/443 with an empty route
   * list, plus the ACME email. Automatic HTTPS activates on any route that has
   * a host matcher.
   */
  async ensureBaseConfig(): Promise<void> {
    const res = await this.request("/config/")
    const existing: unknown = res.ok ? await res.json().catch(() => null) : null

    // Deliberately NOT "any apps key exists". Every upsertRoute POSTs to
    // /config/apps/http/servers/srv0/routes/, so a config resumed from an
    // autosave that carries an http app under a different server name leaves
    // musdash unable to add a single route while this reported nothing to do.
    // The only condition that makes the rest of this client work is that srv0
    // itself is present, so that is what is checked.
    if (hasServer(existing, SERVER)) return

    // /load replaces the WHOLE config, so a hand-edited one without srv0 is
    // about to be overwritten. That is the right trade — preserved-but-broken
    // left musdash unusable — but it must not be silent.
    if (existing !== null) {
      logger.warn(
        { server: SERVER },
        "the existing Caddy configuration has no srv0 server; replacing it — musdash routes require srv0",
      )
    }

    const issuer = issuerConfig()

    await this.expectOk("/load", {
      method: "POST",
      ...this.json({
        admin: { listen: "0.0.0.0:2019" },
        apps: {
          http: {
            servers: {
              [SERVER]: {
                listen: [":80", ":443"],
                routes: [],
              },
            },
          },
          tls: {
            automation: { policies: [{ issuers: [issuer] }] },
          },
        },
      }),
    })
    logger.info(
      { staging: config.acmeStaging },
      "installed base Caddy configuration",
    )
  }

  private async routeExists(id: string): Promise<boolean> {
    const res = await this.request(`/id/${encodeURIComponent(id)}`)
    await res.arrayBuffer().catch(() => undefined)
    return res.ok
  }

  /**
   * Points a route at an upstream, creating it if absent.
   *
   * PATCH on an existing @id swaps the upstream atomically — Caddy applies the
   * new config in one step, so no request sees a half-updated route. That is
   * what makes the zero-downtime swap safe.
   */
  async upsertRoute(spec: RouteSpec): Promise<void> {
    if (await this.routeExists(spec.id)) {
      await this.expectOk(`/id/${encodeURIComponent(spec.id)}`, {
        method: "PATCH",
        ...this.json(routeBody(spec)),
      })
      return
    }
    await this.expectOk(`/config/apps/http/servers/${SERVER}/routes/`, {
      method: "POST",
      ...this.json(routeBody(spec)),
    })
  }

  /**
   * Appends a route to the END of the list, without replacing an existing one.
   *
   * upsertRoute PATCHes in place when the id already exists, which preserves
   * position. The dashboard's catch-all must instead always land last, so it
   * is deleted and re-appended rather than upserted.
   */
  async appendRoute(spec: RouteSpec): Promise<void> {
    await this.expectOk(`/config/apps/http/servers/${SERVER}/routes/`, {
      method: "POST",
      ...this.json(routeBody(spec)),
    })
  }

  async deleteRoute(id: string): Promise<void> {
    const res = await this.request(`/id/${encodeURIComponent(id)}`, {
      method: "DELETE",
    })
    // A missing route is the desired end state, so 404 is success.
    if (!res.ok && res.status !== 404) {
      const body = await res.text().catch(() => "")
      throw new CaddyError(`caddy delete ${id} -> ${res.status} ${body}`.trim())
    }
    await res.arrayBuffer().catch(() => undefined)
  }

  /**
   * Brings the persisted ACME issuer back in line with the configuration.
   *
   * ensureBaseConfig() writes the TLS automation policy exactly once — it
   * early-returns when srv0 already exists — and Caddy runs with `--resume`
   * against a persisted volume, so srv0 exists on every boot after the first.
   * Without this, a box first bootstrapped with MUSDASH_ACME_STAGING=true keeps
   * issuing untrusted staging certificates forever, and changing the env var
   * and restarting does nothing at all. That reads to the operator as "musdash
   * cannot get me a certificate".
   *
   * PATCHes only on a real difference, so the common path costs one GET and
   * nothing else. Flipping staging off triggers real issuance, which is rate
   * limited to 50 per registered domain per week — deliberate, and the reason
   * this logs the change rather than doing it quietly.
   */
  async ensureTlsAutomation(): Promise<void> {
    const desired = issuerConfig()
    const res = await this.request("/config/apps/tls/automation/policies")
    const current: unknown = res.ok ? await res.json().catch(() => null) : null
    if (!res.ok) await res.arrayBuffer().catch(() => undefined)

    if (JSON.stringify(current) === JSON.stringify([{ issuers: [desired] }])) {
      return
    }

    await this.expectOk("/config/apps/tls/automation/policies", {
      method: "PATCH",
      ...this.json([{ issuers: [desired] }]),
    })
    logger.info(
      { staging: config.acmeStaging, email: config.acmeEmail !== undefined },
      "updated the Caddy ACME issuer",
    )
  }
}

/** The ACME issuer both the base config and the reconcile above install. */
function issuerConfig(): Record<string, unknown> {
  return {
    module: "acme",
    ...(config.acmeStaging
      ? { ca: "https://acme-staging-v02.api.letsencrypt.org/directory" }
      : {}),
    ...(config.acmeEmail ? { email: config.acmeEmail } : {}),
  }
}

export const caddy = new CaddyClient()

export function routeIdFor(resourceId: string): string {
  return `musdash-${resourceId}`
}

/** `<resource>-<environment>.<wildcard>` (§10). */
export function autoDomainFor(
  resourceName: string,
  environmentName: string,
): string | null {
  if (!config.wildcardDomain) return null
  return `${resourceName}-${environmentName}.${config.wildcardDomain}`.toLowerCase()
}

/** Stable id for the dashboard's catch-all route. */
export const DASHBOARD_ROUTE_ID = "musdash-dashboard"

/** Stable id for the dashboard's host-matched route, when a hostname is set. */
export const DASHBOARD_HOST_ROUTE_ID = "musdash-dashboard-host"

/** A dotted hostname: label(.label)+, no leading or trailing dash. */
export const HOSTNAME_RE =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

export function isValidHostname(host: string): boolean {
  return host.length <= 253 && HOSTNAME_RE.test(host)
}

/**
 * Routes the dashboard through Caddy, on its hostname AND on anything else.
 *
 * Two routes, always, and the order matters twice over.
 *
 * The host-matched route is what turns automatic HTTPS on: Caddy issues a
 * certificate for any name it sees in a host matcher, and will not issue for a
 * bare IP. The catch-all is what keeps the operator from being locked out — it
 * is the only way back in when DNS breaks, the registrar lapses, or issuance
 * fails, which is exactly the state this codebase shipped into. An earlier
 * version REPLACED the catch-all with the host route, and the result was that
 * every request to the bare IP became a 308 toward an https:// URL that could
 * never have a certificate. Caddy redirects :80 to :443 only for names it
 * manages, so with the catch-all present a bare-IP request is served, not
 * redirected.
 *
 * Ordering: Caddy evaluates routes in array order and every route musdash
 * writes is `terminal`. Resource routes carry host matchers, so a request for a
 * deployed app's domain matches its own route and stops. The catch-all matches
 * everything, so it must be LAST or it swallows every resource. upsertRoute
 * POSTs to the same collection and therefore appends, so a resource deployed
 * later would land behind it — which is why both dashboard routes are deleted
 * and re-appended as a unit on every ensureCaddy() rather than created once.
 */
export async function ensureDashboardRoutes(
  host: string | undefined,
): Promise<void> {
  // Delete-then-append rather than PATCH in place: the ids may sit anywhere in
  // the array from a previous boot, and only a fresh append puts them last.
  // deleteRoute treats 404 as success, so removing both unconditionally is safe.
  await caddy.deleteRoute(DASHBOARD_HOST_ROUTE_ID)
  await caddy.deleteRoute(DASHBOARD_ROUTE_ID)

  // Caddy dials the host through the ExtraHosts alias rather than a container
  // name: the dashboard runs on the host, not on this network (D2). The alias
  // resolves to the host's bridge address, which is why the dashboard binds
  // every interface rather than loopback (D23).
  const upstream = `${HOST_ALIAS}:${config.port}`

  if (host) {
    await caddy.appendRoute({
      id: DASHBOARD_HOST_ROUTE_ID,
      hosts: [host],
      upstream,
    })
  }

  await caddy.appendRoute({ id: DASHBOARD_ROUTE_ID, hosts: [], upstream })
}
