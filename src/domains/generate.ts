import { randomInt } from "node:crypto"
import { isIPv4 } from "node:net"
import { isValidHostname } from "../caddy/client.ts"
import { randomToken } from "../crypto.ts"
import { ADJECTIVES, NOUNS } from "./words.ts"

/*
 * The pure half of automatic hostnames (D66): no database, so a test can run
 * it directly. src/domains/auto.ts wires it to the rows and settings.
 */

/** One `<adjective>-<noun>` label. `pick(n)` returns an integer in [0, n). */
export function randomLabel(pick: (n: number) => number = randomInt): string {
  const adjective = ADJECTIVES[pick(ADJECTIVES.length)] as string
  const noun = NOUNS[pick(NOUNS.length)] as string
  return `${adjective}-${noun}`
}

/**
 * A free hostname under `base`, or undefined when none is usable.
 *
 * `taken` is checked for each candidate: five fresh pairs, then a pair with a
 * random suffix, which cannot realistically collide. A name that is not a
 * valid hostname (a base that is itself malformed) or that is the dashboard's
 * own name is never returned — a resource carrying the dashboard's hostname
 * would take it over (N-3).
 */
export function generateAutoHost(
  base: string,
  taken: (host: string) => boolean,
  dashboardHost: string | undefined,
  pick: (n: number) => number = randomInt,
): string | undefined {
  const usable = (candidate: string) =>
    isValidHostname(candidate) &&
    candidate !== dashboardHost &&
    !taken(candidate)
  for (let attempt = 0; attempt < 5; attempt++) {
    const host = `${randomLabel(pick)}.${base}`
    if (usable(host)) return host
  }
  const host = `${randomLabel(pick)}-${randomToken(2)}.${base}`
  return usable(host) ? host : undefined
}

/** A resource as the pre-D66 wildcard hostname was computed from it. */
export interface LegacyAutoCandidate {
  resourceId: string
  slug: string
  environmentName: string
}

/**
 * The `<slug>-<env>.<wildcard>` hosts the old recomputation routed that no row
 * holds yet, one per resource. Keyed on the exact host, not on whether the
 * resource already has some automatic row: a resource created under an older
 * wildcard has a row for that one and was still served on the current one.
 * A host that is invalid, the dashboard's, already a row anywhere (`taken`),
 * or claimed by an earlier candidate is skipped — two resources could compute
 * the same name, and only one route could ever have won it.
 */
export function legacyAutoHosts(
  candidates: readonly LegacyAutoCandidate[],
  wildcard: string,
  dashboardHost: string | undefined,
  taken: (host: string) => boolean,
): { resourceId: string; host: string }[] {
  const claimed = new Set<string>()
  const out: { resourceId: string; host: string }[] = []
  for (const c of candidates) {
    const host = `${c.slug}-${c.environmentName}.${wildcard}`.toLowerCase()
    if (
      !isValidHostname(host) ||
      host === dashboardHost ||
      taken(host) ||
      claimed.has(host)
    ) {
      continue
    }
    claimed.add(host)
    out.push({ resourceId: c.resourceId, host })
  }
  return out
}

/**
 * An IPv4 address Let's Encrypt could reach: not private, loopback,
 * link-local, carrier-grade NAT, "this network" or multicast and above. An
 * sslip.io name for any of those resolves, but can never get a certificate —
 * the installer refuses the same ranges when it seeds the address (D66).
 */
export function isPublicIPv4(ip: string): boolean {
  if (!isIPv4(ip)) return false
  const [a = 0, b = 0] = ip.split(".").map(Number)
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  return true
}
