/**
 * Template placeholders (docs/PHASE-3-PLAN.md §3.5): variable names a Compose
 * file references that musdash fills in itself, using the naming Coolify's
 * templates already rely on. The caller generates each one once, when the
 * resource is created or a saved file first mentions it, and stores it as an
 * encrypted resource variable — so it survives redeploys, is redacted in
 * logs, and can be edited like any other.
 *
 * Pure: no logger, no storage.
 */

export type PlaceholderKind = "password" | "user" | "base64" | "fqdn" | "url"

export interface Placeholder {
  /** The variable name as the file wrote it. */
  name: string
  kind: PlaceholderKind
  /** fqdn/url only: the Compose service the host routes to. */
  service?: string
  /** fqdn/url only: the container port, when the name carries one. */
  port?: number
}

const SECRET_RE = /^SERVICE_(PASSWORD|USER|BASE64)_[A-Z0-9_]+$/

/**
 * `SERVICE_FQDN_<SERVICE>[_<PORT>]`. SERVICE starts and ends with a letter or
 * digit, so the name maps to a service Compose accepts. A trailing `_<digits>`
 * is always read as the port — `WEB_3000` is service `web` on 3000, never a
 * service called `web-3000`.
 */
const ROUTE_RE = /^SERVICE_(FQDN|URL)_([A-Z0-9](?:[A-Z0-9_]*[A-Z0-9])?)$/
const PORT_SUFFIX = /^(.+)_(\d+)$/

const SECRET_KINDS = {
  PASSWORD: "password",
  USER: "user",
  BASE64: "base64",
} as const

/**
 * Service names in Compose files are conventionally lowercase with hyphens,
 * and environment names are uppercase with underscores, so `MY_APP` names the
 * service `my-app`. A service whose own name has an underscore cannot be
 * addressed this way; the template authors write hyphens.
 */
function serviceName(upper: string): string {
  return upper.toLowerCase().replaceAll("_", "-")
}

/** The placeholder a variable name asks for, or null when it is not one. */
export function parsePlaceholder(name: string): Placeholder | null {
  const secret = SECRET_RE.exec(name)
  if (secret !== null) {
    const kind = secret[1]
    if (kind === "PASSWORD" || kind === "USER" || kind === "BASE64") {
      return { name, kind: SECRET_KINDS[kind] }
    }
    return null
  }

  const route = ROUTE_RE.exec(name)
  if (route === null) return null
  const kind = route[1] === "FQDN" ? "fqdn" : "url"
  const rest = route[2] ?? ""
  const suffix = PORT_SUFFIX.exec(rest)
  if (suffix === null) return { name, kind, service: serviceName(rest) }
  const [, svc = "", digits = ""] = suffix
  // A port that is not one — 0, above 65535, or with a leading zero — makes
  // the whole name not a placeholder, rather than quietly a port-less one on
  // a service called e.g. `web-0`.
  if (!/^[1-9]\d{0,4}$/.test(digits)) return null
  const port = Number(digits)
  if (port > 65_535) return null
  return { name, kind, service: serviceName(svc), port }
}

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
const LOWER = "abcdefghijklmnopqrstuvwxyz"

/** Refills of the random buffer before a draw gives up. */
const MAX_REFILLS = 64

/** An rng that fills its argument with random bytes. */
export type FillRandom = (bytes: Uint8Array) => void

const defaultRng: FillRandom = (bytes) => {
  crypto.getRandomValues(bytes)
}

/** The rng never produced enough usable bytes; only a broken rng does this. */
export class RandomSourceError extends Error {
  override readonly name = "RandomSourceError"
}

/**
 * `length` characters drawn uniformly from `alphabet`. A byte is used only
 * when it falls below the largest multiple of the alphabet size, so no
 * character is likelier than another (a plain `% 62` would favour the first
 * eight). Bounded, so a broken rng throws instead of hanging the worker.
 */
function draw(alphabet: string, length: number, rng: FillRandom): string {
  const limit = 256 - (256 % alphabet.length)
  const buf = new Uint8Array(length * 2)
  let out = ""
  for (let refill = 0; refill < MAX_REFILLS; refill++) {
    rng(buf)
    for (const byte of buf) {
      if (byte >= limit) continue
      out += alphabet[byte % alphabet.length] ?? ""
      if (out.length === length) return out
    }
  }
  throw new RandomSourceError("random source produced too few usable bytes")
}

/**
 * A fresh value for a secret placeholder: password is 32 of `[A-Za-z0-9]`
 * (about 190 bits), user is 16 of `[a-z]`, base64 is 32 random bytes in the
 * standard alphabet with padding.
 */
export function generateSecret(
  kind: "password" | "user" | "base64",
  rng: FillRandom = defaultRng,
): string {
  if (kind === "password") return draw(ALNUM, 32, rng)
  if (kind === "user") return draw(LOWER, 16, rng)
  const bytes = new Uint8Array(32)
  rng(bytes)
  return Buffer.from(bytes).toString("base64")
}
