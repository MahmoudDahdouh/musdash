import { randomInt } from "node:crypto"
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
