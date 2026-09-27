import { describe, expect, test } from "bun:test"
import { isStarved, keptAfterBuild } from "./memory.ts"

/**
 * The two readings of BuildKit's memory that decide whether a build is stopped
 * and whether the daemon is restarted. Both misfired in the way these cases
 * pin down: page cache fills a healthy cgroup to its limit, so usage alone
 * cannot tell a starved build from a busy one (P-9), and the daemon's own heap
 * stayed at 227 of 384 MiB after its last build (P-3).
 */

const MIB = 1024 * 1024
const cap = 384 * MIB

describe("isStarved", () => {
  test("anonymous memory at the cap is starved", () => {
    expect(
      isStarved({ usageBytes: cap, anonBytes: 370 * MIB, limitBytes: cap }),
    ).toBe(true)
  })

  test("a cgroup full of page cache is not", () => {
    expect(
      isStarved({ usageBytes: cap, anonBytes: 120 * MIB, limitBytes: cap }),
    ).toBe(false)
  })

  test("without an anon figure, usage has to be at the very limit", () => {
    expect(
      isStarved({ usageBytes: cap, anonBytes: null, limitBytes: cap }),
    ).toBe(true)
    expect(
      isStarved({ usageBytes: 360 * MIB, anonBytes: null, limitBytes: cap }),
    ).toBe(false)
  })
})

describe("keptAfterBuild", () => {
  test("the 227 MiB the daemon kept on the 1GB host is too much", () => {
    expect(
      keptAfterBuild({
        usageBytes: 250 * MIB,
        anonBytes: 227 * MIB,
        limitBytes: cap,
      }),
    ).toBe(true)
  })

  test("an idle daemon is not", () => {
    expect(
      keptAfterBuild({
        usageBytes: 90 * MIB,
        anonBytes: 40 * MIB,
        limitBytes: cap,
      }),
    ).toBe(false)
  })

  test("without an anon figure nothing is restarted", () => {
    expect(
      keptAfterBuild({ usageBytes: cap, anonBytes: null, limitBytes: cap }),
    ).toBe(false)
  })
})
