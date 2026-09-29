import { RESOURCE_NAME_RE } from "./docker/client.ts"

/**
 * Display names and the slugs derived from them (D65).
 *
 * A resource's `name` is what the user reads: letters, digits, spaces and a
 * little punctuation. Its `slug` is what reaches things with stricter grammar —
 * the built image's repository and the auto subdomain's DNS label — and keeps
 * the old rule, RESOURCE_NAME_RE. Projects use the same display rule and have
 * no slug, since their name reaches nothing outside SQLite.
 */

/**
 * The display rule. `-`, `_` and `.` are in it as well as `( )` and `[ ]`:
 * every name written before D65 is a slug, and a rename that keeps the old
 * name must not be refused by the new rule.
 */
const DISPLAY_NAME_RE = /^[A-Za-z0-9 ()[\]._-]{1,60}$/

/** Trims and collapses internal whitespace, so "a   b" and "a b" are one name. */
export function normalizeDisplayName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ")
}

/** Checks an already-normalized name. */
export function isValidDisplayName(name: string): boolean {
  return DISPLAY_NAME_RE.test(name)
}

/**
 * Leaves room for "-<env>" inside a 63-byte DNS label under the wildcard
 * scheme, and for a "-99" collision suffix inside the 32 of the slug rule.
 */
export const SLUG_MAX = 28

/**
 * The slug a display name suggests, or "" when it has no letter or digit.
 *
 * Runs of anything else become one dash and edge dashes are dropped: Docker's
 * repository grammar refuses a component that starts or ends with a separator,
 * and so does a DNS label.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "")
}

/**
 * The first free slug for `base` — `base`, then `base-2`, `base-3`, … — with
 * `fallback` used when the name slugifies to nothing. `taken` answers for one
 * environment; the caller holds the only write connection, so nothing can
 * claim the answer between this check and its insert.
 */
export function availableSlug(
  base: string,
  fallback: string,
  taken: (slug: string) => boolean,
): string {
  const root = base || fallback
  if (!taken(root)) return root
  for (let n = 2; n < 100; n++) {
    const candidate = `${root}-${n}`
    if (!taken(candidate)) return candidate
  }
  // Ninety-nine resources slugifying alike in one environment is a script,
  // not a person; the fallback is id-derived and so cannot collide.
  return fallback
}

/** True for a string the slug rule accepts. */
export function isValidSlug(slug: string): boolean {
  return RESOURCE_NAME_RE.test(slug)
}
