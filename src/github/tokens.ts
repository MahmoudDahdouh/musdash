import { getAppPrivateKey, getGithubApp } from "../db/queries.ts"
import { logger } from "../log.ts"
import { ghJson } from "./api.ts"
import { appJwt } from "./jwt.ts"
import { dropIfCurrent, withTokenRetry } from "./token-retry.ts"

/**
 * Installation access tokens, cached in memory for their hour of life.
 *
 * Never persisted. They expire in an hour and are cheap to re-mint, so writing
 * them to SQLite would create a second secret store with a different lifetime
 * and no benefit.
 */

interface CachedToken {
  token: string
  /** Epoch ms, from GitHub's own expires_at — not computed locally. */
  expiresAt: number
}

const cache = new Map<number, CachedToken>()

/**
 * Mints in progress, keyed by installation id.
 *
 * This is what stops N concurrent callers minting N tokens when one expires.
 * The realistic collision is not deploy-vs-deploy — job concurrency is 1 — but
 * the repo picker rendering while a deploy is running.
 */
const inFlight = new Map<number, Promise<string>>()

/** Refresh this far before the real expiry, so a request in flight at the
 *  boundary still holds a valid token. */
const SKEW_MS = 60_000

interface TokenResponse {
  token: string
  expires_at: string
}

async function mint(installationId: number): Promise<CachedToken> {
  const app = getGithubApp()
  const privateKey = getAppPrivateKey()
  if (!app || !privateKey) {
    throw new Error("GitHub is not connected — register the App in Settings")
  }

  const body = await ghJson<TokenResponse>(
    `/app/installations/${installationId}/access_tokens`,
    { kind: "app", jwt: appJwt(app.appId, privateKey) },
    { method: "POST" },
  )
  return {
    token: body.token,
    // GitHub's clock is authoritative for GitHub's token. Computing
    // now + 3600000 locally would drift with the box's clock.
    expiresAt: Date.parse(body.expires_at),
  }
}

/**
 * A valid token for this installation, minting one only if needed.
 *
 * The cache check and the inFlight.set below MUST stay in one synchronous
 * block. They are atomic only because nothing awaits between them; inserting an
 * await is exactly the refactor that silently reintroduces the double-mint.
 *
 * The return value is a bearer credential — never log it.
 */
export function installationToken(installationId: number): Promise<string> {
  const hit = cache.get(installationId)
  if (hit && hit.expiresAt - SKEW_MS > Date.now()) {
    return Promise.resolve(hit.token)
  }

  const pending = inFlight.get(installationId)
  if (pending) return pending

  const promise = mint(installationId)
    .then((minted) => {
      cache.set(installationId, minted)
      return minted.token
    })
    // finally, not then: a rejected mint must ALSO clear the entry, or one
    // transient network blip leaves a rejected promise cached and every later
    // call awaits the same failure forever.
    .finally(() => {
      inFlight.delete(installationId)
    })

  inFlight.set(installationId, promise)
  return promise
}

/**
 * Runs a token-authenticated GitHub call, re-minting once if GitHub answers 401.
 *
 * Every resource call made with an installation token goes through here rather
 * than calling installationToken() itself, so a token revoked before its hour
 * is up costs one failed request instead of up to an hour of failed deploys.
 *
 * The drop is compare-and-delete (dropIfCurrent), not invalidateToken: another
 * caller may already have replaced the stale token with a fresh one, and
 * deleting that would force a needless extra mint.
 */
export function withInstallationToken<T>(
  installationId: number,
  call: (token: string) => Promise<T>,
): Promise<T> {
  return withTokenRetry(
    {
      acquire: () => installationToken(installationId),
      invalidate: (failed) => {
        dropIfCurrent(cache, installationId, failed)
        // The id and the status only: `failed` is a bearer credential.
        logger.warn(
          { installationId, status: 401 },
          "GitHub rejected a cached installation token; retrying once with a fresh one",
        )
      },
    },
    call,
  )
}

/**
 * Drops an installation's token unconditionally, so the next call re-mints.
 *
 * For lifecycle events (suspend, new permissions, repository access changes,
 * removal), where whichever token happens to be cached was minted under terms
 * that no longer hold.
 */
export function invalidateToken(installationId: number): void {
  cache.delete(installationId)
}

/** Drops every token. Called when the App is disconnected, so a revoked App's
 *  credentials do not linger in memory for the rest of their hour. */
export function clearTokenCache(): void {
  cache.clear()
}
