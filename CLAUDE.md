# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What musdash is

A self-hosted PaaS — a Coolify alternative. The user points it at their own VPS
and it deploys and runs their applications in Docker containers, each reachable
at an HTTPS URL.

Its differentiating promise is resource frugality: **the control plane idles at
or below 100MB RSS**, doing as a single process holding a SQLite file what
Coolify needs 750MB–1.2GB for. That budget is a hard product requirement, not an
optimization — a design that adds a second long-running process, a database
server, or a client-side rendering runtime is out of scope by definition, no
matter how much users want the feature it would enable.

musdash does not win on feature count and should not try. It targets parity with
Coolify's core at one-tenth the memory, and concedes template breadth,
integration count, and battle-tested edge cases.

The repository is currently a scaffold: [src/index.ts](src/index.ts) is a
hello-world Elysia server. Nearly everything described below is still to be
built.

The stack is fixed, and some dependencies are forbidden outright: Prisma
(ships a large Rust query engine), Redis-backed queues like BullMQ, Socket.io
(SSE is enough), Express, Tailwind/PostCSS/Sass (require a build step), and any
node-gyp native module (breaks single-binary compilation). Do not substitute
technology choices. Record any deviation, and the reasoning behind it, in
`docs/DECISIONS.md`.

## Scope

Projects contain environments; environments contain resources. A resource is
deployed from a public or private Docker image, a GitHub repository (built from a
Dockerfile or zero-config), or a Docker Compose file — including one-click
templates, which are themselves just Compose files. Environment variables are
encrypted at rest and resolve project → environment → resource. Every deploy
pulls or builds, health-gates, and switches traffic with no downtime, and is
one click to roll back. Caddy issues certificates automatically for an auto
subdomain and any custom domain. A reconciler heals drift; a prune job keeps the
disk from filling. Managed databases, scheduled backups with tested restore,
per-resource cron, PR preview environments, and additional servers over SSH are
all in scope.

**How each of those is built is already decided** — `docs/DECISIONS.md` covers
the Docker client, Caddy, the SQLite queue, GitHub App auth, Railpack, the
Compose transform pipeline, templates, backups, and SSH. Read the relevant entry
before building the thing it describes; do not re-derive or substitute.

### Permanently out of scope

Kubernetes or Swarm · a plugin system · a hosted cloud offering · multi-tenancy
with billing · SSO/SAML · mobile apps · multi-user accounts, teams, and RBAC · a
REST API for third-party consumers. Each would compromise an invariant below.
Self-hosted software has one user.

### What will kill this project

Reimplementing Docker Compose instead of shelling out · letting the RAM number
drift without a CI gate · chasing template count · adding Redis "just for the
queue" · rewriting the UI in React for what is a list, a detail page, and a log
stream · building multi-tenancy · neglecting disk, which generates more support
load than any other single issue.

### The RAM budget

Every release build boots the binary, idles 60 seconds, measures RSS, and **fails
the build if it exceeds 100MB**. Without that gate the number drifts silently and
the product loses its reason to exist. The ceiling does not move to accommodate a
new component without an explicit, justified decision.

Sidecar containers musdash manages (Caddy ~50MB, BuildKit idle ~30MB) are
reported separately — never quote a number that excludes something the user will
actually be running.

## Stack

Bun runtime, Elysia HTTP, `bun:sqlite` with Drizzle as a thin query builder, Eta
templates, Alpine.js vendored locally, handwritten CSS. Caddy in a container for
TLS and routing. Pino for logs, zod for validation, `Bun.password` (argon2id)
for hashing, `node:crypto` AES-256-GCM for secrets. No SQLite package — it is
built into the runtime.

**Pin to installed versions.** Before generating code against any dependency,
read the version actually installed in `package.json` / `bun.lock` and consult
the docs for _that_ version. Do not write from training-data recall — Elysia,
Drizzle, and Biome all change APIs across minors.

## How work runs here

Work moves through focused roles with separate contexts and a human gate between
stages, rather than one long conversation that would drift and grade its own
work.

### The loop

```
1. RESEARCH    map the code area, existing patterns, and risks — no edits
2. SPEC        restate the slice: files, data model, interfaces, criteria
   ── HUMAN APPROVAL ──
3. BUILD       implement one slice, with its tests
4. VERIFY      prove each acceptance criterion; test files only
5. VALIDATE    review against this file and the approved brief — findings only
6. If critical findings → back to BUILD, then re-verify and re-validate
   ── HUMAN APPROVAL ──  before commit
```

The spec in step 2 is written fresh per slice and does not live in the repo. It is
what the human approves before any code is written, and what the Validator checks
the result against.

### The roles

musdash is one process with server-rendered templates, so there is no
backend/frontend split. The seams that matter are these:

| Role              | May touch                                  | Produces                                                         |
| ----------------- | ------------------------------------------ | ---------------------------------------------------------------- |
| **Researcher**    | read only                                  | relevant files, existing patterns, risks, a plan. Never edits.   |
| **Spec-Writer**   | read only                                  | slice scope, data/interface changes, criteria, open questions    |
| **Core-Builder**  | `src/**`, `migrations/**`                  | modules, routes, jobs, migrations, unit tests                    |
| **UI-Builder**    | `src/views/**`, `src/routes/**`, `public/` | templates, CSS, Alpine behavior. Consumes routes as specified.   |
| **Test-Verifier** | test files only                            | tests for each criterion; reports pass/fail. Never edits `src/`. |
| **Validator**     | read only                                  | findings by severity: critical / important / minor. Never fixes. |

**Tool restriction is the point, not the prompt** — a validator that cannot edit
cannot quietly fix what it should have reported. `.claude/agents/` does not exist
yet; until it does, run the loop with the Task tool, one subagent per role, each
given only the tools its row allows. When adding those files, one role per file
with an explicit output-format contract, since the next role parses it.

### Output contracts

- **Researcher / Validator** — Markdown, no code blocks proposing changes.
  Validator findings are grouped `## Critical` / `## Important` / `## Minor`,
  each naming `file:line` and the invariant or criterion violated.
- **Spec-Writer** — the files to touch, the interfaces to add or change, the
  acceptance criteria, and an explicit out-of-scope list.
- **Builders** — the diff, plus the typecheck/lint/test commands actually run
  and their result. Report failures; never claim a passing run that did not happen.

### Session hygiene

- **Explore before building.** Read the surrounding code and the patterns it
  already uses before writing. Ask for options when a design choice is open,
  not code.
- **Throw away a drifted conversation.** If a wrong architectural assumption has
  already propagated across files, restart with a sharper brief rather than
  patching over it. Reverting is cheaper than untangling.
- **One slice per session** — a module and its tests. Commit at each completed
  slice with a message naming the slice.
- **Grow this file.** Every time a preventable mistake happens, add the rule that
  would have stopped it. Keep it under ~300 lines; when it exceeds that, push
  detail into a skill or agent file and leave the rule here.

## Architectural invariants

Correctness requirements, not preferences — violating one silently breaks a
guarantee the product makes. A feature that violates one is redesigned or
dropped, regardless of how much users want it. The Validator checks every one.

- **One long-running process, and SQLite is the only datastore.** No Redis, no
  Postgres, no separate worker daemon, no sidecar for musdash itself. The
  containers musdash manages (Caddy, BuildKit) are the exception.
- **No route handler calls Docker directly.** Every mutating Docker operation is
  enqueued as a job in the SQLite-backed queue and executed by the single worker
  loop. Read-only `inspect` calls for rendering status are the only exception.
  HTTP handlers enqueue and redirect immediately, so the UI never waits on
  Docker.
- **Job concurrency is exactly 1.** Deploys spike memory (image extraction,
  layer decompression); serializing them is what keeps the RAM budget. Do not add
  a second worker or a second long-running process.
- **All Docker access goes through the `DockerClient` interface**
  (`src/docker/client.ts`). Nothing else imports a Docker library or fetches the
  socket. Remote servers are later added as another implementation behind this
  interface, so nothing above it changes — keep it free of local-socket
  assumptions.
- **Shell out rather than reimplement.** `docker compose`, `git`, and `railpack`
  are external binaries invoked via `Bun.spawn` — subprocesses cost transient
  memory, not resident memory, so this is the correct trade.
- **Compose is the substrate for anything multi-container**, managed databases
  included — a database is a curated Compose file plus a generated password plus
  a backup cron, not a parallel orchestration path.
- **The old container is never stopped** until the new one passes the health gate
  _and_ the Caddy route has been switched. This is the zero-downtime guarantee.
- **One SQLite write connection** for the whole process, WAL, `busy_timeout`
  set. No connection pool, no second writer.
- **Logs never go to SQLite** — in-memory ring buffer (1000 lines/resource) plus
  a rotated file under `data/logs/`. Writing them to the database is the fastest
  way to wreck both the RAM and the disk profile.
- **Every container musdash creates has a hard memory limit** (default 512MB). A
  leaking user app must never take down the box or the dashboard, so there is no
  "unlimited" option in the UI.
- **Every managed container carries the `musdash.*` labels** — the reconciler
  identifies live containers and orphans by them.
- **No build step for the frontend.** Server-rendered Eta + vendored Alpine.js +
  handwritten CSS, assets served from `public/` and embedded into the compiled
  binary. No CDN — musdash must work on a firewalled server. The UI is a view of
  server state; SQLite already knows everything, so do not build a parallel
  client-side store.

## Don't do

- **Do not log decrypted env values.** Redact them everywhere, including error
  paths and deploy logs.
- **Do not await Docker in a request handler.** Enqueue and redirect.
- **Do not add a cron daemon or a second process.** Scheduled work (prune,
  reconcile, backups) runs on the existing queue and loops.
- **Do not build ahead of the slice.** Implement what the approved brief covers;
  do not scaffold adjacent capability "for later".
- **Do not add a dependency without measuring idle RSS** before and after.
- **Do not return raw internal errors to the browser** — log the detail, show the
  user something useful.
- **Do not claim a test or typecheck passed without running it.**

## Commands

```bash
bun run dev            # watch-mode server (src/index.ts) on port 8000
bun run check          # format + lint with warnings as errors — run before committing
bun run ci             # non-mutating equivalent (prettier --check + biome ci)
bun run format         # prettier --write .
bun run lint:fix       # biome lint --write .
bun test               # test runner (no tests exist yet)
bun test src/docker/demux.test.ts   # a single test file
bun add <pkg>          # bun is the package manager — bun.lock is committed
```

Expected once the app is real, not yet in package.json: `bun build --compile
--minify src/index.ts --outfile dist/musdash` for the release build, and
`bun run rss` to measure its idle RSS.

## Security constraints

- Env var values are encrypted at rest (AES-256-GCM, key at `data/secret.key`,
  mode 0600). **Never log a decrypted value** — redact env values in log output.
- Sessions in SQLite, not JWT, so logout actually revokes. CSRF token on every
  state-changing POST.
- Validate all input with zod. Resource names must match `^[a-z0-9-]{1,32}$`
  (they become container names and DNS labels), and image references must be
  validated against a registry-reference regex — an unvalidated image string is a
  command injection vector if it ever reaches a shell.
- The Caddy admin API is never published to the host; the musdash HTTP port binds
  to `127.0.0.1` in production and is reached through Caddy.
- Docker socket access is root-equivalent on the host. Treat any path that can
  influence a container spec as a privilege boundary.

## Code conventions

- TypeScript strict, no `any` — use `unknown` and narrow.
- No default exports except Eta templates.
- Keep `src/index.ts` under 60 lines: it wires modules together, nothing more.
- Throw typed errors, catch at the route/job boundary, log with pino, return a
  useful message. Never swallow an error.
- User-facing strings live in templates, not handlers.
- Comments explain _why_. The Docker log demultiplexer and the zero-downtime
  swap warrant real ones.

## Tooling

**Prettier formats, Biome lints only** (`formatter.enabled: false` in
[biome.json](biome.json)), with `suspicious` at `preset: "all"` plus a hand-tuned
`style` group. A Husky `pre-commit` hook runs lint-staged and fails the commit on
any Biome warning — a deterministic gate that runs regardless of what any agent
believes about the code. **Prefer gates over instructions wherever a rule can be
mechanically checked.**

`.gitattributes` forces LF everywhere; this is a Windows dev machine, so do not
re-enable `core.autocrlf` or the `endOfLine: "lf"` Prettier setting will fight
the checkout.

## Testing

Testing is intentionally minimal. Write `bun test` tests for exactly four things,
which is where the real bugs are: Docker log frame demultiplexing (frames are
8-byte-header multiplexed and split across chunk boundaries), env var encryption
round-trip and tamper detection, job claiming under concurrency, and `KEY=value`
env text parsing. **Do not scaffold broad unit coverage** — everything else is
verified manually against a real VPS.

The Test-Verifier proves acceptance criteria; it does not raise coverage for its
own sake. A criterion that cannot be tested cheaply is verified by hand and
recorded as such.
