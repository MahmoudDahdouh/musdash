---
name: rss-budget
description: >
  Adding a dependency, changing the release build, measuring idle RSS, or
  reviewing anything that could raise memory. Load before running `bun add`, and
  before any change that retains data in memory. Triggers on "add a dependency",
  "RSS", "memory budget", "100MB", "release build", "bun build --compile",
  "idle memory", "ring buffer", "disk usage", "prune".
---

# The 100MB budget

## Why this is not an optimization

musdash's differentiating promise is that the control plane idles at or below
**100MB RSS**, doing as a single process what Coolify needs 750MB–1.2GB for. It
is a hard product requirement. A design that adds a second long-running process,
a database server, or a client-side rendering runtime is out of scope by
definition, no matter how much users want the feature it would enable.

Without a CI gate the number drifts silently and the product loses its reason to
exist. **The ceiling does not move to accommodate a new component** without an
explicit, justified decision recorded in `docs/DECISIONS.md`.

## Measurement is part of the build

```json
"scripts": {
  "build": "bun build --compile --minify src/index.ts --outfile dist/musdash",
  "rss":   "ps -o rss= -p $(pgrep -f dist/musdash) | awk '{print $1/1024 \" MB\"}'"
}
```

Every release build boots the binary, idles 60 seconds, measures RSS, and
**fails the build above 100MB**. `--compile --minify` moves parsing and
transpiling cost from runtime to build time; `--bytecode` moves it further for
faster startup at the cost of a slower build.

Record idle RSS in `README.md` and re-measure after any dependency addition.

## Before adding a dependency

**Measure idle RSS before and after.** That is the rule, not a suggestion.

Some things are forbidden outright and no measurement changes that: Prisma
(ships a large Rust query engine), Redis-backed queues like BullMQ, Socket.io
(SSE is enough), Express, Tailwind/PostCSS/Sass (require a build step), and any
node-gyp native module (breaks single-binary compilation). Also never the full
AWS SDK — use a small client or plain signed `fetch` for S3-compatible storage.

There is no SQLite package; it is built into the runtime.

## What holds the budget

- **Job concurrency exactly 1.** Deploys spike memory during image extraction
  and layer decompression; the control plane must not multiply that.
- **Logs to ring buffer plus file, never SQLite** — 1000 lines per resource,
  appended to `data/logs/<resourceId>.log`, rotated at 10MB keeping 2 files.
- **A hard memory limit on every container** — default 512MB.
- SQLite WAL with a single writer. No pool.
- Shelling out to `docker compose`, `git`, `railpack` costs _transient_ memory,
  not resident. This is why it is the correct trade.

## Sidecars are reported honestly

Caddy (~50MB) and BuildKit (idle ~30MB) are containers musdash manages. Report
them **separately but always** — never quote a number that excludes something
the user will actually be running.

## If idle RSS drifts upward

Investigate the log ring buffer and any retained streams **before** blaming the
runtime. An SSE connection or log stream that is never released is the usual
cause.

## Disk is the other budget

**Disk exhaustion kills more self-hosted servers than RAM does**, and neglecting
it generates more support load than any other single issue.

- A daily `prune_images` job removes dangling images and images unused beyond
  168 hours. Surface reclaimed bytes in the UI.
- **Delete `data/builds/<deploymentId>/` when a build finishes, success or
  failure** — build directories are the second-largest leak after images.
- Cap the BuildKit cache (default 10GB) and surface its usage alongside images.

## The compile trap

`bun build --compile` drops dynamically-imported files. Templates and assets must
be embedded via `--asset` or imported statically, or **they vanish in the
binary** — and the failure shows up only in the compiled artifact, never in
`bun run dev`.
