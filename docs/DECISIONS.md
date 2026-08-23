# Decisions

Settled technology and design choices, with the reasoning behind them. Read the
entry before building the thing it describes; add an entry whenever a real choice
gets made, and record any deviation from the stack in `CLAUDE.md` here too.

Nothing in this file is built yet — these are decisions taken in advance, so they
are not re-litigated or guessed at mid-slice.

## Docker access

All Docker access goes through the `DockerClient` interface in
`src/docker/client.ts`. Nothing else imports a Docker library or fetches the
socket.

The implementation behind it is decided by a spike before anything is built on
top: `dockerode` versus raw `fetch` over the unix socket (Bun supports
`fetch(url, { unix: "/var/run/docker.sock" })` natively). The real test is
attaching to a container's log stream — Docker multiplexes it with an 8-byte
frame header, and `dockerode` relies on Node stream internals Bun may not fully
implement. **If both work, prefer raw `fetch`**: the Engine API is plain
HTTP + JSON, the client is roughly 200 lines, and it removes a dependency plus a
Bun-compatibility risk for the life of the project.

Record the spike outcome here when it happens.

## Reverse proxy — Caddy

Caddy runs as a container mosdash manages, on the shared `mosdash` network so it
resolves app containers by name via Docker's embedded DNS. Routes are managed by
PATCHing its JSON admin API, using `@id` for addressable objects so each route
can be replaced or deleted independently.

- The admin API binds to the mosdash network only, **never published to the
  host**.
- `/data` (certificates) and `/config` are named volumes. Losing the certificate
  store means re-issuing everything and burning Let's Encrypt rate limit.
- Rate limits are 50 certificates per registered domain per week. **Use the
  staging endpoint during development** — you will hit them while iterating.
- Container-name DNS requires a user-defined network; the default bridge does not
  provide name resolution.

## Job queue — SQLite, not Redis

The queue is a table, one worker loop polling every second, claiming by atomic
`UPDATE ... RETURNING`. Roughly 120 lines. Lease duration 15 minutes; on startup,
rows still leased past their expiry are reset to pending, which recovers jobs
interrupted by a crash. Retry with exponential backoff (10s, 60s, 300s), then
mark failed.

**Concurrency is exactly 1**, deliberately: deploys spike memory during image
extraction and layer decompression, and serializing them is what holds the RAM
budget.

Adding Redis "just for the queue" would break the single-process invariant for a
component that is sufficient at this scale forever.

## Source fetching — tarball, not `git clone`

Fetch repository source via the GitHub tarball endpoint
(`GET /repos/{owner}/{repo}/tarball/{ref}`) rather than shelling out to `git`:
one authenticated HTTP request, no git binary dependency, no `.git` directory,
smaller disk footprint. Fall back to `git clone --depth=1` only if submodules are
needed.

Extract to `data/builds/<deploymentId>/` and **delete it when the build finishes,
success or failure** — build directories are the second-largest disk leak after
images.

## GitHub — App, not OAuth App

Register a GitHub App, not an OAuth App, and never accept pasted personal access
tokens. The user clicks Install and selects repositories; the App also delivers
webhooks, so there is nothing separate to configure.

Each mosdash instance registers its own App via the manifest flow — POST a
manifest, the user confirms, GitHub redirects back with a code, exchange it for
credentials. Store the private key encrypted with the same key used for env vars.

Auth is a JWT signed with the App's RSA key (10-minute expiry), exchanged for an
installation access token (1-hour expiry, scoped to selected repos), cached in
memory by installation id. Use `@octokit/app`; do not hand-roll it.

Webhooks: **verify the HMAC-SHA256 signature before parsing the body**, respond
`202` immediately and enqueue the work — GitHub times out at 10 seconds.

## Builds — Railpack, not Nixpacks

Zero-config builds use Railpack. Nixpacks is in maintenance mode and its own
authors recommend Railpack as the replacement; Railpack is Go-based, interfaces
directly with BuildKit, and produces substantially smaller images (~38% smaller
for Node, ~77% for Python).

BuildKit runs as a container mosdash manages, the same way it manages Caddy, with
`BUILDKIT_HOST` set for Railpack invocations. Cache the local build cache with a
size cap (default 10GB) and surface its usage alongside image usage — build cache
is the difference between a 20-second and a 3-minute redeploy.

The alternative strategy is a user-specified Dockerfile and build context,
invoking BuildKit directly.

## Compose — shell out, never reimplement

Shell out to the `docker compose` CLI via `Bun.spawn`. The Compose spec is
enormous — `depends_on`, healthchecks, profiles, `extends`, build contexts,
configs, secrets, `x-` extensions — and reimplementing it in TypeScript would
cost far more in code, bugs, and maintenance than it saves. Subprocesses cost
transient memory, not resident memory, so this does not threaten the RAM budget.

mosdash's actual job is a **YAML transform pipeline**: parse, then reject
dangerous constructs with a clear error (`privileged: true`, `network_mode: host`,
docker-socket mounts, bind mounts to sensitive host paths) rather than silently
stripping them; then inject the shared network, `mosdash.*` labels,
project-scoped volume names, resolved env vars, and a default memory limit on any
service lacking one.

Zero-downtime for a multi-service stack is genuinely harder than for a single
container. Gate the route switch on the designated public service becoming
healthy and **document that stacks may have brief downtime on redeploy** — do not
fake a guarantee that cannot be kept.

## Templates are Compose files in a git repository

A template is a `docker-compose.yaml` plus a `meta.json` in a repo, fetched and
cached from an `index.json`. Once Compose works, templates are roughly a week's
work for the single highest perceived-value feature in the product.

Placeholder convention (compatible with Coolify's, which eases porting):
`SERVICE_PASSWORD_<NAME>`, `SERVICE_USER_<NAME>`, `SERVICE_BASE64_<NAME>`,
`SERVICE_FQDN_<SERVICE>`, `SERVICE_URL_<SERVICE>` — generated fresh per
deployment.

Coolify's template repository is MIT-licensed; verify the current terms, preserve
attribution, and adapt rather than authoring hundreds of Compose files by hand.
**Ship ~30 curated and genuinely tested rather than 280 that are not.**

`meta.json` carries a `minimum_ram_mb`, and a template exceeding available memory
warns before deploying. No other platform does this, and for people on small
VPSes it is exactly on-brand.

## Managed databases are templates plus a backup cron

`kind = 'database'` reuses the Compose pipeline with a curated file and a
generated password — not a separate subsystem. Databases are marked internal-only
and never routed through Caddy unless explicitly requested.

Postgres, MySQL/MariaDB, Redis, and MongoDB cover the vast majority of real use.

Backups run on the existing queue as cron expressions, dumping via `docker exec`
(`pg_dump`, `mysqldump`, `mongodump`, Redis `BGSAVE` plus RDB copy), compressed
under a retention policy, optionally uploaded to S3-compatible storage via a
small client or plain signed `fetch` — **never the full AWS SDK**, it is enormous.

**Restore must be exposed in the UI and tested.** An untested backup is not a
backup; include a "verify last backup" action that checks the dump is readable.

## Multiple servers — SSH, not an agent

The user pastes an IP and adds mosdash's public key. Nothing to install, version,
update, or debug on the remote box. Generate an ed25519 keypair on first run and
store the private key encrypted.

Use connection multiplexing (`ControlMaster`, `ControlPersist`) — reconnecting
per command is slow and hammers `sshd`. Tunnel the remote Docker socket over SSH
behind a per-server implementation of `DockerClient`; **nothing above that
interface changes**, which is the entire reason the abstraction exists.

Each server runs its own Caddy with its own routes. A dedicated build server
(build there, push to a registry, pull on the deploy target) is the real fix for
build memory spikes.

## Known traps

Things that cost a day if not anticipated:

1. **Docker log frames split across chunk boundaries.** Buffer partial frames;
   never assume one chunk is one frame. The single most common bug in that layer.
2. **Let's Encrypt rate limits.** Staging endpoint during development, always.
3. **Caddy cert storage must be a persistent volume.**
4. **Container-name DNS requires a user-defined network.**
5. **Heap growth.** If idle RSS drifts upward, investigate the log ring buffer
   and any retained streams before blaming the runtime.
6. **`bun build --compile` and dynamic imports.** Templates and assets must be
   embedded via `--asset` or imported statically, or they vanish in the binary.
7. **Simultaneous SQLite writes** from the worker and an HTTP handler. One
   connection, `busy_timeout` set.
8. **Resource deletion order** — stop container, remove container, delete the
   Caddy route, remove volumes, delete the row. A crash mid-sequence must be
   recoverable by the reconciler.

## Role scopes are enforced by a hook, not by prompts

`CLAUDE.md` assigns each role a write scope, but agent frontmatter `tools:`
restricts _which tools_, not _which paths_ — and there is no path field in
frontmatter. The scopes were therefore advisory until
`.claude/hooks/scope-guard.ts` existed.

The hook runs as `PreToolUse` and keys off `agent_type`, which Claude Code
includes only when a hook fires inside a subagent. Main-thread calls carry no
`agent_type` and are deliberately left ungated — the human driving the session
is not the thing being gated.

It also screens `Bash` for file-writing constructs (`sed -i`, redirects, `cp`,
`git checkout`). Without that, any role holding Bash could edit anything and walk
straight around its scope. The screen is deliberately blunt: it denies the
command rather than parsing a target path out of a shell string, which is not
reliably possible.

Fails open on a malformed payload — a broken guard must not block all work.

## The RAM gate is real

`bun run gate:rss` builds the binary, boots it, idles, measures RSS, and exits
non-zero above 100MB. `scripts/measure-rss.ts` replaces the `ps`/`pgrep`
one-liner sketched in `PHASES.md`, which does not run on Windows and measures
whatever process it happens to find rather than booting one.

**Baseline: 55.7MB idle** — hello-world Elysia, compiled with
`--compile --minify --sourcemap`, measured 2026-08-23. That leaves roughly 44MB
of headroom for everything else. Re-measure after any dependency addition.
