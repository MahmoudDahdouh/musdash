import { createSign } from "node:crypto"

/**
 * The App-level credential: a short-lived RS256 JWT signed with the App's RSA
 * private key. It authenticates musdash AS the App, which is only enough to
 * list installations and mint installation tokens — every repository call uses
 * an installation token instead.
 *
 * Hand-rolled rather than taken from @octokit/auth-app, which costs 10MB of
 * idle RSS against a 100MB ceiling for what is this file plus a fetch. See the
 * deviation entry in docs/DECISIONS.md.
 */

/**
 * Backdated so GitHub never sees a token issued in its own future.
 *
 * Clock skew of a few seconds is routine on a VPS, and GitHub rejects a JWT
 * whose `iat` is ahead of its clock. This is the classic "works on my machine,
 * 401 in production", and 60 seconds costs nothing.
 */
const BACKDATE_SEC = 60

/**
 * GitHub's hard maximum is 600 seconds between iat and exp. With iat backdated
 * 60s, an expiry of now+540 lands on exactly 600 and a rounding difference at
 * either end rejects the token — so leave margin rather than sit on the limit.
 */
const LIFETIME_SEC = 480

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url")
}

/**
 * Signs an App JWT valid for the next few minutes.
 *
 * Deliberately not cached: signing is microseconds, and a cache would add an
 * expiry surface for no gain. The installation token is the one worth caching.
 *
 * The return value is a bearer credential — never log it.
 */
export function appJwt(appId: number, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000)
  // base64url, not base64: a `+` or `/` in the payload makes the token invalid
  // and GitHub reports only "Bad credentials".
  const header = b64url({ alg: "RS256", typ: "JWT" })
  const payload = b64url({
    iat: now - BACKDATE_SEC,
    exp: now + LIFETIME_SEC,
    iss: appId,
  })
  const body = `${header}.${payload}`
  const signature = createSign("RSA-SHA256")
    .update(body)
    .end()
    .sign(privateKeyPem)
    .toString("base64url")
  return `${body}.${signature}`
}
