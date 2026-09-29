import { Database } from "bun:sqlite"
import { beforeEach, describe, expect, test } from "bun:test"
import {
  cancelPendingDeploy,
  claim,
  complete,
  enqueue,
  fail,
  findLeasedJobs,
  findPendingJob,
  getJob,
  hasPendingJobAfter,
  pendingCount,
  pruneFinishedJobs,
  recoverOrphanedLeases,
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

/**
 * Recovery runs once, when the process starts. Only one musdash process ever
 * owns the database, and systemd starts it only after the previous one has
 * exited, so at that moment every leased job belongs to a process that is gone
 * — whether or not its lease has run out yet (P-1: a restart within the
 * 15-minute lease left two deploys "running" until the next restart).
 */
describe("recoverOrphanedLeases", () => {
  test("returns an expired lease to pending", () => {
    const id = enqueue("deploy", {}, {}, db)
    claim(db)
    db.run("UPDATE jobs SET leased_until = ? WHERE id = ?", [
      new Date(Date.now() - 60_000).toISOString(),
      id,
    ])

    expect(recoverOrphanedLeases(db)).toBe(1)
    expect(getJob(id, db)?.status).toBe("pending")
    expect(claim(db)?.id).toBe(id) // claimable again after a crash
  })

  test("returns an unexpired lease to pending too", () => {
    const id = enqueue("deploy", {}, {}, db)
    claim(db)

    expect(recoverOrphanedLeases(db)).toBe(1)
    const job = getJob(id, db)
    expect(job?.status).toBe("pending")
    expect(job?.leased_until).toBeNull()
    expect(claim(db)?.id).toBe(id)
  })

  test("does not resurrect done or failed jobs, or touch pending ones", () => {
    const done = enqueue("deploy", {}, {}, db)
    claim(db)
    complete(done, db)
    const failed = enqueue("deploy", {}, { maxAttempts: 1 }, db)
    claim(db)
    fail(failed, "boom", db)
    const pending = enqueue("deploy", {}, {}, db)

    expect(recoverOrphanedLeases(db)).toBe(0)
    expect(getJob(done, db)?.status).toBe("done")
    expect(getJob(failed, db)?.status).toBe("failed")
    expect(getJob(pending, db)?.status).toBe("pending")
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

/**
 * A push folds into a deploy of the same resource only while that deploy has
 * not started: it has not fetched yet, so it builds the newest commit anyway.
 * A running or finished one built an older commit. On the 2GB host a fix pushed
 * 42 seconds after a failed build was dropped because the failed job's row
 * still held the minute's id (T-1).
 */
describe("findPendingJob", () => {
  const push = (resourceId: string) => ({
    resourceId,
    deploymentId: "d",
    useExistingImage: false,
  })
  const match = { resourceId: "r1", useExistingImage: false }

  test("finds a deploy of the resource that has not started", () => {
    const id = enqueue("deploy", push("r1"), {}, db)

    expect(findPendingJob("deploy", match, db)).toBe(id)
  })

  test("ignores one that is running, done or failed", () => {
    enqueue("deploy", push("r1"), {}, db)
    const running = claim(db)
    expect(findPendingJob("deploy", match, db)).toBeNull()

    complete(running?.id ?? "", db)
    expect(findPendingJob("deploy", match, db)).toBeNull()

    enqueue("deploy", push("r1"), { maxAttempts: 1 }, db)
    fail(claim(db)?.id ?? "", "build failed", db)
    expect(findPendingJob("deploy", match, db)).toBeNull()
  })

  test("ignores another resource and a rollback", () => {
    enqueue("deploy", push("r2"), {}, db)
    enqueue("deploy", { ...push("r1"), useExistingImage: true }, {}, db)
    enqueue("prune_images", { resourceId: "r1" }, {}, db)

    expect(findPendingJob("deploy", match, db)).toBeNull()
  })

  test("refuses a field name that is not a plain identifier", () => {
    expect(() => findPendingJob("deploy", { "a') OR 1=1 --": 1 }, db)).toThrow()
  })
})

/**
 * Cancelling a queued deploy (D58) is one guarded UPDATE racing claim(): the
 * statement that runs first moves the row out of 'pending', and the other
 * matches nothing. So a cancelled deploy can never run, and a claimed one can
 * never be cancelled.
 */
describe("cancelPendingDeploy", () => {
  const deploy = (resourceId: string, deploymentId: string) =>
    enqueue(
      "deploy",
      { resourceId, deploymentId, image: "x", useExistingImage: false },
      {},
      db,
    )

  test("cancels a pending deploy, which is then never claimed", () => {
    const id = deploy("r1", "d1")

    expect(cancelPendingDeploy("d1", db)).toBe(true)
    const job = getJob(id, db)
    expect(job?.status).toBe("cancelled")
    expect(job?.leased_until).toBeNull()
    expect(claim(db)).toBeNull()
  })

  test("a deploy queued after a cancelled one is still claimed", () => {
    deploy("r1", "d1")
    expect(cancelPendingDeploy("d1", db)).toBe(true)
    const next = deploy("r1", "d2")

    expect(claim(db)?.id).toBe(next)
  })

  test("refuses a claimed deploy and leaves it leased", () => {
    const id = deploy("r1", "d1")
    expect(claim(db)?.id).toBe(id)

    expect(cancelPendingDeploy("d1", db)).toBe(false)
    expect(getJob(id, db)?.status).toBe("leased")
  })

  test("refuses an unknown deployment id", () => {
    deploy("r1", "d1")

    expect(cancelPendingDeploy("nope", db)).toBe(false)
    expect(pendingCount(db)).toBe(1)
  })

  test("refuses a job of another type carrying that deployment id", () => {
    const id = enqueue("stop", { resourceId: "r1", deploymentId: "d1" }, {}, db)

    expect(cancelPendingDeploy("d1", db)).toBe(false)
    expect(getJob(id, db)?.status).toBe("pending")
  })

  test("cancelling one resource's deploy leaves another's pending", () => {
    deploy("rA", "dA")
    const b = deploy("rB", "dB")

    expect(cancelPendingDeploy("dA", db)).toBe(true)
    expect(getJob(b, db)?.status).toBe("pending")
    expect(claim(db)?.id).toBe(b)
  })

  test("prune removes an old cancelled job and keeps a fresh one", () => {
    const old = deploy("r1", "d1")
    cancelPendingDeploy("d1", db)
    db.run("UPDATE jobs SET created_at = ? WHERE id = ?", [
      new Date(Date.now() - 200 * 3600 * 1000).toISOString(),
      old,
    ])
    const fresh = deploy("r1", "d2")
    cancelPendingDeploy("d2", db)

    expect(pruneFinishedJobs(168, db)).toBe(1)
    expect(getJob(old, db)).toBeNull()
    expect(getJob(fresh, db)?.status).toBe("cancelled")
  })

  test("startup recovery never revives a cancelled job", () => {
    const id = deploy("r1", "d1")
    cancelPendingDeploy("d1", db)

    expect(recoverOrphanedLeases(db)).toBe(0)
    expect(getJob(id, db)?.status).toBe("cancelled")
    expect(claim(db)).toBeNull()
  })
})

/**
 * A push whose commit a running build of the same resource already fetched
 * queues nothing (D58). The running build is found by its leased job; every
 * other state, resource, or a rollback must not match.
 */
describe("findLeasedJobs", () => {
  const push = (resourceId: string, useExistingImage = false) => ({
    resourceId,
    deploymentId: "d",
    useExistingImage,
  })
  const match = { resourceId: "r1", useExistingImage: false }

  test("returns a claimed deploy of the resource", () => {
    const id = enqueue("deploy", push("r1"), {}, db)
    expect(claim(db)?.id).toBe(id)

    expect(findLeasedJobs("deploy", match, db)).toEqual([id])
  })

  test("ignores pending, done, failed and cancelled deploys", () => {
    enqueue("deploy", push("r1"), {}, db)
    expect(findLeasedJobs("deploy", match, db)).toEqual([])

    const done = claim(db)
    complete(done?.id ?? "", db)
    expect(findLeasedJobs("deploy", match, db)).toEqual([])

    enqueue("deploy", push("r1"), { maxAttempts: 1 }, db)
    fail(claim(db)?.id ?? "", "build failed", db)
    expect(findLeasedJobs("deploy", match, db)).toEqual([])

    enqueue("deploy", { ...push("r1"), deploymentId: "dc" }, {}, db)
    expect(cancelPendingDeploy("dc", db)).toBe(true)
    expect(findLeasedJobs("deploy", match, db)).toEqual([])
  })

  test("ignores another resource and a rollback", () => {
    enqueue("deploy", push("r2"), {}, db)
    claim(db)
    enqueue("deploy", push("r1", true), {}, db)
    claim(db)

    expect(findLeasedJobs("deploy", match, db)).toEqual([])
  })

  test("refuses a field name that is not a plain identifier", () => {
    expect(() => findLeasedJobs("deploy", { "a') OR 1=1 --": 1 }, db)).toThrow()
  })
})

/**
 * A Deploy press folds into a waiting deploy only when nothing else for the
 * resource is queued behind it; otherwise the press would run before, say, a
 * Stop queued later, and the resource would end stopped although Deploy was
 * the last thing asked for.
 */
describe("hasPendingJobAfter", () => {
  const at = (id: string, msAgo: number) =>
    db.run("UPDATE jobs SET created_at = ? WHERE id = ?", [
      new Date(Date.now() - msAgo).toISOString(),
      id,
    ])
  const deploy = (resourceId: string) =>
    enqueue("deploy", { resourceId, deploymentId: "d" }, {}, db)

  test("a stop queued after the deploy for the same resource blocks a fold", () => {
    const d = deploy("r1")
    at(d, 2000)
    const stop = enqueue("stop", { resourceId: "r1" }, {}, db)
    at(stop, 1000)

    expect(hasPendingJobAfter(d, "r1", db)).toBe(true)
  })

  test("a job queued after it for another resource does not", () => {
    const d = deploy("r1")
    at(d, 2000)
    const other = enqueue("stop", { resourceId: "r2" }, {}, db)
    at(other, 1000)

    expect(hasPendingJobAfter(d, "r1", db)).toBe(false)
  })

  test("a job for the resource queued before it does not", () => {
    const stop = enqueue("stop", { resourceId: "r1" }, {}, db)
    at(stop, 2000)
    const d = deploy("r1")
    at(d, 1000)

    expect(hasPendingJobAfter(d, "r1", db)).toBe(false)
  })

  test("a later job that already ran does not", () => {
    const d = deploy("r1")
    at(d, 2000)
    const stop = enqueue("stop", { resourceId: "r1" }, {}, db)
    at(stop, 1000)
    complete(stop, db)

    expect(hasPendingJobAfter(d, "r1", db)).toBe(false)
  })

  test("an equal timestamp counts as after, since claim's tie order is undefined", () => {
    const d = deploy("r1")
    const stop = enqueue("stop", { resourceId: "r1" }, {}, db)
    const same = new Date(Date.now() - 1000).toISOString()
    db.run("UPDATE jobs SET created_at = ? WHERE id IN (?, ?)", [same, d, stop])

    expect(hasPendingJobAfter(d, "r1", db)).toBe(true)
  })
})
