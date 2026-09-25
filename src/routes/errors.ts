/**
 * The error keys a refused form redirects back with (D37).
 *
 * A key, never a sentence: the words live in src/views/partials/errors.eta, and
 * the query string carries only something from this list. That keeps
 * user-facing text out of handlers, and keeps anything the user typed — an env
 * value most of all — out of the URL, the browser history and the proxy's
 * access log.
 */
export const ERROR_KEYS = [
  "image-invalid",
  "resource-name-taken",
  "repo-required",
  "branch-invalid",
  "env-name-taken",
  "domain-invalid",
  "domain-taken",
  "domain-dashboard",
  "env-invalid-line",
  "env-scope-duplicate",
  "github-no-domain",
  "github-no-flow",
  "github-state-mismatch",
  "github-no-code",
  "github-confirm",
] as const

export type ErrorKey = (typeof ERROR_KEYS)[number]

/**
 * A known key, or null.
 *
 * A membership check against the list, never a property lookup: the value is
 * whatever a link said, and `__proto__` or `constructor` must be as unknown as
 * `nope`. Anything that is not a single string — Elysia hands a repeated param
 * over as an array — is unknown too.
 */
export function errorKeyFromQuery(value: unknown): ErrorKey | null {
  return ERROR_KEYS.find((key) => key === value) ?? null
}

/**
 * `path` with `error=<key>` appended, as pathname plus search.
 *
 * Built with URLSearchParams rather than concatenation so an existing query
 * (`?tab=env`) is extended, not broken. Never a fragment: the notice sits at
 * the top of the page, and a fragment would scroll away from it.
 */
export function withError(path: string, key: ErrorKey): string {
  // The base only lets URL parse a relative path; it never reaches the output.
  const url = new URL(path, "http://musdash.invalid")
  url.searchParams.append("error", key)
  return `${url.pathname}${url.search}`
}
