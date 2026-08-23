import { randomBytes } from "node:crypto"

/**
 * ULID: 48-bit millisecond timestamp + 80 bits of randomness, Crockford base32.
 * Lexicographically sortable by creation time, which is why ids double as the
 * ordering key for jobs and deployments.
 *
 * A ~30-line helper rather than the `ulid` package — PHASES.md §7 permits
 * either, and a dependency that costs RSS to save 30 lines is a bad trade here.
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ" // Crockford: no I, L, O, U
const TIME_LEN = 10
const RANDOM_LEN = 16

function encodeTime(now: number): string {
  let out = ""
  let t = now
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    out = (ALPHABET[t % 32] as string) + out
    t = Math.floor(t / 32)
  }
  return out
}

function encodeRandom(): string {
  const bytes = randomBytes(RANDOM_LEN)
  let out = ""
  for (let i = 0; i < RANDOM_LEN; i++) {
    out += ALPHABET[(bytes[i] as number) % 32] as string
  }
  return out
}

export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom()
}

/** Short, human-facing suffix used in container names. */
export function shortId(id: string): string {
  return id.slice(-8).toLowerCase()
}

export function nowIso(): string {
  return new Date().toISOString()
}
