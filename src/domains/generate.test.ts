import { expect, test } from "bun:test"
import { isValidHostname } from "../caddy/client.ts"
import { generateAutoHost, randomLabel } from "./generate.ts"
import { ADJECTIVES, NOUNS } from "./words.ts"

const BASE = "168.235.65.204.sslip.io"

test("the word lists are unique, lowercase and short", () => {
  for (const words of [ADJECTIVES, NOUNS]) {
    expect(new Set(words).size).toBe(words.length)
    for (const w of words) expect(w).toMatch(/^[a-z]{2,8}$/)
  }
})

test("generated hosts are valid, under the base, and never the dashboard's", () => {
  for (let i = 0; i < 1000; i++) {
    const host = generateAutoHost(BASE, () => false, `able-acorn.${BASE}`)
    expect(host).toBeDefined()
    const h = host as string
    expect(isValidHostname(h)).toBe(true)
    expect(h.endsWith(`.${BASE}`)).toBe(true)
    expect(h).toMatch(/^[a-z]+-[a-z]+\./)
    expect(h).not.toBe(`able-acorn.${BASE}`)
  }
})

test("a collision retries, then falls back to a suffixed pair", () => {
  // pick() always returns 0, so every plain candidate is the same taken name.
  const zero = () => 0
  const plain = `${randomLabel(zero)}.${BASE}`
  const host = generateAutoHost(BASE, (h) => h === plain, undefined, zero)
  expect(host).toMatch(/^able-acorn-[0-9a-f]{4}\.168\.235\.65\.204\.sslip\.io$/)
})

test("a base that cannot form a hostname yields nothing", () => {
  expect(generateAutoHost("not a domain", () => false, undefined)).toBe(
    undefined,
  )
})
