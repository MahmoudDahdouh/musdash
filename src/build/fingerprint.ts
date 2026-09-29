import { createHmac } from "node:crypto"

/**
 * The identity of a build's inputs, for deciding that a push can reuse an image
 * already built from the same inputs (D60).
 *
 * An HMAC rather than a plain hash, keyed from the env-var secret key. The
 * inputs include build variables, which are secrets; a plain SHA-256 stored in
 * the deployments table would let anyone holding a copy of the database — a
 * backup, a support bundle — confirm guesses at a low-entropy variable offline.
 * Keyed, the database alone is useless for that without data/secret.key.
 *
 * Neither the result nor the inputs are ever logged or emitted.
 */

/**
 * Domain separation: the fingerprint key is derived from, never equal to, the
 * key that encrypts env values, so a flaw in one use cannot leak into the
 * other. Bumping the version invalidates every stored fingerprint, which costs
 * one build per resource and never causes a wrong reuse.
 */
export const FINGERPRINT_LABEL = "musdash build fingerprint v1"

/** HMAC-SHA256(secretKey, FINGERPRINT_LABEL). */
export function fingerprintKey(secretKey: Buffer): Buffer {
  return createHmac("sha256", secretKey).update(FINGERPRINT_LABEL).digest()
}

export interface FingerprintInputs {
  commitSha: string
  repo: string
  /** The STORED pack from gitSource(), before detectBuildPack — detection needs the downloaded tree. */
  pack: "dockerfile" | "railpack"
  dockerfilePath: string | null
  buildContext: string | null
  /** env.build, post-interpolation. */
  buildVars: Readonly<Record<string, string>>
}

/**
 * Lowercase hex HMAC-SHA256(key, canonical). Never log the result or the inputs.
 *
 * The canonical form is JSON with a literal key order and the variables as a
 * sorted list of pairs, so the same inputs always serialise identically —
 * whatever order resolution happened to produce the map in — and no value can
 * run into the next field the way a joined string could.
 */
export function buildFingerprint(
  key: Buffer,
  inputs: FingerprintInputs,
): string {
  const { commitSha, repo, pack, dockerfilePath, buildContext, buildVars } =
    inputs
  const canonical = JSON.stringify({
    commitSha,
    repo,
    pack,
    dockerfilePath,
    buildContext,
    buildVars: Object.keys(buildVars)
      .sort()
      .map((k) => [k, buildVars[k]]),
  })
  return createHmac("sha256", key).update(canonical).digest("hex")
}
