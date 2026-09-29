import { describe, expect, test } from "bun:test"
import {
  buildFingerprint,
  type FingerprintInputs,
  fingerprintKey,
} from "./fingerprint.ts"

/**
 * The fingerprint decides whether a push skips its build (D59). The two ways
 * it goes wrong are both silent: an input it misses makes a changed build reuse
 * a stale image, and an unstable serialisation makes identical builds never
 * match. Every input is flipped on its own below for the first; insertion
 * order for the second.
 */

const key = fingerprintKey(Buffer.alloc(32, 7))

const base: FingerprintInputs = {
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  repo: "owner/app",
  pack: "railpack",
  dockerfilePath: null,
  buildContext: null,
  buildVars: { NODE_ENV: "production", API_URL: "https://example.test" },
}

const fp = (patch: Partial<FingerprintInputs> = {}) =>
  buildFingerprint(key, { ...base, ...patch })

describe("buildFingerprint", () => {
  test("same key and inputs give the same 64-char lowercase hex", () => {
    const a = fp()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(fp()).toBe(a)
  })

  test("independent of the order the variables were inserted in", () => {
    expect(
      fp({
        buildVars: { API_URL: "https://example.test", NODE_ENV: "production" },
      }),
    ).toBe(fp())
  })

  test("changing any single input changes it", () => {
    const original = fp()
    const variants: Partial<FingerprintInputs>[] = [
      { commitSha: "fedcba9876543210fedcba9876543210fedcba98" },
      { repo: "owner/other" },
      { pack: "dockerfile" },
      { dockerfilePath: "Dockerfile" },
      { buildContext: "apps/web" },
      // A variable renamed, keeping its value.
      {
        buildVars: { NODE_ENV2: "production", API_URL: "https://example.test" },
      },
      // A value changed, keeping its name.
      {
        buildVars: { NODE_ENV: "development", API_URL: "https://example.test" },
      },
      // One added, one removed.
      { buildVars: { ...base.buildVars, EXTRA: "1" } },
      { buildVars: { NODE_ENV: "production" } },
    ]
    const seen = new Set([original])
    for (const v of variants) {
      const changed = fp(v)
      expect(changed).not.toBe(original)
      seen.add(changed)
    }
    // Distinct from each other too, not merely from the original.
    expect(seen.size).toBe(variants.length + 1)
  })

  test("a null path differs from a set one, and from an empty string", () => {
    const withPath = { ...base, dockerfilePath: "Dockerfile" }
    expect(buildFingerprint(key, withPath)).not.toBe(fp())
    expect(fp({ dockerfilePath: "" })).not.toBe(fp())
    expect(fp({ buildContext: "" })).not.toBe(fp())
  })

  test("a value cannot run into the next field", () => {
    // With a joined string, {a: "b,c"} and {a: "b", c: ""} could collide.
    expect(fp({ buildVars: { A: "x,B=y" } })).not.toBe(
      fp({ buildVars: { A: "x", B: "y" } }),
    )
  })

  test("a different key gives a different result", () => {
    const other = fingerprintKey(Buffer.alloc(32, 8))
    expect(buildFingerprint(other, base)).not.toBe(fp())
  })

  test("the output carries no variable name or value", () => {
    const secret = "hunter2-DISTINCTIVE-value-9f3a"
    const out = fp({ buildVars: { SUPER_SECRET_NAME: secret } })
    expect(out).not.toContain(secret)
    expect(out).not.toContain(secret.toLowerCase())
    expect(out).not.toContain("SUPER_SECRET_NAME")
    expect(out.toLowerCase()).not.toContain("super_secret_name")
    expect(out).not.toContain(Buffer.from(secret).toString("hex"))
  })
})

describe("fingerprintKey", () => {
  test("deterministic, and never the secret key itself", () => {
    const secret = Buffer.alloc(32, 7)
    const a = fingerprintKey(secret)
    expect(fingerprintKey(Buffer.alloc(32, 7)).equals(a)).toBe(true)
    expect(a.equals(secret)).toBe(false)
    expect(a.length).toBe(32)
  })

  test("different secret keys derive different fingerprint keys", () => {
    expect(
      fingerprintKey(Buffer.alloc(32, 1)).equals(
        fingerprintKey(Buffer.alloc(32, 2)),
      ),
    ).toBe(false)
  })
})
