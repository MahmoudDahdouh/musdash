import { describe, expect, test } from "bun:test"
import { redactGithub, redactValues } from "./log.ts"

/**
 * Installation tokens are a class of secret redactValues structurally cannot
 * catch: it matches against the known env values of a resource, and a token
 * minted at runtime belongs to no such set. A mechanical check beats a rule
 * nobody can enforce by reading.
 */
describe("redactGithub", () => {
  test("redacts an installation token", () => {
    const token = "ghs_16C7e42F292c6912E7710c838347Ae178B4a"
    const out = redactGithub(`Authorization: Bearer ${token} failed`)
    expect(out).not.toContain(token)
    expect(out).toContain("[redacted]")
  })

  test("redacts every GitHub token prefix", () => {
    for (const prefix of ["ghp", "gho", "ghu", "ghs", "ghr"]) {
      const token = `${prefix}_16C7e42F292c6912E7710c838347Ae178B4a`
      expect(redactGithub(`token=${token}`)).not.toContain(token)
    }
  })

  test("redacts a signed archive URL, which is itself a credential", () => {
    const url =
      "https://codeload.github.com/o/r/legacy.tar.gz/refs/heads/main?token=ABCDEF"
    expect(redactGithub(`fetching ${url}`)).not.toContain("token=ABCDEF")
  })

  test("redacts a private key block", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----"
    expect(redactGithub(`key: ${pem}`)).not.toContain("BEGIN RSA PRIVATE KEY")
  })

  test("leaves ordinary build output alone", () => {
    const line = "Step 3/7 : RUN npm ci --omit=dev"
    expect(redactGithub(line)).toBe(line)
  })

  test("composes with redactValues without either dropping the other", () => {
    const envSecret = "super-secret-db-password"
    const token = "ghs_16C7e42F292c6912E7710c838347Ae178B4a"
    const line = `DATABASE_URL=${envSecret} and Bearer ${token}`
    const out = redactGithub(redactValues(line, [envSecret]))
    expect(out).not.toContain(envSecret)
    expect(out).not.toContain(token)
  })
})
