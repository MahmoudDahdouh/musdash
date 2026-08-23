import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto"
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { config } from "./config.ts"

/**
 * AES-256-GCM for env var values at rest.
 *
 * Blob layout, fixed forever: [12-byte IV][16-byte auth tag][ciphertext].
 * There is no version byte in the schema, so changing this layout would
 * silently corrupt every secret already stored. If it ever must change, add a
 * version prefix and migrate explicitly.
 */

const IV_LEN = 12 // GCM standard nonce length
const TAG_LEN = 16
const KEY_LEN = 32

export class CryptoError extends Error {
  override readonly name = "CryptoError"
}

let cachedKey: Buffer | null = null

/**
 * Loads the key, generating it on first run. Mode 0600 is applied on POSIX;
 * on Windows chmod is a no-op, which is acceptable because production is Linux
 * and the dev machine holds no real secrets.
 */
export function loadKey(path: string = config.secretKeyPath): Buffer {
  if (cachedKey) return cachedKey

  if (existsSync(path)) {
    const key = readFileSync(path)
    if (key.length !== KEY_LEN) {
      throw new CryptoError(
        `secret key at ${path} is ${key.length} bytes, expected ${KEY_LEN}`,
      )
    }
    cachedKey = key
    return key
  }

  const key = randomBytes(KEY_LEN)
  writeFileSync(path, key, { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    // Windows: no POSIX modes. Not fatal.
  }
  cachedKey = key
  return key
}

/** Test seam: forget the cached key so a different path can be loaded. */
export function resetKeyCache(): void {
  cachedKey = null
}

export function encrypt(plaintext: string, key: Buffer = loadKey()): Buffer {
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
}

/**
 * Throws on any tampering. GCM authenticates on `final()`, so a flipped bit in
 * the ciphertext, the tag, or the IV all fail here — that error must never be
 * caught and turned into a fallback value.
 */
export function decrypt(blob: Uint8Array, key: Buffer = loadKey()): string {
  if (blob.length < IV_LEN + TAG_LEN) {
    throw new CryptoError(
      `ciphertext is ${blob.length} bytes, shorter than the ${IV_LEN + TAG_LEN}-byte envelope`,
    )
  }
  const buf = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength)
  const iv = buf.subarray(0, IV_LEN)
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN)
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN)

  const decipher = createDecipheriv("aes-256-gcm", key, iv)
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8")
  } catch (cause) {
    throw new CryptoError("ciphertext failed authentication", { cause })
  }
}

/** Constant-time comparison for CSRF tokens and session ids. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("hex")
}
