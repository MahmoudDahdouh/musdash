import { createHmac } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { verifySignature } from "./webhook.ts"

/**
 * The digests here are computed with an independent createHmac call rather than
 * by asking verifySignature what it expects. A test that signs with the
 * function under test proves only that it agrees with itself, which is exactly
 * the failure mode of a hand-rolled verifier.
 */

const PREFIX_LEN = "sha256=".length
const SECRET = "a-webhook-secret-from-github"
const OTHER_SECRET = "a-different-webhook-secret"

const BODY = JSON.stringify({
  ref: "refs/heads/main",
  repository: { full_name: "octocat/hello-world" },
  deleted: false,
})

function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`
}

/** Flips one bit of the character at `index`, keeping the string the same length. */
function flipByte(text: string, index: number): string {
  const code = text.charCodeAt(index)
  return (
    text.slice(0, index) +
    String.fromCharCode(code ^ 0x01) +
    text.slice(index + 1)
  )
}

describe("verifySignature", () => {
  test("accepts a body signed with the same secret", () => {
    expect(verifySignature(BODY, sign(BODY, SECRET), SECRET)).toBe(true)
  })

  test("rejects a body with a single flipped byte, anywhere", () => {
    const signature = sign(BODY, SECRET)
    // Front, middle and back: a verifier that hashed only a prefix of the body
    // would still pass a front-only case.
    for (const index of [0, Math.floor(BODY.length / 2), BODY.length - 1]) {
      const tampered = flipByte(BODY, index)
      expect(tampered).not.toBe(BODY)
      expect(tampered.length).toBe(BODY.length)
      expect(verifySignature(tampered, signature, SECRET)).toBe(false)
    }
  })

  test("rejects a signature with a single flipped hex character", () => {
    const signature = sign(BODY, SECRET)
    // Index 7 is inside the digest, past the "sha256=" prefix.
    const hexIndex = 7
    const original = signature[hexIndex] as string
    const swapped = original === "a" ? "b" : "a"
    const tampered =
      signature.slice(0, hexIndex) + swapped + signature.slice(hexIndex + 1)

    expect(tampered).not.toBe(signature)
    expect(tampered.length).toBe(signature.length)
    expect(verifySignature(BODY, tampered, SECRET)).toBe(false)
  })

  test("rejects a signature made with a different secret", () => {
    expect(verifySignature(BODY, sign(BODY, OTHER_SECRET), SECRET)).toBe(false)
  })

  test("returns false, never throws, for a malformed header", () => {
    // timingSafeEqual throws on a length mismatch, so each of these would be a
    // 500 on a public endpoint if the length guard were missing.
    const digest = sign(BODY, SECRET)
    const malformed: (string | null)[] = [
      null,
      "",
      // No "sha256=" prefix at all.
      digest.slice(PREFIX_LEN),
      // The right prefix, a truncated digest.
      digest.slice(0, digest.length - 10),
      // A different algorithm prefix.
      `sha1=${digest.slice(PREFIX_LEN)}`,
      "sha256=",
      "garbage",
    ]

    for (const header of malformed) {
      expect(() => verifySignature(BODY, header, SECRET)).not.toThrow()
      expect(verifySignature(BODY, header, SECRET)).toBe(false)
    }
  })

  test("verifies the exact bytes, not a re-serialized body", () => {
    // This is the whole reason verifySignature takes text. GitHub signs the
    // bytes it sent; JSON.stringify(JSON.parse(raw)) is a DIFFERENT document
    // with the same meaning, and signing that instead fails every delivery.
    const raw = '{"a": 1, "b": [1, 2]}'
    const reserialized = JSON.stringify(JSON.parse(raw) as unknown)
    expect(reserialized).not.toBe(raw)

    expect(verifySignature(raw, sign(raw, SECRET), SECRET)).toBe(true)
    expect(verifySignature(raw, sign(reserialized, SECRET), SECRET)).toBe(false)
    // And symmetrically: the canonical form does not verify against the
    // signature of the original bytes.
    expect(verifySignature(reserialized, sign(raw, SECRET), SECRET)).toBe(false)
  })

  test("accepts a body whose bytes are not canonical JSON", () => {
    // Trailing newline, tabs, and unusual key order all survive verification,
    // because nothing parses before the digest is computed.
    const raw = '{\n\t"b": 2,\n\t"a": 1\n}\n'
    expect(verifySignature(raw, sign(raw, SECRET), SECRET)).toBe(true)
  })
})
