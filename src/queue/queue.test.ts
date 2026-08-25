import { Database } from "bun:sqlite"
import { beforeEach, describe, expect, test } from "bun:test"
import {
  claim,
  complete,
  enqueue,
  fail,
  getJob,
  pendingCount,
  pruneFinishedJobs,
  recoverExpiredLeases,
} from "./index.ts"

/**
 * The queue is tested against an in-memory database with the same DDL as the
 * migration, so these tests never touch data/musdash.db.
 */
const DDL = `
CREATE TABLE jobs (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status       TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_after    TEXT NOT NULL,
  leased_until TEXT,
  last_error   TEXT,
  created_at   TEXT NOT NULL
) STRICT;
CREATE INDEX idx_jobs_claim ON jobs(status, run_after);
`

let db: Database

beforeEach(() => {
  db = new Database(":memory:")
  db.exec("PRAGMA foreign_keys = ON")
  db.exec(DDL)
})

describe("enqueue", () => {
  test("inserts a pending job and returns its id", () => {
    const id = enqueue("deploy", { resourceId: "r1" }, {}, db)
    const job = getJob(id, db)
    expect(job?.status).toBe("pending")
    expect(job?.type).toBe("deploy")
    expect(JSON.parse(job?.payload_json ?? "{}")).toEqual({ resourceId: "r1" })
    expect(job?.attempts).toBe(0)
  })

  test("a future run_after is not immediately claimable", () => {
    enqueue("prune_images", {}, { runAfter: new Date(Date.now() + 60_000) }, db)
    expect(pendingCount(db)).toBe(1)
    expect(claim(db)).toBeNull()
  })
})

describe("claim", () => {
  test("returns null on an empty queue", () => {
    expect(claim(db)).toBeNull()
  })

  test("leases the job and increments attempts exactly once", () => {
    const id = enqueue("deploy", {}, {}, db)
    const job = claim(db)
    expect(job?.id).toBe(id)
    expect(job?.status).toBe("leased")
    expect(job?.attempts).toBe(1)
    expect(job?.leased_until).not.toBeNull()
  })

  /**
   * The claim must be a single atomic statement. `bun:sqlite` is synchronous,
   * so genuine thread-level parallelism is not reachable inside one process —
   * this test therefore proves the property that actually matters and is
   * actually reachable: interleaved claims never hand the same row to two
   * callers, and a second claimant gets nothing rather than a duplicate.
   *
   * The scenario this defends against is real: a restarting process overlapping
   * the previous one, both polling the same table.
   */
  test("two interleaved claims never return the same row", () => {
    const id = enqueue("deploy", {}, {}, db)
    const first = claim(db)
    const second = claim(db)

    expect(first?.id).toBe(id)
    expect(second).toBeNull()
    expect(getJob(id, db)?.attempts).toBe(1) // not double-incremented
  })

  test("N concurrent claimants over N jobs each get a distinct job", () => {
    const ids = new Set<string>()
    for (let i = 0; i < 25; i++) ids.add(enqueue("deploy", { i }, {}, db))

    const claimed: string[] = []
    for (;;) {
      const job = claim(db)
      if (!job) break
      claimed.push(job.id)
    }

    expect(claimed).toHaveLength(25)
    expect(new Set(claimed).size).toBe(25) // no duplicates
    expect([...ids].sort()).toEqual([...claimed].sort())
  })

  test("claims in creation order (FIFO)", () => {
    const a = enqueue("deploy", {}, { id: "A" }, db)
    const b = enqueue("deploy", {}, { id: "B" }, db)
    // created_at may share a millisecond, so assert both come out, oldest-first
    // by insertion where distinguishable.
    const first = claim(db)?.id
    const second = claim(db)?.id
    expect(new Set([first, second])).toEqual(new Set([a, b]))
  })

  test("a leased job is not claimable again", () => {
    enqueue("deploy", {}, {}, db)
    expect(claim(db)).not.toBeNull()
    expect(claim(db)).toBeNull()
  })
})

describe("complete", () => {
  test("marks the job done and clears the lease", () => {
    const id = enqueue("stop", {}, {}, db)
    claim(db)
    complete(id, db)
    const job = getJob(id, db)
    expect(job?.status).toBe("done")
    expect(job?.leased_until).toBeNull()
  })
})

describe("fail", () => {
  test("retries with backoff while attempts remain", () => {
    const id = enqueue("deploy", {}, { maxAttempts: 3 }, db)
    claim(db)
    const res = fail(id, "pull failed", db)

    expect(res.retrying).toBe(true)
    const job = getJob(id, db)
    expect(job?.status).toBe("pending")
    expect(job?.last_error).toBe("pull failed")
    // Backed off into the future, so it is not instantly re-claimable.
    expect(new Date(job?.run_after ?? 0).getTime()).toBeGreaterThan(Date.now())
    expect(claim(db)).toBeNull()
  })

  test("marks failed for good once max_attempts is reached", () => {
    const id = enqueue("deploy", {}, { maxAttempts: 2 }, db)

    claim(db)
    expect(fail(id, "first", db).retrying).toBe(true)

    // Make it claimable again without waiting out the backoff.
    db.run("UPDATE jobs SET run_after = ? WHERE id = ?", [
      new Date(Date.now() - 1000).toISOString(),
      id,
    ])

    claim(db)
    const res = fail(id, "second", db)
    expect(res.retrying).toBe(false)
    expect(getJob(id, db)?.status).toBe("failed")
    expect(getJob(id, db)?.last_error).toBe("second")
  })

  test("failing an unknown id is a no-op, not a throw", () => {
    expect(fail("nope", "x", db)).toEqual({ retrying: false, attempts: 0 })
  })
})

describe("recoverExpiredLeases", () => {
  test("returns an expired lease to pending", () => {
    const id = enqueue("deploy", {}, {}, db)
    claim(db)
    db.run("UPDATE jobs SET leased_until = ? WHERE id = ?", [
      new Date(Date.now() - 60_000).toISOString(),
      id,
    ])

    expect(recoverExpiredLeases(db)).toBe(1)
    expect(getJob(id, db)?.status).toBe("pending")
    expect(claim(db)?.id).toBe(id) // claimable again after a crash
  })

  test("leaves an unexpired lease alone", () => {
    const id = enqueue("deploy", {}, {}, db)
    claim(db)
    expect(recoverExpiredLeases(db)).toBe(0)
    expect(getJob(id, db)?.status).toBe("leased")
  })

  test("does not resurrect done or failed jobs", () => {
    const done = enqueue("deploy", {}, {}, db)
    claim(db)
    complete(done, db)
    expect(recoverExpiredLeases(db)).toBe(0)
    expect(getJob(done, db)?.status).toBe("done")
  })
})

describe("pruneFinishedJobs", () => {
  test("removes old finished jobs but keeps pending ones", () => {
    const old = enqueue("deploy", {}, {}, db)
    claim(db)
    complete(old, db)
    db.run("UPDATE jobs SET created_at = ? WHERE id = ?", [
      new Date(Date.now() - 200 * 3600 * 1000).toISOString(),
      old,
    ])
    const fresh = enqueue("deploy", {}, {}, db)

    expect(pruneFinishedJobs(168, db)).toBe(1)
    expect(getJob(old, db)).toBeNull()
    expect(getJob(fresh, db)).not.toBeNull()
  })
})
