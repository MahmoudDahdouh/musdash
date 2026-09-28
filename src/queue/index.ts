import type { Database } from "bun:sqlite"
import { db as defaultDb } from "../db/index.ts"
import type { Job, JobType } from "../db/schema.ts"
import { nowIso, ulid } from "../ids.ts"

/**
 * A SQLite-backed job queue: one table, one worker loop, roughly 120 lines.
 * Every mutating Docker operation goes through here so HTTP handlers never
 * block on Docker and an interrupted deploy is recoverable after a restart.
 */

/**
 * 15 minutes. Written to leased_until on every claim, and read by nothing since
 * recovery stopped comparing against it: every lease at startup is orphaned
 * (see recoverOrphanedLeases). Kept because the column is in the schema.
 */
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
 * not be split into a SELECT followed by an UPDATE: two statements let two
 * claimants read the same row before either writes it. musdash runs one
 * claimant — one process, one worker loop — but one statement makes the claim
 * correct without relying on that.
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
 * Returns every leased job to the pending pool. Run once at startup: this single
 * statement is what makes a job survive a crash or a restart mid-deploy.
 *
 * Every lease, not only expired ones. At startup no job can legitimately be
 * leased: one process owns the database, and systemd starts it only after the
 * previous one has exited — as does the dashboard's restart, which exits first.
 * Checking leased_until instead skipped any job whose owner died within the
 * last LEASE_MS, and since this runs only once, nothing ever came back for it:
 * a reboot followed by an upgrade left two deploys "running" indefinitely (P-1).
 * Running a second musdash by hand on the same data directory would have this
 * re-run the first one's job; that is not a supported setup.
 */
export function recoverOrphanedLeases(database: Database = defaultDb): number {
  const res = database.run(
    `UPDATE jobs SET status = 'pending', leased_until = NULL
      WHERE status = 'leased'`,
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

/**
 * The oldest job of this type that has not started and whose payload holds
 * each of these fields, or null.
 *
 * Only 'pending': a job the worker has claimed has already acted on its input,
 * so folding new work into it would lose that work (T-1). Field names are
 * spliced into a JSON path, so anything but a plain identifier is refused; a
 * boolean is compared as the 0 or 1 json_extract returns for it.
 */
export function findPendingJob(
  type: JobType,
  fields: Record<string, string | number | boolean>,
  database: Database = defaultDb,
): string | null {
  const where: string[] = []
  const values: (string | number)[] = []
  for (const [key, value] of Object.entries(fields)) {
    if (!/^[A-Za-z]+$/.test(key)) {
      throw new Error(`findPendingJob: invalid payload field "${key}"`)
    }
    where.push(`json_extract(payload_json, '$.${key}') = ?`)
    values.push(typeof value === "boolean" ? Number(value) : value)
  }
  const row = database
    .query<{ id: string }, (string | number)[]>(
      `SELECT id FROM jobs WHERE type = ? AND status = 'pending'${where.map((w) => ` AND ${w}`).join("")} ORDER BY created_at LIMIT 1`,
    )
    .get(type, ...values)
  return row?.id ?? null
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
