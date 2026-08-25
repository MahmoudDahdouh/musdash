import { purgeExpiredSessions } from "./auth.ts"
import { sweepBuildDirs } from "./build/workdir.ts"
import { logger } from "./log.ts"
import { enqueue, pruneFinishedJobs } from "./queue/index.ts"

/**
 * Periodic housekeeping on the existing loop — no cron daemon and no second
 * process, per the single-process invariant. Docker-touching work is enqueued
 * as a job rather than performed here, so it still runs through the one worker.
 */

const DAY_MS = 24 * 60 * 60 * 1000
let timer: Timer | null = null

function runDaily(): void {
  // Image pruning is Docker work, so it goes on the queue.
  enqueue("prune_images", { olderThanHours: 168 })
  // Filesystem work, but it still goes on the queue — the distinction below is
  // cost, not Docker. Sweeping the layer cache walks tens of thousands of blobs
  // synchronously, which would block the event loop and stall the dashboard if
  // it ran here. On the queue it also cannot overlap a build, so it can never
  // evict a cache that is being written.
  enqueue("prune_build_cache", {})

  const jobs = pruneFinishedJobs(168)
  const sessions = purgeExpiredSessions()
  // Cheap filesystem work — one readdir over a handful of entries — so it runs
  // here rather than on the queue. The backstop for a build that was SIGKILLed
  // before its own cleanup could run.
  const buildDirs = sweepBuildDirs(24)
  logger.info(
    { prunedJobs: jobs, prunedSessions: sessions, sweptBuildDirs: buildDirs },
    "daily housekeeping",
  )
}

export function startScheduler(): void {
  if (timer) return
  // Wait a minute after boot so startup is not competing with a prune.
  setTimeout(() => runDaily(), 60_000)
  timer = setInterval(() => runDaily(), DAY_MS)
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer)
  timer = null
}
