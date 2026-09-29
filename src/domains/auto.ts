import { config } from "../config.ts"
import {
  addDomain,
  domainExists,
  getSetting,
  listAllResources,
  listDomains,
  getEnvironment,
  setSetting,
} from "../db/queries.ts"
import { logger } from "../log.ts"
import { getDashboardHost, getPublicIp } from "../settings.ts"
import {
  generateAutoHost,
  type LegacyAutoCandidate,
  legacyAutoHosts,
} from "./generate.ts"

/**
 * Automatic hostnames (D66): `<adjective>-<noun>.<base>`, generated once when a
 * resource is created and stored as its `is_auto` domain row. Nothing
 * recomputes them — a route carries exactly the rows in `domains` — so a
 * redeploy, a rename or a changed base never moves a live URL, and never asks
 * Let's Encrypt for a certificate it already issued.
 */

/**
 * The domain automatic hostnames go under, or undefined when there is none.
 *
 * The operator's wildcard wins: it means they pointed `*.<wildcard>` at this
 * box and want names under it. Without one, sslip.io resolves
 * `<anything>.<ip>.sslip.io` to `<ip>` with no DNS work at all, which needs the
 * address the internet reaches this box on — a Settings value, never guessed
 * (D55: learning our own public address is unreliable behind NAT).
 */
export function autoDomainBase(): string | undefined {
  if (config.wildcardDomain) return config.wildcardDomain.toLowerCase()
  const ip = getPublicIp()
  return ip ? `${ip}.sslip.io` : undefined
}

/**
 * Gives a resource an automatic hostname, when a base exists and it has none.
 * Returns the host it stored, or undefined. The caller enqueues `sync_routes`
 * when the resource may already be routed.
 */
export function assignAutoDomain(resourceId: string): string | undefined {
  const base = autoDomainBase()
  if (!base) return undefined
  if (listDomains(resourceId).some((d) => d.isAuto === 1)) return undefined
  const host = generateAutoHost(base, domainExists, getDashboardHost())
  if (host) addDomain(resourceId, host, true)
  return host
}

/** Set once the upgrade below has run, so a deleted auto row stays deleted. */
const SETTING_LEGACY_AUTO_PERSISTED = "legacy_auto_domains_persisted"

/**
 * Stores the wildcard hostname every existing resource was being routed on.
 *
 * Before D66 the auto host was recomputed on every route sync as
 * `<name>-<env>.<wildcard>`, and a resource created before the wildcard was
 * set, whose host collided at creation, or created under an older wildcard,
 * had its current one only in that recomputation — never as a row. Routes now carry rows only, so without this those resources
 * would lose a working URL on the first sync after upgrading. Runs once: after
 * that, an auto row the operator removes must stay removed. Needs config, which
 * a SQL migration cannot see, so it runs from migrate() rather than from 0007.
 */
export function persistLegacyAutoDomains(): void {
  if (getSetting(SETTING_LEGACY_AUTO_PERSISTED) !== undefined) return
  const wildcard = config.wildcardDomain?.toLowerCase()
  if (wildcard) {
    const candidates: LegacyAutoCandidate[] = []
    for (const resource of listAllResources()) {
      const environment = getEnvironment(resource.environmentId)
      if (!environment) continue
      candidates.push({
        resourceId: resource.id,
        slug: resource.slug,
        environmentName: environment.name,
      })
    }
    const rows = legacyAutoHosts(
      candidates,
      wildcard,
      getDashboardHost(),
      domainExists,
    )
    for (const { resourceId, host } of rows) addDomain(resourceId, host, true)
    if (rows.length > 0) {
      logger.info(
        { stored: rows.length },
        "stored the wildcard auto hostnames as rows",
      )
    }
  }
  setSetting(SETTING_LEGACY_AUTO_PERSISTED, "1")
}
