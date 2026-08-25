import type { Database } from "bun:sqlite"
import { db as defaultDb } from "../db/index.ts"
import type { Job, JobType } from "../db/schema.ts"
import { nowIso, ulid } from "../ids.ts"

/**
 * A SQLite-backed job queue: one table, one worker loop, roughly 120 lines.
 * Every mutating Docker operation goes through here so HTTP handlers never
 * block on Docker and an interrupted deploy is recoverable after a restart.
 */

/** 15 minutes. Long enough for a slow image pull, short enough to recover. */
export const LEASE_MS = 15 * 60 * 1000

/** PHASES.md §8: 10s, 60s, 300s, then the job is failed. */
const BACKOFF_SEC = [10, 60, 300]

export interface JobRow {
  id: string
  type: JobType
  payload_json: string
  status: Job["status"]
  attempts: number
  max_attempts: number
  run_after: string
  leased_until: string | null
  last_error: string | null
  created_at: string
}

export interface EnqueueOptions {
  runAfter?: Date
  maxAttempts?: number
  id?: string
}

export function enqueue(
  type: JobType,
  payload: Record<string, unknown>,
  opts: EnqueueOptions = {},
  database: Database = defaultDb,
): string {
  const id = opts.id ?? ulid()
  database.run(
    `INSERT INTO jobs (id, type, payload_json, status, attempts, max_attempts, run_after, created_at)
     VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)`,
    [
      id,
      type,
      JSON.stringify(payload),
      opts.maxAttempts ?? 3,
      (opts.runAfter ?? new Date()).toISOString(),
      nowIso(),
    ],
  )
  return id
}

/**
 * Claims the oldest runnable job, atomically.
 *
 * The UPDATE ... WHERE id = (SELECT ...) RETURNING form is deliberate and must
 * not be split into a SELECT followed by an UPDATE. Even at concurrency 1 a
 * restarting process can overlap the previous one, and two statements let both
 * read the same row before either writes it. One statement makes that
 * impossible.
 */
export function claim(database: Database = defaultDb): JobRow | null {
  const now = new Date()
  const leaseUntil = new Date(now.getTime() + LEASE_MS).toISOString()

  const rows = database
    .query<JobRow, [string, string]>(
      `UPDATE jobs
         SET status = 'leased', leased_until = ?, attempts = attempts + 1
       WHERE id = (
         SELECT id FROM jobs
          WHERE status = 'pending' AND run_after <= ?
          ORDER BY created_at
          LIMIT 1
       )
       RETURNING *`,
    )
    .all(leaseUntil, now.toISOString())

  return rows[0] ?? null
}

export function complete(id: string, database: Database = defaultDb): void {
  database.run(
    "UPDATE jobs SET status = 'done', leased_until = NULL WHERE id = ?",
    [id],
  )
}

export interface FailResult {
  retrying: boolean
  attempts: number
}

/**
 * Records a failure. Retries with backoff until max_attempts, then marks the
 * job failed for good — the caller is responsible for propagating that to the
 * deployment row, because a job that dies while its deployment still says
 * "running" is a bug users see.
 */
export function fail(
  id: string,
  error: string,
  database: Database = defaultDb,
): FailResult {
  const row = database
    .query<{ attempts: number; max_attempts: number }, [string]>(
      "SELECT attempts, max_attempts FROM jobs WHERE id = ?",
    )
    .get(id)

  if (!row) return { retrying: false, attempts: 0 }

  if (row.attempts >= row.max_attempts) {
    database.run(
      "UPDATE jobs SET status = 'failed', last_error = ?, leased_until = NULL WHERE id = ?",
      [error, id],
    )
    return { retrying: false, attempts: row.attempts }
  }

  const idx = Math.min(row.attempts - 1, BACKOFF_SEC.length - 1)
  const delaySec = BACKOFF_SEC[Math.max(0, idx)] as number
  const runAfter = new Date(Date.now() + delaySec * 1000).toISOString()
  database.run(
    `UPDATE jobs SET status = 'pending', run_after = ?, last_error = ?, leased_until = NULL
      WHERE id = ?`,
    [runAfter, error, id],
  )
  return { retrying: true, attempts: row.attempts }
}

/**
 * Returns expired leases to the pending pool. Run once at startup: this single
 * statement is what makes a job survive a crash or a restart mid-deploy.
 */
export function recoverExpiredLeases(database: Database = defaultDb): number {
  const res = database.run(
    `UPDATE jobs SET status = 'pending', leased_until = NULL
      WHERE status = 'leased' AND leased_until < ?`,
    [nowIso()],
  )
  return res.changes
}

export function pendingCount(database: Database = defaultDb): number {
  return (
    database
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending'",
      )
      .get()?.n ?? 0
  )
}

/**
 * Jobs that are queued or in flight.
 *
 * Distinct from pendingCount(), which counts only 'pending'. A deploy the
 * worker has already claimed is 'leased', and that is precisely the state that
 * makes a restart unsafe — so the restart guard needs both.
 */
export function activeJobCount(database: Database = defaultDb): number {
  return (
    database
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM jobs WHERE status IN ('pending', 'leased')",
      )
      .get()?.n ?? 0
  )
}

export function getJob(
  id: string,
  database: Database = defaultDb,
): JobRow | null {
  return (
    database
      .query<JobRow, [string]>("SELECT * FROM jobs WHERE id = ?")
      .get(id) ?? null
  )
}

/** Removes finished jobs so the table does not grow without bound. */
export function pruneFinishedJobs(
  olderThanHours = 168,
  database: Database = defaultDb,
): number {
  const cutoff = new Date(
    Date.now() - olderThanHours * 3600 * 1000,
  ).toISOString()
  return database.run(
    "DELETE FROM jobs WHERE status IN ('done','failed') AND created_at < ?",
    [cutoff],
  ).changes
}
