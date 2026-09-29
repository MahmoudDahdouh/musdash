import { GitHubError } from "./api.ts"

/**
 * One retry after a 401, for calls made with an installation token.
 *
 * Kept free of the logger, config and database so the retry rule — exactly
 * once, only on 401, never on a failed acquire — is testable with plain stubs.
 * tokens.ts binds it to the real cache.
 *
 * Why a 401 is worth one retry and nothing else is: a cached token can be
 * revoked early (the installation was suspended and unsuspended, its
 * permissions changed, the App's key was rotated) while it still has most of
 * its hour left. The cache would keep handing it out until then. A fresh mint
 * either fixes that or fails in a way the caller reports. A 403, 404 or 5xx is
 * not about the token, so re-minting would only double the requests.
 */

export interface TokenRetryDeps {
  /** Cached or freshly minted token. A rejection here is never retried. */
  acquire: () => Promise<string>
  /** Called once, with the token GitHub rejected. Must not log it. */
  invalidate: (failedToken: string) => void
}

/** Retries exactly once, only when `call` rejects with GitHubError status 401. */
export async function withTokenRetry<T>(
  deps: TokenRetryDeps,
  call: (token: string) => Promise<T>,
): Promise<T> {
  const first = await deps.acquire()
  try {
    return await call(first)
  } catch (err) {
    if (!(err instanceof GitHubError && err.status === 401)) throw err
    deps.invalidate(first)
  }
  // Outside the catch on purpose: a second 401 must surface as-is, not loop.
  const second = await deps.acquire()
  return call(second)
}

/**
 * Compare-and-delete: removes the entry only if it still holds `failedToken`.
 * Returns whether it deleted.
 *
 * Unconditional deletion would be wrong under interleaving. Two calls can fail
 * with the same stale token; the first drops it and re-mints, and the second
 * must not then drop the NEW token it never used — that would force a third
 * mint and, with enough callers, a mint per request.
 */
export function dropIfCurrent<V extends { token: string }>(
  cache: Map<number, V>,
  installationId: number,
  failedToken: string,
): boolean {
  const entry = cache.get(installationId)
  if (entry === undefined || entry.token !== failedToken) return false
  cache.delete(installationId)
  return true
}
