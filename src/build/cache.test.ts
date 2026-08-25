import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { dirSizeBytes, sweepBuildCache } from "./cache.ts"

/**
 * Unlike every other test here, these touch a real filesystem — the code under
 * test is filesystem policy and an in-memory database has no analogue for it.
 * Everything happens inside a fresh mkdtemp directory that is removed after
 * each test, so nothing reaches data/build-cache.
 *
 * This code earns tests despite the deliberately narrow testing rule because
 * its failure mode is silent and destructive: it deletes data on a timer, and
 * an inverted sort would evict the newest caches instead of the oldest while
 * every build still succeeded, just slowly. Nobody would notice for weeks.
 */

/** One gigabyte keeps the arithmetic legible: the low watermark lands on
 *  0.8GB, and the fixtures below are sized against it. Passed explicitly rather
 *  than set through the environment because config freezes on first import
 *  anywhere in the process, so an env var only works when this file happens to
 *  load first. */
const CAP_GB = 1
const GB = 1024 * 1024 * 1024
let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "musdash-cache-"))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Creates a cache directory of roughly `bytes`, last modified at `mtimeMs`. */
function makeCacheDir(name: string, bytes: number, mtimeMs: number): void {
  const dir = join(root, name)
  mkdirSync(join(dir, "blobs", "sha256"), { recursive: true })
  writeFileSync(join(dir, "index.json"), "{}")
  writeFileSync(join(dir, "blobs", "sha256", "blob"), Buffer.alloc(bytes))
  const seconds = mtimeMs / 1000
  utimesSync(dir, seconds, seconds)
}

function remaining(): string[] {
  return readdirSync(root).sort()
}

describe("sweepBuildCache", () => {
  test("removes orphans and keeps directories with a live resource", () => {
    makeCacheDir("aaaaaaaa", 1024, Date.now())
    makeCacheDir("bbbbbbbb", 1024, Date.now())

    const result = sweepBuildCache(root, new Set(["aaaaaaaa"]), CAP_GB)

    expect(result.orphansRemoved).toBe(1)
    expect(result.evicted).toBe(0)
    expect(remaining()).toEqual(["aaaaaaaa"])
  })

  test("evicts oldest-first down to the low watermark", () => {
    const now = Date.now()
    const half = Math.floor(GB * 0.5)
    // Three half-gigabyte caches against a 1GB cap: the newest two already
    // exceed the 0.8GB low watermark, so the newest survives alone.
    makeCacheDir("newest00", half, now)
    makeCacheDir("middle00", half, now - 60_000)
    makeCacheDir("oldest00", half, now - 120_000)

    const live = new Set(["newest00", "middle00", "oldest00"])
    const result = sweepBuildCache(root, live, CAP_GB)

    expect(result.orphansRemoved).toBe(0)
    expect(result.evicted).toBe(2)
    expect(remaining()).toEqual(["newest00"])
    expect(result.keptBytes).toBeGreaterThanOrEqual(half)

    // The hysteresis check: a second pass over what survived must do nothing.
    // Without a low watermark this would keep evicting one directory per run.
    const second = sweepBuildCache(root, live, CAP_GB)
    expect(second.evicted).toBe(0)
    expect(remaining()).toEqual(["newest00"])
  })

  test("leaves everything in place when under the cap", () => {
    makeCacheDir("aaaaaaaa", 1024, Date.now())
    makeCacheDir("bbbbbbbb", 1024, Date.now() - 60_000)

    const result = sweepBuildCache(root, new Set(["aaaaaaaa", "bbbbbbbb"]), CAP_GB)

    expect(result.evicted).toBe(0)
    expect(remaining()).toEqual(["aaaaaaaa", "bbbbbbbb"])
  })

  test("keeps caches sitting between the low watermark and the cap", () => {
    // The interval the first implementation got wrong. Two caches totalling
    // 0.85GB are over the 0.8GB low watermark but under the 1GB cap, so nothing
    // should go: evicting here would silently turn the cap into 80% of itself.
    const now = Date.now()
    makeCacheDir("newest00", Math.floor(GB * 0.45), now)
    makeCacheDir("older000", Math.floor(GB * 0.4), now - 60_000)

    const result = sweepBuildCache(
      root,
      new Set(["newest00", "older000"]),
      CAP_GB,
    )

    expect(result.evicted).toBe(0)
    expect(remaining()).toEqual(["newest00", "older000"])
  })

  test("evicts the older caches even when the newest is the large one", () => {
    // A per-entry fit test rather than a prefix cut inverts the policy here:
    // the newest cache does not fit under the watermark, so it would be dropped
    // while the two small older ones survived — largest-first, which is exactly
    // what LRU exists to avoid.
    const now = Date.now()
    makeCacheDir("newest00", Math.floor(GB * 0.93), now)
    makeCacheDir("older001", Math.floor(GB * 0.06), now - 60_000)
    makeCacheDir("older002", Math.floor(GB * 0.06), now - 120_000)

    const result = sweepBuildCache(
      root,
      new Set(["newest00", "older001", "older002"]),
      CAP_GB,
    )

    expect(result.evicted).toBe(2)
    expect(remaining()).toEqual(["newest00"])
  })

  test("keeps a single cache that fills most of the cap", () => {
    // The same bug in its worst form: a lone 0.9GB cache under a 1GB cap was
    // deleted outright, then rebuilt and deleted again every day, with no
    // warning because it never exceeded the cap itself.
    makeCacheDir("solo0000", Math.floor(GB * 0.9), Date.now())

    const result = sweepBuildCache(root, new Set(["solo0000"]), CAP_GB)

    expect(result.evicted).toBe(0)
    expect(remaining()).toEqual(["solo0000"])
  })
})

describe("dirSizeBytes", () => {
  test("sums files across a nested tree", () => {
    const dir = join(root, "tree")
    mkdirSync(join(dir, "blobs", "sha256"), { recursive: true })
    writeFileSync(join(dir, "index.json"), Buffer.alloc(100))
    writeFileSync(join(dir, "blobs", "sha256", "one"), Buffer.alloc(200))
    writeFileSync(join(dir, "blobs", "sha256", "two"), Buffer.alloc(300))

    expect(dirSizeBytes(dir)).toBe(600)
  })

  test("returns zero for a directory that does not exist", () => {
    expect(dirSizeBytes(join(root, "missing"))).toBe(0)
  })
})
