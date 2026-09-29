import { expect, test } from "bun:test"
import {
  availableSlug,
  isValidDisplayName,
  isValidSlug,
  normalizeDisplayName,
  SLUG_MAX,
  slugify,
} from "./names.ts"

test("display names take letters, digits, spaces and ( ) [ ] . _ -", () => {
  for (const ok of ["Web (prod)", "API [v2]", "my-app", "a_b.c", "x"]) {
    expect(isValidDisplayName(normalizeDisplayName(ok))).toBe(true)
  }
  for (const bad of [
    "",
    "   ",
    "café",
    "a/b",
    "<script>",
    "a;b",
    "x".repeat(61),
  ]) {
    expect(isValidDisplayName(normalizeDisplayName(bad))).toBe(false)
  }
  expect(normalizeDisplayName("  Web \t (prod)  ")).toBe("Web (prod)")
})

test("slugify produces a valid slug or nothing", () => {
  expect(slugify("My App (v2)")).toBe("my-app-v2")
  expect(slugify("API [v2]")).toBe("api-v2")
  expect(slugify("  --x-- ")).toBe("x")
  expect(slugify("(((")).toBe("")
  const long = slugify(`${"a".repeat(SLUG_MAX - 1)} bcd`)
  expect(long.length).toBeLessThanOrEqual(SLUG_MAX)
  expect(long.endsWith("-")).toBe(false)
  for (const s of [slugify("My App (v2)"), long])
    expect(isValidSlug(s)).toBe(true)
})

test("availableSlug suffixes a collision and falls back when the name has no slug", () => {
  const taken = new Set(["web", "web-2"])
  const has = (s: string) => taken.has(s)
  expect(availableSlug("api", "r-abc", has)).toBe("api")
  expect(availableSlug("web", "r-abc", has)).toBe("web-3")
  expect(availableSlug("", "r-abc", has)).toBe("r-abc")
  expect(
    isValidSlug(availableSlug("a".repeat(SLUG_MAX), "r-abc", () => false)),
  ).toBe(true)
})
