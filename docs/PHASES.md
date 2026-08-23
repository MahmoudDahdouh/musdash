# mosdash — Full Build Specification

> **For the implementing agent:** this document specifies the entire project.
>
> **Part I** is the Phase 1 implementation spec — build exactly this, nothing
> more. Section 2 (Non-Goals) is as binding as Section 3 (Features). Section 16
> defines "done".
>
> **Part II** is the roadmap for Phases 2–5, which reach Coolify feature parity.
> **Do not implement anything from Part II until Phase 1 passes its Definition
> of Done.** Each phase has its own DoD. Ship at the end of every phase.
>
> Section 24 (Architectural invariants) governs every phase, including Phase 1.
> A feature that violates one is redesigned or dropped, regardless of demand.

## Contents

**Part I — Phase 1 specification** · §1 What mosdash is · §2 Non-goals · §3 Scope
· §4 Technology · §5 The spike · §6 Docker client · §7 Data model · §8 Queue
· §9 Deploy pipeline · §10 Caddy · §11 UI · §12 Security · §13 Resource
discipline · §14 Reconciler · §15 Testing · §16 Definition of done
· §17 Repo layout · §18 Configuration · §19 Implementation order
· §20 Conventions · §21 Known traps

**Part II — Phases 2–5** · §22 Product thesis · §23 Competitive assessment
· §24 Architectural invariants · §25 Feature inventory · §26 Phase 2 GitHub
· §27 Phase 3 Compose & templates · §28 Phase 4 Databases & backups
· §29 Phase 5 Multi-server & previews · §30 RAM budget · §31 Release strategy
· §32 What kills this project

---

# Part I — Phase 1 Specification

## 1. What mosdash is

A self-hosted PaaS. A user points it at their own VPS, and it deploys and runs
their applications in Docker containers, each reachable at an HTTPS URL.

It is a Coolify alternative with one differentiating promise:

> **Your $5 VPS runs your apps, not your dashboard.**

Coolify's control plane consumes 750MB–1.2GB of RAM before deploying anything
(a PHP app, its own PostgreSQL, Redis, a WebSocket server, and queue workers).
mosdash does the same job as a single process holding a SQLite file.

**The RAM budget is a hard product requirement, not an optimization.** Any
proposed design that adds a second long-running process, a database server, or
a client-side rendering runtime is out of scope by definition. See Section 13.

---

## 2. Non-goals for Phase 1

Do **not** implement these. They are planned for later phases. If a task seems
to require one, stop and note it rather than building it.

| Excluded                                            | Phase |
| --------------------------------------------------- | ----- |
| GitHub App integration, webhooks, git-based deploys | 2     |
| Railpack / Nixpacks / buildpack source builds       | 2     |
| Building images from a Dockerfile                   | 2     |
| Docker Compose support                              | 3     |
| One-click service templates                         | 3     |
| Managed databases, backups, restores                | 4     |
| Multi-server / remote Docker hosts                  | 4     |
| Multi-user accounts, teams, RBAC, invitations       | later |
| Preview environments per pull request               | later |
| Metrics, graphs, alerting, notifications            | later |
| Terminal / exec-into-container                      | later |
| A REST API intended for third-party consumers       | later |

Also explicitly excluded from Phase 1:

- **No test suite beyond Section 15.** Do not scaffold broad unit test coverage.
- **No Docker Swarm, no Kubernetes, no orchestrator.** Plain Docker only.
- **No client-side router or SPA framework.** See Section 11.
- **No CSS framework requiring a build step.** No Tailwind, no PostCSS pipeline.
- **No ORM code generation or migration DSL beyond Drizzle's basics.**

---

## 3. Phase 1 scope

At the end of Phase 1, a user can:

1. Install mosdash on a fresh Ubuntu VPS with a single command.
2. Log in with an admin account created on first run.
3. Create a **project**, which contains **environments** (e.g. production, staging).
4. Add a **resource** to an environment by specifying a public Docker image
   (e.g. `nginx:alpine`, `ghcr.io/user/app:v1.2`).
5. Set environment variables on that resource, stored encrypted at rest.
6. Deploy it. The image is pulled, a container starts, and health is verified.
7. Watch build/deploy progress and container logs stream live in the browser.
8. Reach the running app over HTTPS at an auto-generated subdomain, with a
   certificate obtained automatically.
9. Stop, restart, redeploy, and roll back to the previous image.
10. Delete a resource, which removes its container, its route, and its volumes.

That is the whole of Phase 1. It is a coherent, shippable product.

---

## 4. Technology decisions (do not substitute)

| Concern          | Choice                                              | Rationale                                                             |
| ---------------- | --------------------------------------------------- | --------------------------------------------------------------------- |
| Runtime          | **Bun** (latest stable)                             | Single-binary compile, ~25–40% lower RSS than Node, native TypeScript |
| HTTP framework   | **Elysia**                                          | Bun-native, minimal overhead, good TS inference                       |
| Database         | **`bun:sqlite`**                                    | Built into the runtime. Zero native modules, zero install friction    |
| Query builder    | **Drizzle ORM** (`drizzle-orm/bun-sqlite`)          | Thin, no runtime engine, no codegen daemon                            |
| Templating       | **Eta**                                             | EJS-compatible syntax, faster, ~2kb                                   |
| Client JS        | **Alpine.js** via local file                        | No build step, 14kb                                                   |
| CSS              | **Handwritten, single file, CSS custom properties** | No build step                                                         |
| Docker access    | See Section 6                                       | Decided by the spike                                                  |
| Reverse proxy    | **Caddy** (separate container, managed by us)       | Automatic HTTPS, JSON admin API                                       |
| Secrets          | `node:crypto` AES-256-GCM                           | Available in Bun                                                      |
| Password hashing | `Bun.password` (argon2id)                           | Built in                                                              |
| Logging          | `pino`                                              | Structured, low overhead                                              |
| Validation       | `zod`                                               | Route input validation                                                |

### Explicitly forbidden dependencies

- **Prisma** — ships a large Rust query engine binary
- **BullMQ, Bee-Queue, Agenda** — all require Redis
- **Socket.io** — SSE is sufficient and native
- **Express** — Elysia is the choice here; do not mix
- **Tailwind, PostCSS, Sass** — require a build step
- **Any `node-gyp` native module** — breaks single-binary compilation

```bash
bun add elysia @elysiajs/html @elysiajs/cookie @elysiajs/static \
        drizzle-orm eta zod pino
bun add -d drizzle-kit @types/bun
```

Note there is no SQLite package. `bun:sqlite` is built in.

---

## 5. Step zero — the spike (do this before anything else)

The riskiest assumption in this project is whether Docker API access works
cleanly under Bun. Verify it before building architecture on top of it.

Write a single throwaway file `spike.ts` that performs, in order:

1. `GET /version` on the Docker socket — proves connectivity.
2. Pull `nginx:alpine` — proves streaming _response_ handling.
3. Create and start a container from it.
4. **Attach to the container's log stream and print it to stdout.**
5. Stop and remove the container.

**Step 4 is the actual test.** Docker's log stream is multiplexed: each frame
carries an 8-byte header before its payload. Libraries that handle this
(`dockerode`) rely on Node stream internals that Bun may not fully implement.

Run the spike two ways:

**Option A — `dockerode`.** If log streaming works, use it.

**Option B — raw `fetch` over the unix socket.** Bun supports this natively:

```ts
await fetch("http://localhost/v1.44/version", { unix: "/var/run/docker.sock" })
```

The Docker Engine API is plain HTTP + JSON. Option B is roughly 200 lines and
carries zero dependencies. **If both work, prefer Option B** — it removes a
dependency, keeps the binary smaller, and eliminates a Bun-compatibility risk
for the rest of the project's life.

Record the outcome in `docs/DECISIONS.md` with a one-paragraph rationale.

---

## 6. The Docker client abstraction

Regardless of the spike outcome, **all Docker access goes through one module**
with this interface. Nothing else in the codebase imports `dockerode` or calls
`fetch` against the socket.

```ts
// src/docker/client.ts

export interface DockerClient {
  ping(): Promise<boolean>
  version(): Promise<{ version: string; apiVersion: string }>

  pullImage(ref: string, onProgress: (line: string) => void): Promise<void>
  imageExists(ref: string): Promise<boolean>
  removeImage(ref: string, force?: boolean): Promise<void>

  createContainer(spec: ContainerSpec): Promise<string> // returns id
  startContainer(id: string): Promise<void>
  stopContainer(id: string, timeoutSec?: number): Promise<void>
  removeContainer(id: string, force?: boolean): Promise<void>
  inspectContainer(id: string): Promise<ContainerState>
  listManagedContainers(): Promise<ManagedContainer[]>

  streamLogs(id: string, opts: LogOpts): AsyncIterable<LogLine>

  ensureNetwork(name: string): Promise<void>
  createVolume(name: string): Promise<void>
  removeVolume(name: string): Promise<void>
  pruneImages(olderThanHours: number): Promise<{ reclaimedBytes: number }>
}

export interface ContainerSpec {
  name: string // mosdash-<resourceId>
  image: string
  env: Record<string, string>
  labels: Record<string, string> // must include mosdash.* labels
  networks: string[]
  volumes: { name: string; mountPath: string }[]
  memoryLimitBytes: number // REQUIRED — never unlimited
  cpuShares?: number
  restartPolicy: "unless-stopped" | "no"
  healthcheck?: {
    test: string[]
    intervalSec: number
    timeoutSec: number
    retries: number
    startPeriodSec: number
  }
}

export interface ContainerState {
  id: string
  running: boolean
  health: "healthy" | "unhealthy" | "starting" | "none"
  exitCode: number | null
  startedAt: string | null
  restartCount: number
}

export interface LogLine {
  stream: "stdout" | "stderr"
  timestamp: string
  text: string
}

export interface LogOpts {
  follow: boolean
  tail: number
  since?: number // unix seconds
}
```

### Log stream demultiplexing (implement carefully)

When `TTY` is disabled (which it must be), Docker frames each chunk:

```
byte 0     : stream type — 0 stdin, 1 stdout, 2 stderr
bytes 1-3  : zero padding
bytes 4-7  : payload length, big-endian uint32
bytes 8..n : payload
```

Frames may split across network chunks. Buffer partial frames; never assume one
chunk equals one frame. This is the single most common bug in this layer.

### Required container labels

Every container mosdash creates carries these. The reconciler depends on them.

```
mosdash.managed        = "true"
mosdash.resource_id    = <resource id>
mosdash.deployment_id  = <deployment id>
mosdash.project_id     = <project id>
```

---

## 7. Data model

SQLite via Drizzle. All ids are ULIDs (sortable, generate with a ~30-line helper
or the `ulid` package). All timestamps are ISO 8601 strings in UTC.

```sql
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
) STRICT;

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,        -- random 32-byte hex, this IS the cookie
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TEXT NOT NULL
) STRICT;

CREATE TABLE environments (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,           -- "production", "staging"
  created_at TEXT NOT NULL,
  UNIQUE(project_id, name)
) STRICT;

CREATE TABLE resources (
  id             TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,       -- slug: [a-z0-9-]+
  kind           TEXT NOT NULL,       -- Phase 1: only 'image'
  source_json    TEXT NOT NULL,       -- {"image":"nginx:alpine"}
  desired_state  TEXT NOT NULL,       -- 'running' | 'stopped'
  container_port INTEGER,             -- port the app listens on inside container
  memory_limit_mb INTEGER NOT NULL DEFAULT 512,
  health_path    TEXT,                -- e.g. "/health"; NULL disables HTTP check
  container_id   TEXT,
  current_deployment_id  TEXT,
  previous_image TEXT,                -- enables one-click rollback
  created_at     TEXT NOT NULL,
  UNIQUE(environment_id, name)
) STRICT;

CREATE TABLE deployments (
  id          TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  status      TEXT NOT NULL,   -- queued|running|succeeded|failed|cancelled
  image       TEXT NOT NULL,
  trigger     TEXT NOT NULL,   -- 'manual' | 'rollback' | 'reconcile'
  error       TEXT,
  started_at  TEXT,
  finished_at TEXT,
  created_at  TEXT NOT NULL
) STRICT;

CREATE TABLE env_vars (
  id              TEXT PRIMARY KEY,
  resource_id     TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,
  value_encrypted BLOB NOT NULL,
  created_at      TEXT NOT NULL,
  UNIQUE(resource_id, key)
) STRICT;

CREATE TABLE domains (
  id             TEXT PRIMARY KEY,
  resource_id    TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  host           TEXT NOT NULL UNIQUE,
  is_auto        INTEGER NOT NULL DEFAULT 0,   -- generated from wildcard
  created_at     TEXT NOT NULL
) STRICT;

CREATE TABLE jobs (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status       TEXT NOT NULL,      -- pending|leased|done|failed
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_after    TEXT NOT NULL,
  leased_until TEXT,
  last_error   TEXT,
  created_at   TEXT NOT NULL
) STRICT;

CREATE INDEX idx_jobs_claim ON jobs(status, run_after);
CREATE INDEX idx_deploy_resource ON deployments(resource_id, created_at DESC);
```

### Required PRAGMAs on open

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

Use **one** write connection for the whole process. Reads may share it —
`bun:sqlite` is synchronous, and at this scale contention is a non-issue.
Do not build a connection pool.

### Environment variable resolution

Phase 1 stores vars only at the resource level. Do not build project-level or
environment-level inheritance yet — the schema above accommodates adding it in
Phase 2 without migration pain.

---

## 8. The job queue

Every operation that touches Docker runs through the queue. **No route handler
may call the Docker client directly** (except read-only inspect calls for
rendering status). This keeps HTTP responses instant and makes the system
recoverable after a crash.

Implement in `src/queue/`. Roughly 120 lines.

**Semantics:**

- One worker loop, polling every 1000ms.
- **Concurrency: exactly 1.** Deploys are serialized. This is deliberate — see
  Section 13.
- Claim by atomic UPDATE:
  ```sql
  UPDATE jobs SET status='leased', leased_until=?, attempts=attempts+1
  WHERE id = (SELECT id FROM jobs
              WHERE status='pending' AND run_after <= ?
              ORDER BY created_at LIMIT 1)
  RETURNING *;
  ```
- Lease duration 15 minutes. On startup, reset rows where
  `status='leased' AND leased_until < now` back to `pending` — this recovers
  jobs interrupted by a crash or restart.
- Retry with exponential backoff: 10s, 60s, 300s. After `max_attempts`, mark
  `failed` and set the corresponding deployment to `failed`.
- Job types for Phase 1: `deploy`, `stop`, `remove`, `prune_images`.

---

## 9. The deploy pipeline

Job type `deploy`, payload `{ resourceId, deploymentId, image }`.

Steps, each emitting a log line to the deployment's log stream:

1. Mark deployment `running`, set `started_at`.
2. `ensureNetwork("mosdash")`.
3. Pull the image, forwarding pull progress lines to the log stream.
4. Decrypt env vars for the resource.
5. Create the new container named `mosdash-<resourceId>-<short deploymentId>`
   on the `mosdash` network, with all required labels and the memory limit.
6. Start it.
7. **Health gate.** Poll until healthy or timeout (default 60s):
   - If the resource defines `health_path` and `container_port`, HTTP GET
     `http://<containerName>:<port><health_path>` from inside the network and
     require a 2xx.
   - Else if the image declares a Docker HEALTHCHECK, poll inspect for
     `health === "healthy"`.
   - Else require the container to still be running after 5 seconds.
8. On success: update the Caddy route to point at the new container
   (Section 10), then stop and remove the **old** container after a 10-second
   drain. Set `resources.previous_image` to the outgoing image.
9. On failure: remove the new container, leave the old one serving, mark the
   deployment `failed` with the error, and emit a clear final log line.

**The old container must never be stopped before the new one is verified
healthy and the route has been switched.** This is the zero-downtime guarantee
and it is a correctness requirement, not a nicety.

---

## 10. Caddy integration

Caddy runs as a container mosdash manages, on the `mosdash` network, so it can
resolve app containers by name via Docker's embedded DNS.

- Start it with `--config /config/caddy.json` and the admin API bound to
  `0.0.0.0:2019` **on the mosdash network only** — never published to the host.
- Ports 80 and 443 published to the host.
- Persist `/data` (certificates) and `/config` to named volumes. Losing the
  certificate store means re-issuing and burning Let's Encrypt rate limit.

Manage routes by PATCHing the admin API over HTTP. Use `@id` for addressable
objects so each route can be replaced or deleted independently:

```json
{
  "@id": "mosdash-<resourceId>",
  "match": [{ "host": ["myapp-production.mos.example.com"] }],
  "handle": [
    {
      "handler": "reverse_proxy",
      "upstreams": [{ "dial": "mosdash-<resourceId>-<deployShort>:3000" }]
    }
  ]
}
```

- Add: `POST /config/apps/http/servers/srv0/routes/`
- Replace atomically: `PATCH /id/mosdash-<resourceId>`
- Delete: `DELETE /id/mosdash-<resourceId>`

**Automatic HTTPS** activates when a route has a host matcher and an ACME email
is configured. Store the admin email in settings on first run.

**Auto-generated domains:** `<resource-name>-<environment-name>.<WILDCARD_DOMAIN>`.
The operator sets `WILDCARD_DOMAIN` at install time and points a `*` A record at
the server. Users get a working HTTPS URL with zero DNS work.

**During development, use the Let's Encrypt staging endpoint.** Production
rate limits are 50 certificates per registered domain per week and you will hit
them while iterating.

---

## 11. The user interface

Server-rendered Eta templates, progressively enhanced with Alpine.js. Live
updates via SSE. **No SPA, no client-side router, no build step.**

The guiding principle: **the UI is a view of server state.** SQLite already
knows everything. Do not construct a parallel client-side store to mirror it.

### Routes

| Method | Path                         | Purpose                                                        |
| ------ | ---------------------------- | -------------------------------------------------------------- |
| GET    | `/login`                     | Login form                                                     |
| POST   | `/login`                     | Create session, redirect to `/`                                |
| POST   | `/logout`                    | Destroy session                                                |
| GET    | `/setup`                     | First-run admin creation (only when users table is empty)      |
| GET    | `/`                          | Project grid                                                   |
| POST   | `/projects`                  | Create project (auto-creates a `production` environment)       |
| GET    | `/p/:projectId`              | Environments and their resource cards                          |
| POST   | `/p/:projectId/environments` | Create environment                                             |
| GET    | `/r/:resourceId`             | Resource detail — tabs: Overview, Logs, Env, Domains, Settings |
| POST   | `/r/:resourceId/deploy`      | Enqueue deploy, redirect immediately                           |
| POST   | `/r/:resourceId/stop`        | Enqueue stop                                                   |
| POST   | `/r/:resourceId/rollback`    | Enqueue deploy of `previous_image`                             |
| POST   | `/r/:resourceId/env`         | Upsert env vars (bulk textarea, `KEY=value` per line)          |
| POST   | `/r/:resourceId/domains`     | Add custom domain                                              |
| DELETE | `/r/:resourceId`             | Enqueue remove, then delete row                                |
| GET    | `/r/:resourceId/events`      | **SSE** — status changes                                       |
| GET    | `/r/:resourceId/logs`        | **SSE** — live container logs                                  |
| GET    | `/d/:deploymentId/logs`      | **SSE** — build/deploy logs                                    |

### SSE event format

```
event: status
data: {"resourceId":"...","state":"deploying","health":"starting"}

event: log
data: {"stream":"stdout","ts":"2026-08-23T10:00:00Z","text":"Server listening"}

event: deployment
data: {"deploymentId":"...","status":"succeeded"}
```

One SSE connection per open page. Broadcast from the worker via a simple
in-process `EventEmitter` keyed by resource id. Send a comment heartbeat
(`: ping\n\n`) every 30 seconds to defeat proxy idle timeouts.

### Log handling (important)

- Keep a **ring buffer of the last 1000 lines per resource in memory.**
- Also append to `data/logs/<resourceId>.log`, rotated at 10MB, keeping 2 files.
- **Never write logs to SQLite.** This is the single fastest way to destroy both
  the RAM and disk profile of the product.
- On page load: render the buffered tail server-side, then open SSE for live
  lines. The user sees content instantly.

### UI requirements

- **Deploy button responds instantly.** Enqueue and redirect. Never await Docker
  in a request handler.
- **Log auto-scroll with pause-on-user-scroll.** If the user scrolls up, stop
  auto-scrolling and show a "jump to latest" button. Every deploy tool gets this
  wrong; getting it right is noticeable.
- **Status pills** — grey queued, blue deploying, green healthy, red failed,
  amber unhealthy. Updated via SSE, not polling.
- **Every deployment row shows** the image tag, trigger, duration, and status.
- **Rollback is one click** on the resource overview when `previous_image` is set.
- Dark mode via `@media (prefers-color-scheme: dark)` and CSS custom properties.
  No toggle in Phase 1.
- Empty states matter: a new install should tell the user exactly what to do next.
- All assets served from `public/`, embedded into the binary at compile time.
  No CDN — mosdash must work on a firewalled server.

---

## 12. Security

Docker socket access is equivalent to root on the host. Treat this seriously.

- **Env vars encrypted at rest** with AES-256-GCM. Key is 32 random bytes at
  `data/secret.key`, mode `0600`, generated on first run. Store IV and auth tag
  alongside the ciphertext.
- **Never log decrypted secret values.** Redact any env value in log output.
- **Sessions**, not JWT. Cookie: `httpOnly`, `secure`, `sameSite=lax`,
  30-day expiry, session id is 32 random bytes hex, stored in SQLite so logout
  actually revokes.
- **Passwords** via `Bun.password.hash` (argon2id) and `Bun.password.verify`.
- **CSRF**: all state-changing routes are POST with a per-session token in a
  hidden field. Verify it.
- **Validate all input with zod.** Resource names must match `^[a-z0-9-]{1,32}$`
  — they become container names and DNS labels.
- **Image references** must be validated against a registry-reference regex. An
  unvalidated image string is a command injection vector if it ever reaches a
  shell.
- **The Caddy admin API is never published to the host.**
- Bind mosdash's own HTTP port to `127.0.0.1` and route to it through Caddy.

---

## 13. Resource discipline

**Baseline target: mosdash idles at or below 100MB RSS.**

Enforce with:

- `bun build --compile --minify` for release builds. This moves parsing and
  transpiling cost from runtime to build time.
- **Exactly one concurrent job.** Deploys spike memory (image extraction,
  layer decompression); the control plane must not multiply that.
- **A hard memory limit on every container mosdash creates.** Default 512MB via
  `HostConfig.Memory`. A leaking user app must never take down the box or the
  dashboard. There is no "unlimited" option in the UI.
- **Logs to ring buffer plus file, never the database.**
- A daily `prune_images` job: remove dangling images and images unused for more
  than 168 hours. **Disk exhaustion kills more self-hosted servers than RAM
  does.** Surface reclaimed bytes in the UI.
- SQLite WAL with a single writer.

### Measurement is part of the build

Add to `package.json`:

```json
"scripts": {
  "build":  "bun build --compile --minify src/index.ts --outfile dist/mosdash",
  "rss":    "ps -o rss= -p $(pgrep -f dist/mosdash) | awk '{print $1/1024 \" MB\"}'"
}
```

Record the idle RSS in `README.md` and re-measure after any dependency addition.
**A pull request that raises idle RSS above 100MB must justify itself explicitly.**

---

## 14. The reconciler

A loop running every 30 seconds that converges actual state toward desired
state. This is what makes mosdash survive reboots and manual `docker rm`.

```
1. containers := docker.listManagedContainers()   // label mosdash.managed=true
2. resources  := db.resources where desired_state = 'running'

3. For each resource with no matching running container:
     enqueue deploy (trigger = 'reconcile')

4. For each managed container with no matching resource row:
     stop and remove it (it is an orphan)

5. For each running resource:
     refresh container_id, health, restart count in the DB
     broadcast an SSE status event if anything changed
```

Run it once at startup, before serving traffic, so a rebooted server heals
itself without user action.

---

## 15. Testing

Deliberately minimal for Phase 1. Do not scaffold broad unit coverage.

Write tests (`bun test`) for exactly these, which are where real bugs live:

1. **Log frame demultiplexing** — feed synthetic multiplexed byte streams,
   including frames split across chunk boundaries, and assert correct output.
2. **Env var encryption round-trip** — encrypt, decrypt, assert equality;
   assert that tampering with the ciphertext throws.
3. **Job claiming** — assert two concurrent claims cannot lease the same row.
4. **Env var text parsing** — `KEY=value` lines, quoted values, comments,
   blank lines, values containing `=`.

Everything else is verified manually against a real VPS, which is where the
interesting failures actually appear anyway.

---

## 16. Definition of done

Phase 1 is complete when, on a fresh Ubuntu 24.04 VPS with a wildcard DNS
record pointed at it, this sequence works end to end without touching a terminal
after step 1:

1. Run the install script. Docker, Caddy, and mosdash are running.
2. Open `https://<server-ip>:8000`, create the admin account.
3. Create project "demo". It gets a `production` environment automatically.
4. Add resource "web" with image `nginx:alpine`, container port 80.
5. Add env var `FOO=bar`.
6. Click Deploy. The log panel streams pull progress, then container output.
7. Within ~30 seconds the status pill turns green.
8. `https://web-production.<wildcard-domain>` serves nginx over valid HTTPS.
9. Change the image to `nginx:1.27-alpine`, redeploy. **The old container keeps
   serving until the new one is healthy** — verify with a `curl` loop showing
   zero failed requests.
10. Click Rollback. The previous image returns, again with zero downtime.
11. `docker rm -f` the container manually. Within 30 seconds the reconciler
    restarts it.
12. Reboot the server. Everything comes back up unattended.
13. `bun run rss` reports **under 100MB**.

---

## 17. Repository layout

```
mosdash/
├── src/
│   ├── index.ts              # entry: migrate, reconcile, start worker, serve
│   ├── config.ts             # env parsing + defaults, zod-validated
│   ├── db/
│   │   ├── index.ts          # bun:sqlite connection + PRAGMAs
│   │   ├── schema.ts         # drizzle schema
│   │   └── migrate.ts        # run SQL migrations from ./migrations
│   ├── docker/
│   │   ├── client.ts         # the interface from Section 6
│   │   ├── impl.ts           # chosen implementation
│   │   └── demux.ts          # log frame parser (tested)
│   ├── caddy/client.ts       # admin API wrapper
│   ├── queue/
│   │   ├── index.ts          # enqueue / claim / complete
│   │   └── worker.ts         # the single-concurrency loop
│   ├── jobs/
│   │   ├── deploy.ts         # Section 9 pipeline
│   │   ├── stop.ts
│   │   ├── remove.ts
│   │   └── prune.ts
│   ├── reconciler.ts         # Section 14
│   ├── logs/
│   │   ├── buffer.ts         # in-memory ring buffer
│   │   └── file.ts           # append + rotate
│   ├── crypto.ts             # AES-256-GCM helpers
│   ├── auth.ts               # sessions, CSRF, middleware
│   ├── events.ts             # in-process EventEmitter for SSE fan-out
│   ├── routes/
│   │   ├── auth.ts
│   │   ├── projects.ts
│   │   ├── resources.ts
│   │   └── sse.ts
│   └── views/                # .eta templates
│       ├── layout.eta
│       ├── partials/
│       └── pages/
├── public/
│   ├── app.css
│   └── alpine.min.js         # vendored, not from CDN
├── migrations/
│   └── 0001_init.sql
├── scripts/
│   └── install.sh
├── docs/
│   ├── PHASES.md             # this file
│   └── DECISIONS.md          # spike outcome + any deviations
├── data/                     # gitignored: sqlite, logs, secret.key
├── package.json
├── tsconfig.json
└── README.md
```

---

## 18. Configuration

Read from environment with zod validation and sensible defaults:

| Variable                     | Default                     | Notes                             |
| ---------------------------- | --------------------------- | --------------------------------- |
| `MOSDASH_PORT`               | `8000`                      | Bind to `127.0.0.1` in production |
| `MOSDASH_DATA_DIR`           | `./data`                    | SQLite, logs, secret key          |
| `MOSDASH_DOCKER_SOCKET`      | `/var/run/docker.sock`      |                                   |
| `MOSDASH_WILDCARD_DOMAIN`    | _(none)_                    | e.g. `mos.example.com`            |
| `MOSDASH_ACME_EMAIL`         | _(none)_                    | Required for automatic HTTPS      |
| `MOSDASH_ACME_STAGING`       | `false`                     | **Set true during development**   |
| `MOSDASH_CADDY_ADMIN`        | `http://mosdash-caddy:2019` |                                   |
| `MOSDASH_NETWORK`            | `mosdash`                   | Docker network name               |
| `MOSDASH_DEFAULT_MEMORY_MB`  | `512`                       | Per-container limit               |
| `MOSDASH_HEALTH_TIMEOUT_SEC` | `60`                        |                                   |
| `MOSDASH_LOG_LEVEL`          | `info`                      |                                   |

---

## 19. Implementation order

Build in this sequence. Each step should leave the app running.

1. **Spike** (Section 5) — decide the Docker client, record it.
2. `bun init`, dependencies, `tsconfig`, config module.
3. `bun:sqlite` connection, PRAGMAs, migration runner, schema.
4. `src/docker/demux.ts` **plus its test**. Get this right before anything
   depends on it.
5. Docker client implementation against the interface.
6. Auth: first-run setup, login, sessions, CSRF middleware.
7. Layout template, CSS, Alpine vendored. One ugly page that renders.
8. Projects and environments CRUD.
9. Resources CRUD, env vars with encryption.
10. Job queue and worker loop.
11. Deploy job — pull, create, start, health gate. **No proxy yet**; verify by
    curling the container's IP directly.
12. Log ring buffer, file append, SSE log endpoint, UI log panel with
    pause-on-scroll.
13. SSE status events and status pills.
14. Caddy container management and route API. Now the app has a real URL.
15. Zero-downtime swap and drain.
16. Rollback.
17. Reconciler.
18. Image prune job.
19. `bun build --compile`, `install.sh`, README with the measured RSS number.
20. Run the full Section 16 checklist on a real VPS.

---

## 20. Conventions

- TypeScript strict mode. No `any` — use `unknown` and narrow.
- No default exports except Eta templates.
- Errors: throw typed errors, catch at the route/job boundary, log with `pino`,
  return a useful message to the user. Never swallow an error silently.
- All user-facing strings in templates, not scattered through handlers.
- Comments explain **why**, not what. The Docker demux and the zero-downtime
  swap both warrant real comments.
- Keep `src/index.ts` under 60 lines — it wires things together, nothing more.
- Commit after each numbered step in Section 19 with a clear message.

---

## 21. Known traps

Things that will cost a day if not anticipated:

1. **Docker log frames split across chunks.** Section 6. Buffer properly.
2. **Let's Encrypt rate limits** — 50 certs per registered domain per week.
   Use staging during development, always.
3. **Caddy cert storage must be a persistent volume.** Losing it means
   re-issuing everything.
4. **Container name DNS requires a user-defined network.** The default bridge
   does not provide name resolution.
5. **V8/JSC heap growth.** If idle RSS drifts upward, investigate the ring
   buffer and any retained streams before blaming the runtime.
6. **`bun build --compile` and dynamic imports.** Templates and assets must be
   embedded via `--asset` or imported statically, or they vanish in the binary.
7. **SQLite writes from the worker and the HTTP handler simultaneously.** One
   connection, `busy_timeout` set. Do not open a second write connection.
8. **Deleting a resource must clean up in order:** stop container → remove
   container → delete Caddy route → remove volumes → delete DB row. A crash
   mid-sequence should be recoverable by the reconciler.

---

# Part II — Phases 2–5: Reaching Parity

## 22. Product thesis

Coolify is the incumbent: ~59k GitHub stars, 280+ one-click templates, years of
accumulated edge cases. mosdash does not win on feature count and should not try.

It wins on one axis:

> **Your $5 VPS runs your apps, not your dashboard.**

Coolify's control plane consumes **750MB–1.2GB before deploying anything** — a
PHP application (~300–400MB), its own PostgreSQL (~100–200MB), Redis, a
WebSocket server, and queue workers. On a 2GB VPS that leaves roughly 800MB for
actual workloads.

mosdash targets **under 100MB idle** for the same feature set, because it is one
process holding a SQLite file.

**This is an architectural advantage, not an optimization.** Coolify cannot
match it without a rewrite. Every feature below must be implemented in a way
that preserves it.

### The parity claim

Feature parity with Coolify's core, at one-tenth the memory. The four features
users actually evaluate on:

1. Projects containing multiple environments
2. Deploy from GitHub
3. Deploy from a Docker image or Docker Compose file
4. One-click service templates

Phase 1 delivers #1 and half of #3. Phases 2–3 deliver the rest.

---

## 23. Honest competitive assessment

Read this before committing months of effort.

**Where mosdash wins:** memory footprint, single-binary install, no external
database, faster cold start, simpler mental model, works on a 1GB VPS.

**Where mosdash will not win:** template breadth, integration count (S3
providers, notification channels, SSO), community size, battle-tested edge
cases, Windows/exotic-distro support.

**The market got crowded recently.** Dokploy, Haloy, Uncloud, Temps, CapRover,
Dokku, and Easypanel all occupy adjacent ground. "Coolify but lighter" is not a
pitch on its own — the RAM number is. Lead with the number in every README,
landing page, and post. It is measurable, verifiable, and defensible.

**Success criterion for the whole project:** 50 people running mosdash on a 1GB
box, in production, without complaints. That matters more than feature count.

---

## 24. Architectural invariants

These hold across every phase. A feature that violates one is redesigned or
dropped, regardless of how much users want it.

| Invariant                                             | Consequence                                                     |
| ----------------------------------------------------- | --------------------------------------------------------------- |
| **One long-running process**                          | No Redis, no Postgres, no separate worker daemon, no sidecar    |
| **SQLite is the only datastore**                      | WAL mode, single write connection                               |
| **Idle RSS ≤ 100MB**                                  | Measured in CI on every release. A rise must be justified       |
| **Max 1 concurrent build**                            | Builds spike to 1–2GB; the control plane must not multiply that |
| **Logs never touch the database**                     | Ring buffer in memory + rotated files on disk                   |
| **Every container has a memory limit**                | No "unlimited" option exists in the UI                          |
| **No client-side rendering runtime**                  | Server-rendered Eta + Alpine + SSE, forever                     |
| **Shell out rather than reimplement**                 | `docker compose`, `git`, `railpack` are external binaries       |
| **Everything Docker-touching goes through the queue** | Route handlers never block on Docker                            |

**Note on the last invariant and RAM:** external binaries (`docker compose`,
`railpack`) cost transient subprocess memory, not resident memory. This is
acceptable and is the correct trade. Reimplementing the Compose spec in
TypeScript would cost far more in code, bugs, and maintenance than it saves.

---

## 25. Feature inventory

Complete target state. `P#` is the delivering phase.

### Projects and organisation

| Feature                                                          | Phase  |
| ---------------------------------------------------------------- | ------ |
| Projects containing multiple environments                        | P1     |
| Resources within environments                                    | P1     |
| Resource-level environment variables, encrypted                  | P1     |
| Project- and environment-level shared variables with inheritance | **P2** |
| Clone an environment (staging from production)                   | **P3** |
| Search across projects and resources                             | **P3** |

### Deployment sources

| Feature                                         | Phase  |
| ----------------------------------------------- | ------ |
| Public Docker image                             | P1     |
| Private registry with credentials               | **P2** |
| GitHub repository, Dockerfile build             | **P2** |
| GitHub repository, zero-config build (Railpack) | **P2** |
| Automatic deploy on push to a watched branch    | **P2** |
| Manual redeploy of a specific commit            | **P2** |
| Docker Compose file, pasted or from repo        | **P3** |
| One-click templates                             | **P3** |
| Preview environment per pull request            | **P5** |

### Runtime and operations

| Feature                                 | Phase  |
| --------------------------------------- | ------ |
| Zero-downtime deploys with health gate  | P1     |
| One-click rollback                      | P1     |
| Auto-generated HTTPS subdomain          | P1     |
| Custom domains                          | P1     |
| Live log streaming over SSE             | P1     |
| Reconciler for self-healing             | P1     |
| Per-container memory limits             | P1     |
| Automatic image pruning                 | P1     |
| Scheduled tasks / cron per resource     | **P4** |
| Persistent volume management in the UI  | **P3** |
| Container resource usage display        | **P4** |
| Deployment history with commit metadata | **P2** |

### Data

| Feature                                             | Phase  |
| --------------------------------------------------- | ------ |
| Managed databases (Postgres, MySQL, Redis, MongoDB) | **P4** |
| Scheduled backups to local disk                     | **P4** |
| Backups to S3-compatible storage                    | **P4** |
| Restore from a backup                               | **P4** |

### Infrastructure

| Feature                                     | Phase  |
| ------------------------------------------- | ------ |
| Single server (the machine mosdash runs on) | P1     |
| Additional remote servers over SSH          | **P5** |
| Dedicated build server                      | **P5** |

### Permanently out of scope

Kubernetes or Swarm support · a plugin system · a hosted cloud offering ·
multi-tenancy with billing · SSO/SAML · mobile apps. Each would compromise an
invariant in Section 24.

---

## 26. Phase 2 — GitHub

**Goal:** a user connects GitHub, picks a repo, and every push deploys.
**Estimate:** 4–6 weeks part-time.

### GitHub App, not OAuth App

Register a GitHub App. The user clicks **Install**, selects repositories, and is
done — no personal access tokens pasted into a form. The App also delivers
webhooks, so there is nothing separate to configure.

Auth flow:

1. Sign a JWT with the App's RSA private key (10-minute expiry).
2. Exchange it for an **installation access token** (1-hour expiry, scoped to
   the selected repositories).
3. Cache installation tokens in memory keyed by installation id; refresh on
   expiry.

Use `@octokit/app`. Do not hand-roll this.

**Self-hosted registration:** each mosdash instance registers its own GitHub App
via the manifest flow — POST a manifest to GitHub, the user confirms, GitHub
redirects back with a code, exchange it for the App's credentials. Store the
private key encrypted with the same AES-256-GCM key used for env vars.

### Webhooks

- Endpoint `POST /webhooks/github`.
- **Verify the HMAC-SHA256 signature on every request** before parsing the body.
  Use `@octokit/webhooks`.
- Handle `push` (deploy if the branch matches), `installation` and
  `installation_repositories` (sync available repos), `ping`.
- Respond `202` immediately, enqueue the work. GitHub times out at 10 seconds.

### Fetching source

Prefer the **tarball endpoint** (`GET /repos/{owner}/{repo}/tarball/{ref}`) over
shelling out to `git`. No git binary dependency, no `.git` directory, smaller
disk footprint, and it is a single authenticated HTTP request.

Fall back to `git clone --depth=1 --branch <b>` only if submodules are needed.

Extract to `data/builds/<deploymentId>/` and **delete it when the build finishes,
success or failure.** Build directories are the second-largest disk leak after
images.

### Building

Two build strategies:

**Dockerfile** — user specifies the path (default `./Dockerfile`) and build
context. Invoke BuildKit.

**Zero-config (Railpack)** — Railpack detects the language and framework and
produces an image with no configuration. Use **Railpack, not Nixpacks**:
Nixpacks is in maintenance mode and its own authors recommend Railpack as the
replacement. Railpack is Go-based, interfaces directly with BuildKit, and
produces substantially smaller images (roughly 38% smaller for Node, 77% for
Python).

Run BuildKit as a container (`moby/buildkit`) that mosdash manages, the same way
it manages Caddy. Set `BUILDKIT_HOST` for Railpack invocations.

**Build cache is the difference between a 20-second and a 3-minute redeploy.**
Configure BuildKit's local cache with a size cap (default 10GB) and surface
cache usage in the UI alongside image usage.

### Schema additions

```sql
CREATE TABLE github_apps (
  id                TEXT PRIMARY KEY,
  app_id            INTEGER NOT NULL,
  slug              TEXT NOT NULL,
  client_id         TEXT NOT NULL,
  client_secret_enc BLOB NOT NULL,
  private_key_enc   BLOB NOT NULL,
  webhook_secret_enc BLOB NOT NULL,
  created_at        TEXT NOT NULL
) STRICT;

CREATE TABLE github_installations (
  id              TEXT PRIMARY KEY,
  app_id          TEXT NOT NULL REFERENCES github_apps(id) ON DELETE CASCADE,
  installation_id INTEGER NOT NULL UNIQUE,
  account_login   TEXT NOT NULL,
  created_at      TEXT NOT NULL
) STRICT;

CREATE TABLE registry_credentials (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  registry_url TEXT NOT NULL,
  username     TEXT NOT NULL,
  password_enc BLOB NOT NULL,
  created_at   TEXT NOT NULL
) STRICT;

-- resources: add
--   git_installation_id TEXT
--   git_repo            TEXT      -- "owner/name"
--   git_branch          TEXT
--   build_pack          TEXT      -- 'dockerfile' | 'railpack'
--   dockerfile_path     TEXT
--   build_context       TEXT
--   auto_deploy         INTEGER DEFAULT 1
--   registry_credential_id TEXT

-- deployments: add
--   commit_sha     TEXT
--   commit_message TEXT
--   commit_author  TEXT
```

### Shared environment variables

Add `shared_env_vars` with a nullable `project_id` and nullable
`environment_id`. Resolution order, last wins:

```
project shared → environment shared → resource-specific
```

Support `${VAR}` interpolation referencing an already-resolved variable.
Mark variables as build-time or runtime; build-time variables are passed as
build args and **must be redacted from build logs**.

### UI additions

Repository picker (searchable, grouped by owner) · branch selector · build pack
selector with auto-detected suggestion · commit SHA, message, and author on
every deployment row · "Deploy this commit" on historical rows · auto-deploy
toggle per resource · redacted build-arg display.

### Phase 2 Definition of Done

1. Install the GitHub App from within mosdash via the manifest flow.
2. Create a resource from a private repository.
3. Deploy with Railpack, zero configuration, for a Node app and a Python app.
4. Deploy a repo with a Dockerfile.
5. Push a commit; the app redeploys automatically within 60 seconds.
6. The deployment row shows the correct commit SHA and message.
7. A second push with a warm cache builds noticeably faster.
8. Build directories are removed after every build, including failures.
9. Build-time secrets do not appear in build logs.
10. **Idle RSS still under 100MB.**

---

## 27. Phase 3 — Compose and templates

**Goal:** deploy multi-container stacks, and make one-click templates work.
**Estimate:** 6–10 weeks part-time. **This is the largest phase.**

### Docker Compose

**Shell out to the `docker compose` CLI. Do not reimplement the Compose spec.**
It is enormous — `depends_on`, healthchecks, profiles, `extends`, build
contexts, configs, secrets, `x-` extensions. Reimplementing it is how this
project dies.

mosdash's actual job is a **YAML transform pipeline**:

1. Parse the user's `docker-compose.yaml` (`yaml` package).
2. **Validate and reject dangerous constructs**: `privileged: true`,
   `network_mode: host`, bind mounts to sensitive host paths, and
   `/var/run/docker.sock` mounts. Present a clear error, not a silent strip.
3. Inject the `mosdash` network so services can reach each other and Caddy can
   reach them by name.
4. Inject `mosdash.*` labels on every service for ownership tracking.
5. Rewrite named volumes to a project-scoped namespace so two stacks cannot
   collide.
6. Merge resolved environment variables.
7. Apply a default memory limit to any service lacking one.
8. Write to `data/compose/<resourceId>/docker-compose.yaml`.
9. `docker compose -p mosdash-<resourceId> up -d --remove-orphans`, streaming
   stdout and stderr to the SSE log channel via `Bun.spawn`.

### The genuinely hard parts

Budget most of the phase for these three.

**Multi-service routing.** A stack has many services; which one gets the domain?
You need UI for it: the user picks a service and a port, and may map several
services to several domains. The `domains` table needs a nullable `service_name`
column.

**Volume lifecycle.** On redeploy, named volumes must persist. On delete, the
user must be asked explicitly whether to destroy data. Surface volumes in the UI
with their sizes — users lose data here and blame the platform.

**Health gating a stack.** Zero-downtime for a multi-service stack is
genuinely harder than for a single container. For Phase 3, be honest: use
`docker compose up -d` recreate semantics, gate the route switch on the
designated public service becoming healthy, and **document that stacks may have
brief downtime on redeploy.** Do not fake a guarantee you cannot keep.

### One-click templates

**A template is just a `docker-compose.yaml` file in a git repository.** Once
Compose works, templates are roughly a week's work for the single highest
perceived-value feature in the product.

```
mosdash-templates/
├── index.json
└── templates/
    ├── plausible/
    │   ├── docker-compose.yaml
    │   ├── logo.svg
    │   └── meta.json      # name, description, tags, docs URL, min RAM
    ├── n8n/
    └── ghost/
```

Flow: fetch and cache `index.json` → render a searchable grid → user clicks →
mosdash generates values for placeholders → runs the existing Compose pipeline.

**Placeholder convention** (compatible with Coolify's, which eases porting):

```
SERVICE_PASSWORD_<NAME>    → 32-char random
SERVICE_USER_<NAME>        → random username
SERVICE_BASE64_<NAME>      → 32 random bytes, base64
SERVICE_FQDN_<SERVICE>     → auto-generated subdomain
SERVICE_URL_<SERVICE>      → https:// + the FQDN
```

**Seeding the catalogue:** Coolify's template repository is MIT-licensed. Verify
the current license terms yourself, preserve attribution, and you can adapt from
it rather than authoring 200 Compose files by hand. Ship ~30 curated templates
that are genuinely tested rather than 280 that are not.

**Add a `minimum_ram_mb` field to `meta.json` and warn the user when a template
exceeds available memory.** No other platform does this, and for mosdash's
audience — people on small VPSes — it is exactly on-brand.

### Schema additions

```sql
-- resources.kind gains 'compose'
-- resources.source_json for compose:
--   { "composeFile": "...", "source": "paste"|"git"|"template",
--     "templateId": "plausible", "publicService": "web" }

CREATE TABLE compose_services (
  id            TEXT PRIMARY KEY,
  resource_id   TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  service_name  TEXT NOT NULL,
  container_id  TEXT,
  state         TEXT,
  UNIQUE(resource_id, service_name)
) STRICT;

CREATE TABLE volumes (
  id          TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  docker_name TEXT NOT NULL UNIQUE,
  mount_path  TEXT NOT NULL,
  service_name TEXT,
  created_at  TEXT NOT NULL
) STRICT;

-- domains: add service_name TEXT, container_port INTEGER
```

### Phase 3 Definition of Done

1. Paste a Compose file with three services; all start on the mosdash network.
2. Designate one service public; it is reachable over HTTPS.
3. Services resolve each other by name.
4. Redeploy preserves volume data.
5. Deleting the stack prompts about volumes and honours the choice.
6. A Compose file using `privileged: true` is rejected with a clear message.
7. Deploy Plausible, n8n, and Ghost from templates; each works end to end.
8. Template placeholders generate distinct secrets per deployment.
9. A template exceeding available RAM produces a warning before deploy.
10. **Idle RSS still under 100MB.**

---

## 28. Phase 4 — Databases and backups

**Goal:** managed data services with real backups.
**Estimate:** 3–4 weeks.

**Key insight: a managed database is a template plus a backup cron.** Do not
build a separate subsystem. `resources.kind = 'database'` reuses the entire
Compose pipeline with a curated file, a generated password, and — critically —
**no public domain by default.**

Support Postgres, MySQL/MariaDB, Redis, and MongoDB. That covers the vast
majority of real usage.

**Backups:**

- Per-database schedule as a cron expression, evaluated by the existing queue.
- Dump via `docker exec` into the container (`pg_dump`, `mysqldump`,
  `mongodump`, Redis `BGSAVE` + copy the RDB).
- Compress, write to `data/backups/<resourceId>/`, apply a retention policy.
- Optional upload to S3-compatible storage. Use a small S3 client or plain
  signed `fetch` requests — **do not add the full AWS SDK**, it is enormous.
- **Restore must be tested and exposed in the UI.** An untested backup is not a
  backup. Include a "verify last backup" action that checks the dump is
  readable.
- Show backup size, last run, next run, and last error prominently.

Add `internal_only` to resources — databases are not routed through Caddy and
never receive a public domain unless explicitly requested.

Add scheduled tasks per resource in this phase too; the cron infrastructure is
already built for backups.

### Phase 4 Definition of Done

Create a Postgres database, connect an app to it by container name, take a
scheduled backup, upload it to S3, **restore it into a fresh database, and
verify the data.** Databases are unreachable from the public internet.
Idle RSS still under 100MB.

---

## 29. Phase 5 — Multi-server and previews

**Goal:** manage more than one machine.
**Estimate:** 4–6 weeks.

**Use SSH, not an agent.** The user adds a server by pasting an IP and adding
mosdash's public key. Nothing to install. This is how Coolify does it and it is
correct — an agent binary is another thing to version, update, and debug.

- Generate an ed25519 keypair on first run, store the private key encrypted.
- SSH with **connection multiplexing** (`ControlMaster`, `ControlPersist`) —
  reconnecting per command is slow and hammers `sshd`.
- Tunnel the remote Docker socket over SSH; the `DockerClient` interface from
  Phase 1 gains a per-server implementation. **This is why that abstraction
  exists** — nothing above it changes.
- Each server runs its own Caddy. Routes are managed per server.
- **Dedicated build server:** designate one server for builds, push resulting
  images to a registry, pull on the deploy target. This is the real fix for
  build memory spikes and is a genuine selling point.
- Health monitoring per server: reachability, disk, memory. Alert on
  disconnection.

**Preview environments** land here: on `pull_request` opened/synchronised,
create an ephemeral resource in a `preview` environment at
`pr-<n>-<resource>.<wildcard>`, comment the URL on the PR, and destroy
everything on close. Enforce a per-project cap on concurrent previews or a
busy repository will exhaust the server.

### Phase 5 Definition of Done

Add a second server over SSH, deploy to it, use a dedicated build server, and
have PR previews created and destroyed automatically. Idle RSS still under
100MB on the control-plane server.

---

## 30. RAM budget by phase

The number is the product. Measure at the end of every phase and publish it.

| Phase | Added components                      | Target idle RSS |
| ----- | ------------------------------------- | --------------- |
| 1     | Core + Caddy                          | ≤ 100MB         |
| 2     | Octokit, BuildKit client              | ≤ 110MB         |
| 3     | YAML transform, compose orchestration | ≤ 120MB         |
| 4     | Cron, backup jobs, S3                 | ≤ 130MB         |
| 5     | SSH multiplexing, per-server clients  | ≤ 150MB         |

Even at Phase 5, that is **five to eight times lighter than Coolify's control
plane**. The comparison stays true through full feature parity.

**Sidecar containers mosdash manages** (Caddy ~50MB, BuildKit idle ~30MB) are
reported separately and honestly in the README. Coolify's published overhead
also includes its proxy, so the comparison remains fair — but never quote a
number that excludes something a user will actually be running.

### CI gate

Every release build boots the binary, idles 60 seconds, measures RSS, and fails
the build if it exceeds that phase's budget. **This is the single most important
piece of automation in the project.** Without it, the number drifts and the
product loses its reason to exist.

---

## 31. Release strategy

**Do not wait for Phase 5 to launch.** Ship at the end of every phase.

- **Phase 1 → private alpha.** Ten people you can talk to directly.
- **Phase 2 → public beta.** GitHub deploy is the threshold at which mosdash
  becomes genuinely usable. Launch here, not later.
- **Phase 3 → 1.0.** Compose and templates are the parity claim.
- **Phase 4/5 → 1.x.** Iterate on real feedback.

**Every announcement leads with the RAM number.** Not the feature list — the
number. It is the only thing that distinguishes mosdash in a crowded field, and
it is verifiable in ten seconds by anyone who doubts it.

Publish a reproducible benchmark: a script that installs mosdash and Coolify on
identical VPSes, deploys the same three apps to each, and prints idle RSS. Being
willing to be measured is the strongest form of the claim.

---

## 32. Things that will kill this project

Named explicitly so they can be watched for.

1. **Scope creep into Phase 3 before Phase 2 ships.** Compose is fascinating and
   endless. Finish GitHub first.
2. **Reimplementing Docker Compose.** Shell out. Always.
3. **Letting the RAM number drift.** Without the CI gate it will, silently, and
   then there is no product.
4. **Chasing template count.** Thirty tested templates beat 280 broken ones.
5. **Adding Redis "just for the queue".** The SQLite queue is 120 lines and
   sufficient at this scale forever.
6. **Rewriting the UI in React.** The dashboard is a list, a detail page, and a
   log stream. It does not need a framework.
7. **Building multi-tenancy.** Self-hosted software has one user. Every
   permission system is a feature nobody asked for.
8. **Neglecting disk.** Images, build directories, and logs will fill a 40GB
   disk in weeks without aggressive pruning. This generates more support load
   than any other single issue.
