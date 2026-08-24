/**
 * The only module that talks to api.github.com.
 *
 * Everything above it names an endpoint and an auth kind; nothing else builds a
 * URL, sets a header, or reads a status code. That containment is what makes
 * "no GitHub credential ever reaches a log line" checkable by reading one file.
 */

const API = "https://api.github.com"
const API_VERSION = "2022-11-28"

/**
 * Job concurrency is exactly 1, so an unbounded fetch parks every queued deploy
 * behind it. Same reasoning as the Caddy client's request timeout.
 */
const REQUEST_TIMEOUT_MS = 15_000

export class GitHubError extends Error {
  override readonly name = "GitHubError"
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/**
 * Which credential to present.
 *
 * A discriminated value rather than a raw string on purpose: both kinds are
 * sent as `Authorization: Bearer`, so a bare string makes it trivially easy to
 * send an App JWT to a repository endpoint, which fails with a confusing 403.
 * Modelling the distinction makes that mistake unrepresentable.
 */
export type Auth =
  | { kind: "app"; jwt: string }
  | { kind: "installation"; token: string }
  | { kind: "none" }

function headers(auth: Auth): Record<string, string> {
  const base: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": API_VERSION,
    "user-agent": "mosdash",
  }
  if (auth.kind === "app") base.authorization = `Bearer ${auth.jwt}`
  if (auth.kind === "installation") base.authorization = `Bearer ${auth.token}`
  return base
}

/**
 * Route keywords that are part of GitHub's URL shape rather than data.
 *
 * An allow-list, not a deny-list, and that direction is the whole point. A
 * deny-list has to be extended every time an endpoint carrying a secret is
 * added, and the cost of forgetting is a credential in a log file. An
 * allow-list fails closed: a new endpoint's variable segments are masked
 * because nobody taught this set about them yet.
 */
const PATH_KEYWORDS = new Set([
  "app",
  "app-manifests",
  "access_tokens",
  "commits",
  "conversions",
  "installation",
  "installations",
  "repos",
  "repositories",
  "tarball",
])

/**
 * Reduces a request path to its route shape, masking every variable segment.
 *
 * `/app-manifests/<code>/conversions` becomes `/app-manifests/*​/conversions`.
 *
 * This exists because a path segment can BE a credential. The manifest
 * registration code is the sharpest case — it exchanges in one call for the
 * App's client_secret, private key and webhook secret, and the most likely way
 * to fail that exchange is replaying an expired code, which lands on the 404
 * branch below. GITHUB_SECRET_RE (log.ts:38-39) does not match a manifest code,
 * so the redaction backstop would not have caught it either.
 *
 * Structural rather than a special case for that one endpoint: a repository
 * name, a git ref and an installation id are not secrets today, but "the path
 * is safe to print" is an assumption that was already wrong once. Masking every
 * non-keyword segment costs a little debuggability and removes the whole class.
 * The status code and the route shape are what actually identify the failure.
 */
export function sanitizePath(path: string): string {
  // Pagination hands back an absolute URL. Keep only the path, never the query
  // string — a `since` or a token parameter has no business in a log line.
  let pathname = path
  if (/^https?:\/\//.test(path)) {
    try {
      pathname = new URL(path).pathname
    } catch {
      return "(unparseable url)"
    }
  } else {
    const queryAt = pathname.search(/[?#]/)
    if (queryAt !== -1) pathname = pathname.slice(0, queryAt)
  }

  return pathname
    .split("/")
    .map((segment) =>
      segment === "" || PATH_KEYWORDS.has(segment) ? segment : "*",
    )
    .join("/")
}

/**
 * Turns a failed response into a message a user can act on.
 *
 * Never includes the response body: a 401 body can echo fragments of the
 * credential that failed, and this string reaches the deploy log. The same
 * reasoning applies to the PATH, which is why it goes through sanitizePath —
 * a variable segment can itself be a credential.
 */
async function describe(res: Response, path: string): Promise<GitHubError> {
  const shape = sanitizePath(path)
  // Drain the body so the connection can be reused, but do not read it into the
  // message.
  await res.text().catch(() => "")
  const reset = res.headers.get("x-ratelimit-reset")
  const remaining = res.headers.get("x-ratelimit-remaining")

  if ((res.status === 403 || res.status === 429) && remaining === "0") {
    const at = reset
      ? new Date(Number(reset) * 1000).toISOString()
      : "an unknown time"
    return new GitHubError(
      `GitHub's rate limit is exhausted; it resets at ${at}`,
      res.status,
    )
  }
  if (res.status === 401) {
    return new GitHubError(
      "GitHub rejected mosdash's credentials — the App may have been deleted or its key rotated. Reconnect GitHub in Settings.",
      401,
    )
  }
  if (res.status === 404) {
    return new GitHubError(
      `GitHub returned 404 for ${shape} — the installation may no longer grant access to it`,
      404,
    )
  }
  return new GitHubError(
    `GitHub returned ${res.status} for ${shape}`,
    res.status,
  )
}

export async function ghFetch(
  path: string,
  auth: Auth,
  init: RequestInit = {},
): Promise<Response> {
  // Absolute or relative: pagination hands back the fully-qualified URL from
  // the Link header, while callers pass a bare path. Matching only "https://"
  // would silently concatenate an absolute http URL onto the API base.
  const url = /^https?:\/\//.test(path) ? path : `${API}${path}`
  const res = await fetch(url, {
    ...init,
    headers: { ...headers(auth), ...(init.headers as Record<string, string>) },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  // A caller that asked for redirect:"manual" wants the 3xx itself — the
  // archive endpoint answers 302 with a signed URL, and that is a success, not
  // a failure. Only treat it as an error when we were following redirects.
  const isManualRedirect =
    init.redirect === "manual" && res.status >= 300 && res.status < 400
  if (!res.ok && !isManualRedirect) throw await describe(res, path)
  return res
}

export async function ghJson<T>(
  path: string,
  auth: Auth,
  init: RequestInit = {},
): Promise<T> {
  const res = await ghFetch(path, auth, init)
  return (await res.json()) as T
}

/** The `<url>; rel="next"` entry of a Link header, or null at the last page. */
function nextLink(header: string | null): string | null {
  if (!header) return null
  for (const part of header.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim())
    if (match?.[1]) return match[1]
  }
  return null
}

/**
 * Follows Link/rel="next" to the end and returns every item.
 *
 * `pick` exists because /installation/repositories does not return a bare array
 * like almost every other list endpoint — it wraps the items in
 * `{ total_count, repositories }`. Accumulating the response body there yields
 * a list of envelopes instead of repositories.
 */
export async function ghPaginate<T>(
  path: string,
  auth: Auth,
  pick: (body: unknown) => T[],
): Promise<T[]> {
  const out: T[] = []
  let url: string | null = path.includes("?")
    ? `${path}&per_page=100`
    : `${path}?per_page=100`

  while (url) {
    const res = await ghFetch(url, auth)
    out.push(...pick(await res.json()))
    url = nextLink(res.headers.get("link"))
  }
  return out
}
