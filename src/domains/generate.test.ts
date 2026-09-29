import { expect, test } from "bun:test"
import { isValidHostname } from "../caddy/client.ts"
import {
  generateAutoHost,
  isPublicIPv4,
  legacyAutoHosts,
  randomLabel,
} from "./generate.ts"
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

test("the dashboard's own hostname is never generated (N-3)", () => {
  // pick() always 0: every plain candidate is able-acorn, which is the
  // dashboard's name, so the generator must fall through to a suffixed one.
  const host = generateAutoHost(
    BASE,
    () => false,
    `able-acorn.${BASE}`,
    () => 0,
  )
  expect(host).toMatch(/^able-acorn-[0-9a-f]{4}\./)
})

test("the upgrade stores each resource's current wildcard host once", () => {
  const rows = new Set([
    "web-production.old.example.com",
    "taken-production.new.example.com",
  ])
  const planned = legacyAutoHosts(
    [
      // Created under an older wildcard: has that row, still needs this one.
      { resourceId: "r1", slug: "web", environmentName: "production" },
      // Already a row somewhere: routed there, left alone.
      { resourceId: "r2", slug: "taken", environmentName: "production" },
      // Would be the dashboard's own name.
      { resourceId: "r3", slug: "mus", environmentName: "prod" },
      // Same name as r1 from another project: only one route ever won it.
      { resourceId: "r4", slug: "web", environmentName: "production" },
    ],
    "new.example.com",
    "mus-prod.new.example.com",
    (h) => rows.has(h),
  )
  expect(planned).toEqual([
    { resourceId: "r1", host: "web-production.new.example.com" },
  ])
})

test("a public IPv4 address is one Let's Encrypt could reach", () => {
  for (const ok of ["168.235.65.204", "203.0.113.7", "8.8.8.8"]) {
    expect(isPublicIPv4(ok)).toBe(true)
  }
  for (const bad of [
    "10.0.0.1",
    "127.0.0.1",
    "0.0.0.0",
    "169.254.1.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "100.64.0.1",
    "100.127.0.1",
    "224.0.0.1",
    "1.2.3",
    "::1",
    "abc",
  ]) {
    expect(isPublicIPv4(bad)).toBe(false)
  }
})
