---
name: sqlite-queue
description: >
  Building or changing the musdash job queue, the worker loop, or anything
  touching SQLite connections, PRAGMAs, or job claiming. Load before writing
  claim logic, retries, lease recovery, or scheduled work. Triggers on "job
  queue", "worker loop", "claim a job", "enqueue", "lease", "backoff",
  "busy_timeout", "WAL", "cron", "prune", "reconcile".
---

# The SQLite job queue

The queue is a table and one worker loop — roughly 120 lines in `src/queue/`.
Adding Redis "just for the queue" is named in `CLAUDE.md` as something that kills
this project, and is unnecessary at this scale forever.

## The invariants

**Every mutating Docker operation is a job.** No route handler calls Docker
directly — handlers enqueue and redirect immediately, so the UI never waits.
Read-only `inspect` for rendering status is the only exception.

**Concurrency is exactly 1.** Deploys spike memory during image extraction and
layer decompression; serializing them is what holds the 100MB budget. Never add a
second worker or a second long-running process.

**No cron daemon.** Scheduled work — prune, reconcile, backups — runs on this
same queue and loop.

## Connection and PRAGMAs

One write connection for the whole process. Reads may share it; `bun:sqlite` is
synchronous and contention is a non-issue at this scale. **Do not build a pool.**

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

WAL solves _reader/writer_ blocking, not _writer/writer_ contention. Simultaneous
writes from the worker and an HTTP handler are a listed trap — one connection
plus `busy_timeout` is what prevents "database is locked".

## Claiming

Poll every 1000ms. Claim atomically, so selection and update cannot interleave:

```sql
UPDATE jobs SET status='leased', leased_until=?, attempts=attempts+1
WHERE id = (SELECT id FROM jobs
            WHERE status='pending' AND run_after <= ?
            ORDER BY created_at LIMIT 1)
RETURNING *;
```

The subquery and the update are one statement, so two claimants can never both
win the same row. If you ever wrap selection and update in separate statements,
you have introduced a double-claim bug even at concurrency 1 — a restart racing
the previous process will find it.

## Leases and recovery

Lease duration 15 minutes. **On startup, reset rows where
`status='leased' AND leased_until < now` back to `pending`.** That single line is
what recovers jobs interrupted by a crash or restart.

Retry with exponential backoff — 10s, 60s, 300s. After `max_attempts`, mark the
job `failed` and set the corresponding deployment to `failed` too; a failed job
that leaves a deployment showing "running" forever is a real bug.

## Testing

Job claiming under concurrency is one of only four things in musdash with
`bun test` coverage. The test that matters: two concurrent claims must never
return the same row. Also cover the startup lease-reset path.

## Logs do not go here

**Never write logs to SQLite.** In-memory ring buffer of 1000 lines per resource
plus a rotated file under `data/logs/`. `CLAUDE.md` calls this the fastest way to
wreck both the RAM and disk profile of the product.
