import { type Dirent, existsSync, readdirSync, rmSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { config } from "../config.ts"
import { listAllResources } from "../db/queries.ts"
import { shortId } from "../ids.ts"
import { logger } from "../log.ts"
import { BuildError } from "./types.ts"

/**
 * The BuildKit layer cache: one directory per resource, kept under a cap.
 *
 * The cache deliberately does not live inside buildsDir. A build directory is
 * deleted when its build ends, which would take the layer cache with it every
 * time and make every deploy cold.
 *
 * Nothing bounded this before, so a long-lived box accumulated layers until the
 * disk filled — the failure the RUNNING.md cap has always promised to prevent.
 * Eviction is LRU by directory mtime. The alternative, largest-first, optimises
 * bytes reclaimed per deletion, which is the wrong objective: the cache's only
 * value is the hit rate on the next build of that resource, so largest-first
 * systematically evicts the biggest apps — exactly the ones whose builds are
 * slowest and whose cache is worth the most seconds.
 *
 * mtime is a real access signal here rather than a guess. BuildKit's
 * `type=local` export rewrites index.json on every export, and every import in
 * musdash is paired with an export in the same buildctl invocation, so an
 * import can never happen without an export. Verified against a real daemon on
 * moby/buildkit:v0.27.0: two builds five seconds apart moved the directory
 * mtime by exactly that. Directory mtime therefore means last build time.
 */

/** Evict down to this fraction of the cap once the cap is exceeded.
 *
 *  The hysteresis is the point. Evicting back to exactly the cap leaves a cache
 *  that trips again on the very next build, so it would evict one directory a
 *  day forever — and in the log, "ran daily and reclaimed almost nothing" is
 *  indistinguishable from "is broken". Twenty percent of headroom buys weeks of
 *  quiet and makes each pass reclaim a number worth reading. */
const LOW_WATERMARK = 0.8

/** BuildKit's local cache layout is index.json plus blobs/sha256/<digest>, so
 *  the real tree is two levels. The guard exists so a symlink or an unexpected
 *  layout cannot turn the walk into an unbounded descent. */
const MAX_WALK_DEPTH = 4

export interface CacheSweepResult {
  orphansRemoved: number
  evicted: number
  /** Bytes still on disk after the sweep, including any directory whose
   *  eviction failed. A directory that could not be sized is counted at what it
   *  was charged rather than what it holds, so this is the number the cap was
   *  applied to, not a measurement of the filesystem. */
  keptBytes: number
}

/**
 * Cache directory for one resource, by cache key.
 *
 * The key is derived from a ULID musdash generated, never from user input, but
 * it is still validated before being joined onto a path: a key carrying `..`
 * would escape buildCacheDir, and this function's whole job is to hand back a
 * path that something later deletes recursively.
 */
export function cacheDir(cacheKey: string): string {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(cacheKey)) {
    throw new BuildError(`unsafe cache key: ${cacheKey}`)
  }
  return resolve(config.buildCacheDir, cacheKey)
}

/**
 * Removes one resource's layer cache. Never throws.
 *
 * Called while deleting a resource, where a throw would fail the deletion over
 * a cache directory nobody will ever read again. The daily sweep is the
 * backstop, so the only cost of a failure here is that the bytes survive until
 * tomorrow.
 */
export function removeResourceCache(resourceId: string): void {
  try {
    rmSync(cacheDir(shortId(resourceId)), { recursive: true, force: true })
  } catch (err) {
    logger.warn(
      { resourceId, err: (err as Error).message },
      "could not remove the build cache",
    )
  }
}

/**
 * Total apparent bytes under `dir`.
 *
 * Iterative over an explicit stack of directory paths rather than recursive,
 * and accumulating a number rather than collecting entries: a populated cache
 * holds tens of thousands of blobs, and building a list of them to sum would
 * put the disk's file count into a process with a 100MB ceiling. The stack only
 * ever holds directories, and BuildKit's layout has almost no directory fanout,
 * so it stays a handful of entries deep.
 *
 * withFileTypes is what makes this affordable — the Dirent carries the entry
 * type, so a plain file costs one stat for its size instead of one stat to
 * learn it is a file and another to size it.
 */
export function dirSizeBytes(dir: string, maxDepth = MAX_WALK_DEPTH): number {
  return walk(dir, maxDepth).bytes
}

/** Sizes a tree, reporting whether any part of it could not be read. A
 *  directory the sweep cannot measure counts as zero against the budget, so it
 *  would otherwise be exempt from the cap forever and silently. */
function walk(
  dir: string,
  maxDepth: number,
): { bytes: number; unreadable: boolean } {
  let total = 0
  let unreadable = false
  const stack: Array<{ path: string; depth: number }> = [{ path: dir, depth: 0 }]

  while (stack.length > 0) {
    const { path, depth } = stack.pop() as { path: string; depth: number }
    let entries: Dirent[]
    try {
      entries = readdirSync(path, { withFileTypes: true })
    } catch (err) {
      // A directory that is simply not there sizes to nothing, which is the
      // honest answer and not an anomaly — BuildKit prunes its own ingest
      // directories under the walk. Anything else (a permission error, a
      // corrupt tree) is worth a line.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        unreadable = true
        logger.warn(
          { dir: path, err: (err as Error).message },
          "could not read a build cache directory",
        )
      }
      continue
    }

    for (const entry of entries) {
      const child = resolve(path, entry.name)
      if (entry.isDirectory()) {
        if (depth < maxDepth) {
          stack.push({ path: child, depth: depth + 1 })
        } else {
          // Truncation under-reports a size the cap depends on, so it says so
          // rather than quietly returning a smaller number.
          unreadable = true
          logger.warn(
            { dir: child, maxDepth },
            "build cache tree is deeper than expected; size is under-reported",
          )
        }
        continue
      }
      if (!entry.isFile()) continue
      try {
        total += statSync(child).size
      } catch (err) {
        // Deliberately does not set `unreadable`. A blob vanishing under the
        // walk is normal churn, and the caller treats an unreadable directory
        // as filling the whole cap — so counting this would let one ordinary
        // race evict every other cache on the box. The size is a few kilobytes
        // short for one sweep, which is the harmless direction.
        logger.debug(
          { file: child, err: (err as Error).message },
          "could not size a build cache file",
        )
      }
    }
  }

  return { bytes: total, unreadable }
}

/**
 * Removes orphaned caches, then — only if the total is over the cap — evicts
 * oldest-first until under the low watermark.
 *
 * `dir`, `liveKeys` and `capGb` are parameters with defaults — the same idiom
 * the queue uses for its database handle — so the policy can be tested against
 * a temp directory without touching config or the database. The cap is a
 * parameter rather than read from config inside because config is frozen on
 * first import process-wide, so a test could otherwise only control it by being
 * the first file the runner happens to load.
 *
 * There is deliberately no check for "is this resource currently building".
 * Worker concurrency is exactly 1 and the worker awaits one handler at a time,
 * so this job cannot overlap a build at all. That makes the guarantee
 * structural rather than a check that could race.
 */
export function sweepBuildCache(
  dir: string = config.buildCacheDir,
  liveKeys: ReadonlySet<string> = new Set(
    listAllResources().map((r) => shortId(r.id)),
  ),
  capGb: number = config.buildCacheGb,
): CacheSweepResult {
  const result: CacheSweepResult = {
    orphansRemoved: 0,
    evicted: 0,
    keptBytes: 0,
  }
  if (!existsSync(dir)) return result

  const live: Array<{ path: string; mtimeMs: number }> = []

  for (const entry of readdirSync(dir)) {
    const path = resolve(dir, entry)
    try {
      const stat = statSync(path)
      if (!stat.isDirectory()) continue

      // Orphans go first and unconditionally, regardless of the cap. A cache
      // whose resource is gone can never be imported again, so it is pure
      // waste — and deleting it here means its bytes are never walked.
      if (!liveKeys.has(entry)) {
        rmSync(path, { recursive: true, force: true })
        result.orphansRemoved++
        continue
      }

      live.push({ path, mtimeMs: stat.mtimeMs })
    } catch (err) {
      // One unreadable entry must not stop the sweep: the next one may be the
      // large directory actually filling the disk. It is neither kept nor
      // evicted nor counted, so the result will not account for everything on
      // disk — which is why this logs rather than failing silently.
      logger.warn(
        { dir: path, err: (err as Error).message },
        "could not sweep a build cache directory",
      )
    }
  }

  const capBytes = capGb * 1024 * 1024 * 1024
  const targetBytes = Math.floor(capBytes * LOW_WATERMARK)

  // Newest first, so eviction takes from the tail.
  live.sort((a, b) => b.mtimeMs - a.mtimeMs)

  // Every surviving directory is sized before anything is evicted, because the
  // decision to evict at all depends on the total. An earlier version summed
  // newest-first and evicted as soon as the running total passed the low
  // watermark, which never consulted the cap: it silently turned the cap into
  // 80% of itself and deleted a lone 9GB cache under a 10GB cap, then did it
  // again the next day. Measured at 20k blobs — the shape of a real cache — a
  // full walk is ~350ms and under 1MB of heap, which is affordable on the queue
  // and is why the simpler correct version wins over the clever one.
  const sized = live.map((entry) => {
    const { bytes, unreadable } = walk(entry.path, MAX_WALK_DEPTH)
    // A directory whose tree could not be read is charged the low watermark
    // rather than its partial size: the one directory nothing can measure is
    // exactly the one that could be filling the disk, and counting it at face
    // value would exempt it from the budget permanently.
    //
    // The watermark rather than the whole cap, and `max` rather than a
    // replacement, so that two such directories cannot put the total over the
    // cap on their own and evict healthy caches to compensate for a number
    // nobody actually measured.
    const charged = unreadable ? Math.max(bytes, targetBytes) : bytes
    return { ...entry, size: charged, unreadable }
  })
  const totalBytes = sized.reduce((sum, entry) => sum + entry.size, 0)

  if (totalBytes <= capBytes) {
    result.keptBytes = totalBytes
    return result
  }

  // Over the cap: evict oldest-first down to the low watermark, not merely back
  // to the cap. Stopping at the cap would trip again on the very next build.
  //
  // A prefix cut, not a per-entry fit test. Keeping every entry that happens to
  // fit and skipping past the ones that do not is a subtly different policy: a
  // large newest cache would be dropped while two small older ones survived,
  // which is the largest-first behaviour LRU exists to avoid.
  //
  // The newest cache is exempt from the fit test, because something has to
  // survive and it is the one most likely to be built again next. Without the
  // exemption a resource whose cache alone exceeds the target takes every older
  // cache down with it — the prefix cut would start at the first entry — and the
  // box ends up with nothing cached at all.
  let kept = 0
  let evicting = false

  for (const [index, entry] of sized.entries()) {
    const fits = kept + entry.size <= targetBytes
    if (!evicting && (fits || index === 0)) {
      kept += entry.size
      continue
    }
    evicting = true

    try {
      rmSync(entry.path, { recursive: true, force: true })
      result.evicted++
    } catch (err) {
      logger.warn(
        { dir: entry.path, err: (err as Error).message },
        "could not evict a build cache directory",
      )
      // It is still on disk, so it still counts against the budget.
      kept += entry.size
      continue
    }

    // A single resource larger than the whole cap. It is still evicted — a disk
    // that fills is worse than a build that runs cold — but silently running
    // every deploy for it cold is not something an operator should have to
    // reverse-engineer.
    if (entry.size > capBytes) {
      logger.warn(
        { dir: entry.path, sizeBytes: entry.size, capGb },
        "one build cache exceeds the whole cap; every deploy for it will build cold",
      )
    }
  }

  result.keptBytes = kept
  return result
}
