import { createHmac } from "node:crypto"
import { safeEqual } from "../crypto.ts"

/**
 * Webhook signature verification.
 *
 * Hand-rolled rather than taken from @octokit/webhooks, for the same reason
 * jwt.ts is hand-rolled: the package buys one createHmac call plus a
 * constant-time compare that src/crypto.ts already provides, at a cost measured
 * in megabytes of idle RSS against a 100MB ceiling. See the deviation entry in
 * docs/DECISIONS.md.
 */

const PREFIX = "sha256="

/**
 * Verifies GitHub's X-Hub-Signature-256 over the RAW request body.
 *
 * Takes raw text, never a re-serialized object. JSON.stringify(JSON.parse(x))
 * is not byte-identical to x — GitHub signs the bytes it sent, whitespace and
 * key order included, so re-serializing produces a digest over a different
 * document and every delivery fails. That is the single most likely way to get
 * this wrong, and it is what the test with non-canonical whitespace pins.
 *
 * Returns false rather than throwing for every malformed input: this runs on an
 * unauthenticated public endpoint, so a missing or truncated header is an
 * ordinary hostile request, not an exceptional condition.
 */
export function verifySignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader?.startsWith(PREFIX)) return false

  const expected =
    PREFIX + createHmac("sha256", secret).update(rawBody).digest("hex")

  // safeEqual length-guards before timingSafeEqual, which throws on a length
  // mismatch — a truncated digest must be a false, not a 500.
  return safeEqual(expected, signatureHeader)
}
