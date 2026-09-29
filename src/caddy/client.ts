import { config, HOST_ALIAS } from "../config.ts"
import { logger } from "../log.ts"

/**
 * Caddy admin API wrapper.
 *
 * Caddy runs as a container musdash manages. Its admin API can replace the
 * entire configuration, unauthenticated, so it is a unix socket in a directory
 * only this process's user can enter — never a TCP port (D29). A TCP listener
 * inside the container binds every interface on the `musdash` network, which is
 * the network every user app is attached to: any deployed app could then
 * rewrite routing, including pointing the dashboard's hostname at itself.
 *
 * Routes are addressed by `@id` so each can be replaced or deleted
 * independently — without ids, changing one route means rewriting the whole
 * array and racing every other writer.
 */

const SERVER = "srv0"

/** Every route id musdash writes starts with this; routeIdFor adds the rest. */
export const ROUTE_ID_PREFIX = "musdash-"

/**
 * Where the proxy creates its admin socket, INSIDE the container. The host
 * directory config.caddyAdminDir is bind-mounted here, so the same socket is
 * config.caddyAdminSocket on the host.
 */
export const ADMIN_SOCKET_DIR_IN_CONTAINER = "/run/musdash-caddy"

/**
 * The value for the proxy's CADDY_ADMIN.
 *
 * Mode 0222 because connect() on a unix socket needs write permission and
 * nothing else, and Caddy's default of 0200 would admit only root — musdash
 * runs as its own user. The mode is not the access control: the 0700 directory
 * around the socket is (D29).
 */
export const ADMIN_LISTEN = `unix/${ADMIN_SOCKET_DIR_IN_CONTAINER}/admin.sock|0222`

type UnixInit = RequestInit & { unix: string }

/**
 * Every admin-API call is bounded.
 *
 * Job concurrency is exactly 1 and the worker awaits its handler with no
 * timeout of its own, so a single fetch that never settles — a half-open
 * connection to a port something else is holding, or a Caddy wedged mid-reload
 * — parks the one worker every user deploy is queued behind, indefinitely. No
 * lease rescues it either: leases are recovered only when the process starts
 * (recoverOrphanedLeases).
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
  /**
   * The names the route answers on. Empty would mean no host matcher — a route
   * answering on every address — which nothing musdash writes uses any more:
   * the dashboard's tail routes are built separately (D55), and a resource
   * with no hosts gets no route at all.
   */
  hosts: string[]
  /** Container IP or name, plus port. */
  upstream: string
}

/**
 * Structural equality for two JSON values, ignoring object key order.
 *
 * Caddy stores config as decoded maps and re-encodes them with sorted keys, so
 * a route read back never matches JSON.stringify of the object that was sent.
 */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!(Array.isArray(a) && Array.isArray(b)) || a.length !== b.length) {
      return false
    }
    return a.every((v, i) => sameJson(v, b[i]))
  }
  if (
    a === null ||
    b === null ||
    typeof a !== "object" ||
    typeof b !== "object"
  ) {
    return false
  }
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  const bo = b as Record<string, unknown>
  const ao = a as Record<string, unknown>
  return ak.every((k) => k in bo && sameJson(ao[k], bo[k]))
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

/**
 * The hosts a stored route matches, as routeBody writes them: the `host` list
 * of its first matcher.
 *
 * Narrowed from `unknown` and never throws — this feeds only the deploy's
 * certificate wait, and a route of an unexpected shape (hand-edited, or from an
 * older musdash) must degrade to "no hosts known", which just means every host
 * is waited on. It must not fail a route switch that already succeeded.
 */
function routeHostsOf(route: unknown): string[] {
  if (route === null || typeof route !== "object") return []
  const match = (route as { match?: unknown }).match
  if (!Array.isArray(match)) return []
  const first: unknown = match[0]
  if (first === null || typeof first !== "object") return []
  const host = (first as { host?: unknown }).host
  if (!Array.isArray(host)) return []
  return host.filter((h): h is string => typeof h === "string")
}

/** A route as sent to the admin API. The `@id` is what every write addresses. */
export type RouteJson = { "@id": string } & Record<string, unknown>

/**
 * The JSON for a resource route (and the dashboard's host route).
 *
 * Its output must stay byte-for-byte stable: ensureRoute compares it against
 * what Caddy stored, so any change here rewrites every resource route on the
 * next boot — a proxy reload per resource.
 */
function routeBody(spec: RouteSpec): RouteJson {
  return {
    "@id": spec.id,
    // An empty matcher array is not the same as a matcher with no hosts: the
    // latter matches nothing. Omitting `match` outright answers on every
    // address; no caller passes empty hosts any more (see RouteSpec.hosts).
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
  constructor(private readonly socket: string = config.caddyAdminSocket) {}

  private async request(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    try {
      // The socket is the address; the URL's host only becomes the Host
      // header. It must be 127.0.0.1, not "localhost": Caddy 2.10+ skips the
      // Host check on unix sockets, but 2.9 and earlier enforce it and accept
      // only "", 127.0.0.1 and ::1 — anything else is a 403 on every call.
      return await fetch(`http://127.0.0.1${path}`, {
        ...init,
        unix: this.socket,
        // Callers may pass their own signal; nothing does today, and the
        // fallback keeps the door open without a second parameter.
        signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      } as UnixInit)
    } catch (cause) {
      throw new CaddyError(
        `cannot reach the Caddy admin API at ${this.socket}: ${(cause as Error).message}`,
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

    // Deliberately NOT "any apps key exists". Every route musdash writes lives
    // under /config/apps/http/servers/srv0/routes, so a config resumed from an
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

    // No `admin` key. The listen address comes from the container's
    // CADDY_ADMIN alone, so a persisted config can never carry a TCP admin
    // listener back in on the next `--resume` — which is exactly what the
    // `admin.listen: 0.0.0.0:2019` this used to write did (D29).
    await this.expectOk("/load", {
      method: "POST",
      ...this.json({
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

  /** The route stored under `id`, or null when there is none. */
  private async getRoute(id: string): Promise<unknown> {
    const res = await this.request(`/id/${encodeURIComponent(id)}`)
    if (!res.ok) {
      await res.arrayBuffer().catch(() => undefined)
      return null
    }
    return await res.json().catch(() => null)
  }

  /**
   * Points a route at an upstream, creating it if absent.
   *
   * PATCH on an existing @id swaps the upstream atomically — Caddy applies the
   * new config in one step, so no request sees a half-updated route. That is
   * what makes the zero-downtime swap safe. (Every admin change is a full
   * config reload inside Caddy; the listener side of that is handled by the
   * proxy's tcp_migrate_req sysctl, see D30.)
   *
   * A NEW route is inserted at index 0, never appended. The list ends in the
   * dashboard's tail (see ensureDashboardRoutes), whose last route —
   * musdash-not-found — has no matcher and is terminal, so anything appended
   * behind it is never reached. Appending is what shipped once: every resource
   * was unreachable after its first deploy, on every install (D20, VPS test
   * C-1). PUT on an array index inserts; POST appends. Relative order among
   * resource routes does not matter, because no two of them match the same
   * host.
   *
   * Returns the hosts the route matched BEFORE this write — [] when it is new.
   * They come from the GET this already makes to choose PATCH or PUT, so the
   * deploy learns which names are new to Caddy, and need a first certificate,
   * without a single extra admin request.
   */
  async upsertRoute(spec: RouteSpec): Promise<string[]> {
    const existing = await this.getRoute(spec.id)
    if (existing !== null) {
      await this.expectOk(`/id/${encodeURIComponent(spec.id)}`, {
        method: "PATCH",
        ...this.json(routeBody(spec)),
      })
      return routeHostsOf(existing)
    }
    await this.expectOk(`/config/apps/http/servers/${SERVER}/routes/0`, {
      method: "PUT",
      ...this.json(routeBody(spec)),
    })
    return []
  }

  /**
   * The upstream a stored route dials, or null when there is no such route (or
   * it is not shaped the way routeBody writes one).
   */
  async getRouteUpstream(id: string): Promise<string | null> {
    const route = (await this.getRoute(id)) as {
      handle?: { upstreams?: { dial?: unknown }[] }[]
    } | null
    const dial = route?.handle?.[0]?.upstreams?.[0]?.dial
    return typeof dial === "string" ? dial : null
  }

  /**
   * upsertRoute, but only when the stored route differs from `spec`.
   *
   * For reconciling rather than deploying: every admin write reloads the whole
   * proxy, so re-asserting an unchanged route on every boot would cost a reload
   * per resource for nothing. Returns whether anything was written.
   */
  async ensureRoute(spec: RouteSpec): Promise<boolean> {
    if (sameJson(await this.getRoute(spec.id), routeBody(spec))) return false
    await this.upsertRoute(spec)
    return true
  }

  /**
   * Appends a route to the END of the list, without replacing an existing one.
   * The body is sent as-is.
   *
   * Only the dashboard's tail routes are appended. They must always land last,
   * so they are deleted and re-appended rather than upserted — upsertRoute
   * would insert them at the front. It takes a prebuilt body rather than a
   * RouteSpec because two of the three tail routes are not host-matched
   * resource-shaped routes at all.
   */
  async appendRoute(route: RouteJson): Promise<void> {
    await this.expectOk(`/config/apps/http/servers/${SERVER}/routes/`, {
      method: "POST",
      ...this.json(route),
    })
  }

  /**
   * The `@id` of every route on srv0, in order. Routes without one — nothing
   * musdash writes, but a hand edit could add one — are skipped.
   */
  async listRouteIds(): Promise<string[]> {
    const res = await this.request(`/config/apps/http/servers/${SERVER}/routes`)
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new CaddyError(`caddy list routes -> ${res.status} ${body}`.trim())
    }
    const routes: unknown = await res.json().catch(() => null)
    if (!Array.isArray(routes)) return []
    return routes.flatMap((r: unknown) => {
      const id = (r as { "@id"?: unknown } | null)?.["@id"]
      return typeof id === "string" ? [id] : []
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
  return `${ROUTE_ID_PREFIX}${resourceId}`
}

/**
 * Stable id for the dashboard's IP-literal route. The id predates D55, when this
 * was a matcher-less catch-all; it is kept so an upgraded proxy's old route is
 * the one ensureDashboardRoutes deletes.
 */
export const DASHBOARD_ROUTE_ID = "musdash-dashboard"

/** Stable id for the dashboard's host-matched route, when a hostname is set. */
export const DASHBOARD_HOST_ROUTE_ID = "musdash-dashboard-host"

/**
 * Stable id for the final 404. Resource route ids are `musdash-<ULID>`, and a
 * ULID is upper-case Crockford base32, so no resource can collide with it.
 */
export const NOT_FOUND_ROUTE_ID = "musdash-not-found"

/**
 * Every id ensureDashboardRoutes owns. syncResourceRoutes deletes any other
 * `musdash-` route the database does not want, so a tail id missing from this
 * set is silently removed on the next domain change.
 */
export const DASHBOARD_TAIL_ROUTE_IDS: ReadonlySet<string> = new Set([
  DASHBOARD_HOST_ROUTE_ID,
  DASHBOARD_ROUTE_ID,
  NOT_FOUND_ROUTE_ID,
])

/**
 * An IP literal as `{http.request.host}` presents it: dotted-quad IPv4, or
 * anything with a colon in it made of hex digits, dots and colons, optionally
 * in brackets. Caddy strips the port, and strips IPv6 brackets only when a port
 * was present, so both bracketed and bare IPv6 must match.
 *
 * Deliberately loose. It only has to separate IP literals from DNS names, and
 * no DNS name has a colon or is four all-digit labels — `999.1.1.1` matching is
 * harmless. It matches ANY IP, not only this server's, so it needs no address
 * discovery and still works behind NAT and for the loopback reachability probe.
 *
 * Written once for both regex engines: Caddy evaluates it with Go's RE2 through
 * CEL, and the tests with JavaScript's RegExp. It must contain no `'`, because
 * it is embedded in a single-quoted CEL string.
 */
export const IP_LITERAL_HOST_PATTERN =
  "^([0-9]{1,3}(\\.[0-9]{1,3}){3}|\\[?[0-9a-fA-F:.]*:[0-9a-fA-F:.]*\\]?)$"

/**
 * The CEL matcher expression. A compile-time constant on purpose: nothing from
 * the database or the environment ever reaches it, so no configured value can
 * inject into the expression. Every `\` is doubled because a CEL single-quoted
 * string treats backslash as an escape, and the regex needs its backslashes to
 * survive that unescaping.
 */
const IP_LITERAL_EXPRESSION = `{http.request.host}.matches('${IP_LITERAL_HOST_PATTERN.replaceAll("\\", "\\\\")}')`

/**
 * The dashboard's route for requests addressed to an IP literal.
 *
 * An `expression` matcher, never `host`. Automatic HTTPS treats every name in
 * a host matcher as one it manages, and redirects :80 to :443 for managed
 * names — and Let's Encrypt will not issue for an IP, so a host-matched IP is
 * a 308 toward an https:// URL that can never work: the D24 lockout. The
 * expression matcher gives automatic HTTPS no name to manage.
 */
export function dashboardIpRouteBody(upstream: string): RouteJson {
  return {
    "@id": DASHBOARD_ROUTE_ID,
    match: [{ expression: IP_LITERAL_EXPRESSION }],
    handle: [{ handler: "reverse_proxy", upstreams: [{ dial: upstream }] }],
    terminal: true,
  }
}

/**
 * The final route: an empty 404 for every request nothing earlier matched — a
 * deleted resource's name, a random sslip.io label, a foreign domain pointed at
 * the box. No `match`, so it must be the very last route; no body, because
 * user-facing strings live in templates and this is not a musdash page.
 */
export function notFoundRouteBody(): RouteJson {
  return {
    "@id": NOT_FOUND_ROUTE_ID,
    handle: [{ handler: "static_response", status_code: 404 }],
    terminal: true,
  }
}

/** A dotted hostname: label(.label)+, no leading or trailing dash. */
export const HOSTNAME_RE =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

export function isValidHostname(host: string): boolean {
  return host.length <= 253 && HOSTNAME_RE.test(host)
}

/**
 * Writes the dashboard's tail of the route list: its hostname, any IP literal,
 * and a 404 for everything else.
 *
 * Up to three routes, in this order, after every resource route:
 *
 * 1. musdash-dashboard-host — a host matcher on the configured hostname, only
 *    when one is set. The host matcher is what turns automatic HTTPS on: Caddy
 *    issues a certificate for, and redirects :80 to :443 for, any name it sees
 *    in one.
 * 2. musdash-dashboard — an `expression` matcher accepting IP literals only.
 *    This is the lockout protection D24 exists for: when DNS breaks, the
 *    registrar lapses, or issuance fails, the bare server IP still serves the
 *    dashboard over plain HTTP. It must NEVER be a `host` matcher — that would
 *    make the IP a managed name, and a managed name gets the :80→:443 redirect
 *    toward an https:// URL Let's Encrypt will never issue for, which is
 *    exactly the lockout D24 observed on a real VPS.
 * 3. musdash-not-found — no matcher, an empty 404. It must be LAST: Caddy
 *    evaluates routes in array order and every route musdash writes is
 *    `terminal`, so a matcher-less route swallows everything behind it.
 *    upsertRoute inserts new resource routes at the front for exactly this
 *    reason.
 *
 * D55 reverses the cost D20 and D24 accepted, that the dashboard answered on
 * any Host header. It no longer does: a deleted resource's name, a random
 * sslip.io label, or a foreign domain pointed at the box now gets a 404 rather
 * than the musdash sign-in page. The hostname and IP literals still reach it.
 *
 * All three are deleted and re-appended as a unit on every ensureCaddy() and
 * every dashboard-host change. That also repairs a config written before the
 * insert fix, where resource routes had been appended behind the old
 * catch-all, and upgrades a pre-D55 matcher-less musdash-dashboard in place.
 *
 * `client` is injectable for the tests; production callers use the default.
 */
export async function ensureDashboardRoutes(
  host: string | undefined,
  client: CaddyClient = caddy,
): Promise<void> {
  // Delete-then-append rather than PATCH in place: the ids may sit anywhere in
  // the array from a previous boot, and only a fresh append puts them last.
  // deleteRoute treats 404 as success, so removing all of them
  // unconditionally is safe.
  for (const id of DASHBOARD_TAIL_ROUTE_IDS) await client.deleteRoute(id)

  // Caddy dials the host through the ExtraHosts alias rather than a container
  // name: the dashboard runs on the host, not on this network (D2). The alias
  // resolves to the host's bridge address, which is why the dashboard binds
  // every interface rather than loopback (D23).
  const upstream = `${HOST_ALIAS}:${config.port}`

  // The hostname only ever goes into a host matcher, never into the CEL
  // expression, which stays a constant.
  if (host) {
    await client.appendRoute(
      routeBody({ id: DASHBOARD_HOST_ROUTE_ID, hosts: [host], upstream }),
    )
  }

  await client.appendRoute(dashboardIpRouteBody(upstream))
  await client.appendRoute(notFoundRouteBody())
}
