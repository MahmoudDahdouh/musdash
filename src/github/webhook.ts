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
 * Where GitHub delivers webhooks. Exported because src/http.ts exempts this
 * path from the form body limit: a push payload is routinely larger than any
 * form, and a literal copied into a second file would drift from the route.
 */
export const WEBHOOK_PATH = "/webhooks/github"

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

/**
 * The conventional CI skip markers plus their deploy-flavoured forms. Reusing
 * the CI ones means a commit already tagged to skip CI is not deployed either,
 * without the user learning a musdash-specific marker.
 */
const SKIP_MARKERS = [
  "[skip ci]",
  "[ci skip]",
  "[no ci]",
  "[skip cd]",
  "[cd skip]",
] as const

/** The first line of a commit message, the only part searched for a marker. */
function subjectOf(message: string): string {
  const newline = message.indexOf("\n")
  return newline === -1 ? message : message.slice(0, newline)
}

/**
 * Whether EVERY commit in a push asks to skip deploys.
 *
 * Every, not any: a push of two commits where only one is tagged still carries
 * an untagged change, and skipping it would leave that change undeployed with
 * nothing pointing at why. Only the subject counts, so a squash merge whose
 * body lists "* wip [skip ci]" from a branch commit still deploys. Matching is
 * case-sensitive so the marker means exactly one thing.
 *
 * Takes `unknown` because this reads a webhook payload. Any shape it does not
 * recognise — absent, empty, a non-object element, a non-string message — is
 * "do not skip": a wrong skip silently drops a deploy, a wrong deploy costs one
 * build.
 */
export function shouldSkipPush(commits: unknown): boolean {
  if (!Array.isArray(commits)) return false
  const list: readonly unknown[] = commits
  if (list.length === 0) return false
  return list.every((commit) => {
    if (typeof commit !== "object" || commit === null) return false
    if (!("message" in commit)) return false
    const message: unknown = commit.message
    if (typeof message !== "string") return false
    const subject = subjectOf(message)
    return SKIP_MARKERS.some((marker) => subject.includes(marker))
  })
}
