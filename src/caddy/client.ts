import { config } from "../config.ts"
import { logger } from "../log.ts"

/**
 * Caddy admin API wrapper.
 *
 * Caddy runs as a container mosdash manages. Its admin API is never published
 * to the host beyond loopback: anyone who reaches port 2019 can replace the
 * entire configuration, unauthenticated.
 *
 * Routes are addressed by `@id` so each can be replaced or deleted
 * independently — without ids, changing one route means rewriting the whole
 * array and racing every other writer.
 */

const SERVER = "srv0"

export class CaddyError extends Error {
  override readonly name = "CaddyError"
}

export interface RouteSpec {
  /** Stable id: `mosdash-<resourceId>`. */
  id: string
  hosts: string[]
  /** Container IP or name, plus port. */
  upstream: string
}

function routeBody(spec: RouteSpec): unknown {
  return {
    "@id": spec.id,
    match: [{ host: spec.hosts }],
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
      return await fetch(`${this.admin}${path}`, init)
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
   * Installs the base config: one HTTP server on 80/443 with an empty route
   * list, plus the ACME email. Automatic HTTPS activates on any route that has
   * a host matcher.
   */
  async ensureBaseConfig(): Promise<void> {
    const res = await this.request("/config/")
    const existing = res.ok ? await res.json().catch(() => null) : null
    if (existing && (existing as { apps?: unknown }).apps) return

    const issuer = config.acmeStaging
      ? {
          module: "acme",
          ca: "https://acme-staging-v02.api.letsencrypt.org/directory",
          ...(config.acmeEmail ? { email: config.acmeEmail } : {}),
        }
      : {
          module: "acme",
          ...(config.acmeEmail ? { email: config.acmeEmail } : {}),
        }

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
}

export const caddy = new CaddyClient()

export function routeIdFor(resourceId: string): string {
  return `mosdash-${resourceId}`
}

/** `<resource>-<environment>.<wildcard>` (§10). */
export function autoDomainFor(
  resourceName: string,
  environmentName: string,
): string | null {
  if (!config.wildcardDomain) return null
  return `${resourceName}-${environmentName}.${config.wildcardDomain}`.toLowerCase()
}
