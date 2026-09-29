/**
 * The only module that talks to api.github.com.
 *
 * Everything above it names an endpoint and an auth kind; nothing else builds a
 * URL, sets a header, or reads a status code. That containment is what makes
 * "no GitHub credential ever reaches a log line" checkable by reading one file.
 *
 * A failure message may classify the response body into a fixed boolean, but
 * never includes it: a 401 body can echo fragments of the credential that
 * failed, and these messages reach the deploy log.
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
  /**
   * The HTTP status, or 0 when no HTTP response was received (timeout). A
   * timeout is never reported as 401, so withTokenRetry never re-mints on one.
   */
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
    "user-agent": "musdash",
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
 * How far the server's clock must be from GitHub's before a 401 on an App JWT
 * is blamed on it. Asymmetric, because the JWT's window is: jwt.ts backdates
 * `iat` by 60s and sets `exp` 480s ahead.
 *
 * - Ahead: past 60s, `iat` lands in GitHub's future and the JWT is rejected.
 *   50s leaves room for the Date header's one-second resolution and the time
 *   the response spent in flight.
 * - Behind: the JWT only fails once `exp` is in GitHub's past, past 480s.
 *   A clock 51–480s behind still signs an acceptable JWT, so blaming it would
 *   send the user to the wrong fix; 450s leaves the same kind of margin.
 */
const CLOCK_AHEAD_REPORT_MS = 50_000
const CLOCK_BEHIND_REPORT_MS = 450_000

/**
 * The instant a secondary rate limit lifts, from a Retry-After header in either
 * of its two forms (delta-seconds or HTTP-date), or null when it is missing or
 * neither form parses.
 */
function retryAfterIso(header: string | null, now: number): string | null {
  if (header === null) return null
  const at = /^\d+$/.test(header)
    ? now + Number(header) * 1000
    : Date.parse(header)
  // A delta too large for a Date would make toISOString throw a RangeError in
  // place of the GitHubError; treat it like an unparseable header.
  const date = new Date(at)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

/**
 * Turns a failed response into a message a user can act on.
 *
 * May classify the response body into a fixed boolean, but never includes it:
 * a 401 body can echo fragments of the credential that failed, and this string
 * reaches the deploy log. The same reasoning applies to the PATH, which is why
 * it goes through sanitizePath — a variable segment can itself be a credential.
 *
 * `authKind` is the kind only, never the Auth value, so this function cannot
 * be handed a credential to leak. `now` is injectable so the clock-skew and
 * Retry-After branches are testable against a fixed instant.
 */
export async function describeFailure(
  res: Response,
  path: string,
  authKind: Auth["kind"],
  now: number = Date.now(),
): Promise<GitHubError> {
  // Drain the body so the connection can be reused. The only thing kept from it
  // is one boolean — the text itself is never bound to a name, so it cannot be
  // interpolated into a message by a later edit.
  const mentionsSuspended = /suspended/i.test(await res.text().catch(() => ""))
  const shape = sanitizePath(path)
  const status = res.status
  const reset = res.headers.get("x-ratelimit-reset")
  const remaining = res.headers.get("x-ratelimit-remaining")
  const retryAfter = res.headers.get("retry-after")

  // Primary limit first: GitHub can send Retry-After alongside an exhausted
  // quota, and the reset time is the more precise answer.
  if ((status === 403 || status === 429) && remaining === "0") {
    const at = reset
      ? new Date(Number(reset) * 1000).toISOString()
      : "an unknown time"
    return new GitHubError(
      `GitHub's rate limit is exhausted; it resets at ${at}`,
      status,
    )
  }
  // Secondary (abuse) limit: a 403 is only one when Retry-After says so, since
  // a plain 403 is far more often a permission problem. A 429 always is.
  if ((status === 403 && retryAfter !== null) || status === 429) {
    const at = retryAfterIso(retryAfter, now)
    return new GitHubError(
      at === null
        ? `GitHub's secondary rate limit was hit for ${shape}; retry in a minute or two`
        : `GitHub's secondary rate limit was hit for ${shape}; retry after ${at}`,
      status,
    )
  }
  if (status === 401) {
    // Only an App JWT carries timestamps GitHub checks against its own clock;
    // an installation token or an anonymous call cannot be rejected for skew.
    const githubMs = Date.parse(res.headers.get("date") ?? "")
    const skew = now - githubMs
    if (
      authKind === "app" &&
      Number.isFinite(githubMs) &&
      (skew > CLOCK_AHEAD_REPORT_MS || -skew > CLOCK_BEHIND_REPORT_MS)
    ) {
      const seconds = Math.round(Math.abs(now - githubMs) / 1000)
      const direction = now > githubMs ? "ahead of" : "behind"
      return new GitHubError(
        `GitHub rejected musdash's credentials — this server's clock is ${seconds} seconds ${direction} GitHub. Sync the clock with NTP; if that does not help, the App's key may have been rotated — reconnect GitHub in Settings.`,
        401,
      )
    }
    return new GitHubError(
      "GitHub rejected musdash's credentials — the App may have been deleted or its key rotated. Reconnect GitHub in Settings.",
      401,
    )
  }
  if (status === 403 && mentionsSuspended) {
    return new GitHubError(
      `The GitHub App installation is suspended — unsuspend it in GitHub settings (${shape})`,
      403,
    )
  }
  if (status === 404) {
    return new GitHubError(
      `GitHub returned 404 for ${shape} — the installation may no longer grant access to it`,
      404,
    )
  }
  // Keyed on the route shape, not the raw path: this message deliberately
  // names neither the repository nor the ref. getCommit restates it with both
  // via branchNotFound, where they are known to be validated values.
  if (status === 422 && shape === "/repos/*/*/commits/*") {
    return new GitHubError(
      `GitHub returned 422 for ${shape} — the branch or commit was not found`,
      422,
    )
  }
  return new GitHubError(`GitHub returned ${status} for ${shape}`, status)
}

/**
 * A GitHubError(status 0) for an AbortSignal timeout, else null.
 *
 * Status 0 rather than any HTTP code: no response arrived, and in particular a
 * timeout must never look like a 401 or withTokenRetry would re-mint a token
 * over what is a network problem. Neither the runtime's message nor the
 * original error is carried over — the message is fixed text plus the route
 * shape, so nothing unsanitised can ride along into the deploy log.
 */
export function mapTimeout(err: unknown, path: string): GitHubError | null {
  if (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    err.name === "TimeoutError"
  ) {
    return new GitHubError(
      `GitHub did not respond within ${REQUEST_TIMEOUT_MS / 1000}s (${sanitizePath(path)})`,
      0,
    )
  }
  return null
}

/**
 * The 422 from a commits lookup, restated with the repo and ref it was for;
 * else null.
 *
 * Names the repository and ref on purpose, unlike every other message here:
 * both were validated by isValidRepoRef/isValidGitRef before any request, are
 * the user's own input, and already appear in the deploy log. Lives here rather
 * than in repos.ts so it can be tested without importing the database.
 */
export function branchNotFound(
  err: unknown,
  repo: string,
  ref: string,
): GitHubError | null {
  if (err instanceof GitHubError && err.status === 422) {
    return new GitHubError(`Branch \`${ref}\` not found in \`${repo}\`.`, 422)
  }
  return null
}

/**
 * Whether a ref is a full commit SHA, exactly as GitHub returns one: 40
 * lowercase hex. The shape a "Deploy this again" pins its build to, and the
 * shape getCommit uses to word a 422 as a missing commit rather than a missing
 * branch. A branch could in principle carry this name too; musdash never pins
 * to one, and a branch named like a SHA would only get the commit wording.
 */
export function isFullCommitSha(ref: string): boolean {
  return /^[0-9a-f]{40}$/.test(ref)
}

/**
 * The 422 from a commits lookup of a pinned commit, restated with the repo and
 * the short SHA; else null. The counterpart of branchNotFound, for the same
 * reasons: the repository is validated input already in the deploy log, and
 * the SHA was recorded by musdash from GitHub's own answer.
 */
export function commitNotFound(
  err: unknown,
  repo: string,
  sha: string,
): GitHubError | null {
  if (err instanceof GitHubError && err.status === 422) {
    return new GitHubError(
      `Commit \`${sha.slice(0, 7)}\` not found in \`${repo}\`.`,
      422,
    )
  }
  return null
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
  // Only the fetch itself is wrapped: a timeout is the one rejection worth
  // restating, and anything else must surface as it was thrown.
  let res: Response
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        ...headers(auth),
        ...(init.headers as Record<string, string>),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    throw mapTimeout(err, path) ?? err
  }
  // A caller that asked for redirect:"manual" wants the 3xx itself — the
  // archive endpoint answers 302 with a signed URL, and that is a success, not
  // a failure. Only treat it as an error when we were following redirects.
  const isManualRedirect =
    init.redirect === "manual" && res.status >= 300 && res.status < 400
  if (!res.ok && !isManualRedirect) {
    throw await describeFailure(res, path, auth.kind)
  }
  return res
}

export async function ghJson<T>(
  path: string,
  auth: Auth,
  init: RequestInit = {},
): Promise<T> {
  const res = await ghFetch(path, auth, init)
  // The timeout signal set in ghFetch still governs the body, so a stalled
  // stream rejects here, after ghFetch has already returned.
  try {
    return (await res.json()) as T
  } catch (err) {
    throw mapTimeout(err, path) ?? err
  }
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
    // Same as ghJson: the body read is still under the request's timeout.
    let body: unknown
    try {
      body = await res.json()
    } catch (err) {
      throw mapTimeout(err, url) ?? err
    }
    out.push(...pick(body))
    url = nextLink(res.headers.get("link"))
  }
  return out
}
