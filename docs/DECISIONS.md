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

### Spike outcome — raw `fetch` wins (2026-08-23)

**Verdict: raw `fetch` over the unix socket. `dockerode` is not used and must not
reappear.** Both options passed all five steps, so this is §5's explicit
tiebreaker ("if both work, prefer Option B"), not a disqualification.

**What each did on step 4, the log stream.** Both decoded frames correctly under
Bun — the anticipated failure did not materialise. `dockerode`'s
`modem.demuxStream` worked and wrote into two `PassThrough` streams; raw `fetch`
demultiplexed the same frames from a `ReadableStream` reader in ~25 lines. One
asymmetry: `dockerode`'s stream never emitted `end` when the follow was torn down
(`end event: false`), so cleanup relies on `destroy()`; with raw `fetch`,
`AbortController` released the reader cleanly and the connection closed while
subsequent API calls kept working.

**Why B, given both work.** `dockerode` costs 72 packages and 20MB of
`node_modules`, and pulls in `protobufjs`, whose blocked `postinstall` runs
`node scripts/postinstall` — a dependency that wants a Node binary is a poor fit
for a single-binary compile. Compiled with `--compile --minify`, Option A bundles
213 modules against Option B's 1. Both binaries ran correctly, so this is about
long-term surface area, not breakage.

**Framing verified against the daemon, not assumed.** A 200-line/3000-byte-payload
container produced 603,000 bytes in 200 frames, consumed exactly with no drift.
Headers matched §6 precisely: `stream=1`, `pad=0`, length big-endian
(`[0,0,11,191]` = 3007). Those 603KB arrived in **12 chunks**, so frames
routinely span chunk boundaries — trap 1 confirmed in the wild, and buffering is
mandatory rather than theoretical.

**Findings that shape the client:**

- `AbortController` **does** close the socket — `streamLogs` can rely on it for
  the SSE-disconnect cleanup that trap 5 depends on.
- The response body streams; it is not buffered. An image pull produced 126
  progress lines over 101 chunks.
- The `unix:` option accepts an **arbitrary socket path** (verified via a symlink),
  so `MOSDASH_DOCKER_SOCKET` is viable.
- **Pin the API version in the path.** The daemon reports `1.55` but serves
  `/v1.44/` requests fine; unversioned URLs would shift under a daemon upgrade.

**Environment proven in:** Ubuntu 24.04.4 LTS (WSL2, kernel 5.15.167.4), Docker
Engine 29.7.2, Bun 1.4.0, non-root user in the `docker` group. Note the Windows
host runs Bun 1.3.14; the Linux number is the one that counts, since it matches
the deployment target.

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

## Phase 1 deviations from PHASES.md (2026-08-23)

Five decisions taken before Phase 1 implementation. Each resolves a genuine
conflict or gap in the spec, and each is recorded because it **deviates from
PHASES.md as literally written** — CLAUDE.md requires deviations to live here.

### D1 — The Linux development environment is WSL2 Ubuntu 24.04

Bun on Windows cannot reach Docker Desktop at all: the endpoint is a named pipe
(`npipe:////./pipe/dockerDesktopLinuxEngine`), and `fetch({ unix })` needs a real
unix socket. Probing both pipe path forms and TCP 2375 failed on all three.

Docker Engine is therefore installed **natively inside a WSL2 Ubuntu 24.04
distro** (not via Docker Desktop's WSL integration), giving a genuine
`/var/run/docker.sock` and matching the §16 deployment target. Run mosdash from
the Linux filesystem, not `/mnt/d/` — the 9p mount is slow and breaks file
watching.

Roughly half of Phase 1 (the Docker client, deploy job, Caddy, the swap, the
reconciler) cannot be verified on Windows. Those acceptance criteria are marked
`[manual, linux]` so a builder cannot claim verification it did not perform.

### D2 — mosdash stays a host binary; health checks dial container IPs

§9's health gate and §18's `MOSDASH_CADDY_ADMIN` default
(`http://mosdash-caddy:2019`) both assume container-name DNS, which only resolves
from inside the user-defined network. But §17's `install.sh` puts mosdash on the
host with a mounted socket.

**Resolution: mosdash remains a host process.** The health gate resolves the
container's IP from `inspect` rather than its name, and Caddy's admin API is
published loopback-only, so `MOSDASH_CADDY_ADMIN` defaults to
`http://127.0.0.1:2019`. This keeps `install.sh`, socket access, and the RSS
measurement method exactly as specified. Containerising mosdash would have
changed all three, and would have meant measuring RSS inside a container.

The admin API is still never exposed beyond loopback (§12).

**Amendment (2026-08-24): `-p 127.0.0.1:2019:2019` alone does not work.** Caddy
binds its admin API to `localhost:2019` _inside_ the container by default, so the
port mapping forwards to a listener that rejects it. Verified against a real
daemon: without `CADDY_ADMIN`, `curl http://127.0.0.1:2019/config/` returns
connection refused; with `-e CADDY_ADMIN=0.0.0.0:2019` it returns 200. Every
deploy carrying a domain therefore failed with `cannot reach the Caddy admin API`,
and `scripts/install.sh` reproduces this on every production install.

The env var is the _implementation_ of the resolution above, not a deviation from
it: only the container-internal bind widens. The host-side binding stays
`127.0.0.1`, so nothing is reachable off-box and §12 is preserved. This matches
§10, which already specifies the listen address as `0.0.0.0:2019`.

This survived the Phase 1 checks because, as recorded above, the Caddy route
switch under a real domain was never exercised.

### D3 — Caddy routes the dashboard, with a first-run IP fallback

§12 says bind `127.0.0.1` and route through Caddy; §16 step 2 says open
`https://<server-ip>:8000` to create the admin account. On a fresh install
nothing is routing yet, so those conflict.

**Resolution: `install.sh` creates a Caddy route for the dashboard on its own
subdomain from the start.** To avoid locking out an install whose DNS is not yet
propagated — and to match the Coolify experience of reaching the dashboard by IP
— mosdash binds `0.0.0.0:8000` while the `users` table is empty, then binds
`127.0.0.1` once an admin exists. The insecure window is exactly one account
creation, and it closes automatically.

### D4 — `MOSDASH_ACME_STAGING` defaults to `true`

§18 defaults it `false`, but §21 and this file both say to use the Let's Encrypt
staging endpoint during development, always. A `false` default means the first
careless dev run burns real certificates against a limit of 50 per registered
domain per week.

**Resolution: default `true`.** Production is the deliberate case, so
`install.sh` sets `MOSDASH_ACME_STAGING=false` explicitly. Safe by default;
impossible to burn the rate limit by accident.

### D5 — `src/routes/**` ownership convention

CLAUDE.md's role table assigns `src/routes/` to the UI-Builder, but
`.claude/hooks/scope-guard.ts` also permits the Core-Builder there — its
`EXCLUSIONS` list only blocks `src/views/**`. The hook permits what the table
forbids.

**Resolution, by convention rather than by tightening the hook:** the
Core-Builder writes route handlers that enqueue jobs, query, and return data; the
UI-Builder writes anything that renders a template. Slices straddling the seam
(auth, resources) name the owning role per file in their spec.

### Also settled

- **ULIDs via a ~30-line helper**, not the `ulid` package. §7 permits either; the
  helper costs nothing against the RSS budget.
- **Hand-written `.sql` migrations**, not `drizzle-kit generate` — §2 forbids
  migration DSL beyond Drizzle's basics. `drizzle-kit` stays a devDependency for
  inspection only.

## Phase 1 outcome (2026-08-23)

Built and verified end to end against a real Docker daemon on Ubuntu 24.04
(WSL2), running the compiled binary rather than `bun run dev`.

**Measured idle RSS: 50.7MB** — compiled with `--compile --minify --sourcemap`,
booted, idled 60s. That is roughly half the 100MB ceiling. Under a full workload
(several deploys, live log streaming, the reconciler looping) it sat at 63.0MB
and settled back to 60.0MB, so nothing is being retained across deploys.

Earlier baselines for comparison: 55.7MB on Windows, 26.6MB on Linux for the
hello-world scaffold; adding zod and pino cost about 8MB.

### Two bugs the end-to-end run caught

Both worked in isolation and failed only against the real thing, which is the
argument for verifying on a live daemon rather than trusting unit tests.

- **CSRF middleware called `request.clone().formData()`.** Elysia has already
  consumed the body by `onBeforeHandle`, so every POST threw
  `ERR_BODY_ALREADY_USED` and returned 500. The token is now read from the
  parsed `body`, and the five routes that had no body schema gained
  `t.Object({ csrf: t.String() })` so the token is present to check.
- **`previous_image` was never recorded, so rollback had no target.** The deploy
  job read the outgoing image from the resource row, but editing the image in
  Settings writes the _new_ image to that row before the job runs — so the
  outgoing image read back as the incoming one and the "different image" test
  never fired. It now reads the image from the container that is actually
  serving, captured before anything replaces it.

A third finding was a test artifact, not a bug: an availability probe pinned to
one container's IP counted failures after that container was deliberately
removed post-drain. Following the current serving container, the way a proxy
route does, shows zero gaps.

### Verified

19/19 end-to-end checks, plus zero-downtime and self-healing:

- Admin setup, login, session revocation, CSRF rejection (403 on a bad token)
- Project with an automatic `production` environment; resource CRUD
- Resource-name and image-reference validation both reject bad input
- Env vars absent from the database file in plaintext, present in the container
- Deploy handler returns in **10ms** — it enqueues and redirects, never awaits Docker
- Container carries all four `mosdash.*` labels, a 256MB cap, and `Tty:false`
- **Zero failed requests across a redeploy** (§16 step 9)
- Rollback returns the previous image (§16 step 10)
- Reconciler restores a `docker rm -f`'d container within 30s (§16 step 11)
- The compiled binary runs migrations, renders templates and serves assets —
  trap 6 confirmed handled via static text imports

Not verified here, because they need a public host with DNS: Let's Encrypt
issuance, the Caddy route switch under a real domain, and a full server reboot
(§16 steps 8 and 12).

## Slice A deviations from PHASES.md (2026-08-24)

### D6 — Locally-built images deploy, and prune cannot be told to spare them

§9 step 3 (`PHASES.md:436`) says "Pull the image", unconditionally. That makes an
image built on the box with `docker build` undeployable: the Engine answers
`POST /images/create?fromImage=demo-app&tag=v1` with a 404, verified against a
real daemon. Phase 2 will build images from source, but until then the only way
to run one's own code is to bring an image, and requiring a registry for that is
a needless obstacle on a single-server product.

**Resolution: try the pull, and fall back to the local image only when
`docker.imageExists()` confirms it is present.** The gate is deliberately
`imageExists` and not the 404 status. A private image whose registry credentials
have lapsed returns exactly the same 404, so branching on the status alone would
silently deploy a stale local copy while the operator believes they pulled a
fresh one — a wrong-version deploy that reports success. Any thrown pull error
qualifies for the probe, not just a 404, because `pullImage` also throws for
in-stream errors and for an unreachable daemon. `:latest` against a working
registry is unaffected: the pull succeeds and the fallback never runs.

§18's prune (`PHASES.md:618-620`) says "remove dangling images and images unused
for more than 168 hours". Taken literally that reclaims rollback targets. An
image referenced only by `resources.previous_image` is invisible to Docker — no
container uses it — so the old `dangling: ["false"]` filter deleted it at 168h
and rollback worked for a week and then did not.

The Engine offers no way to exempt an image list: `filters={"reference":[...]}`
is rejected outright (`400 invalid filter 'reference'`), and `label!=` is
inapplicable because mosdash does not build these images and cannot label them.
Both verified against a real daemon.

**Resolution: dangling-prune plus selective removal.** `/images/prune` is
narrowed to `dangling: ["true"]` — an untagged image can never be a rollback
target — and tagged images are enumerated and removed individually, skipping any
whose tags intersect a keep-set derived from `resources`. Two consequences worth
recording: one image ID can carry several tags and removing by one tag only
_untags_ it, so an image is protected if **any** of its tags is protected and its
bytes are only counted once every tag is gone; and historical `deployments` rows
are deliberately **not** protected, since the UI offers only `previous_image` as
a rollback target.

### D7 — mosdash owns the Caddy container, and adopts one it did not create

`scripts/install.sh` created the proxy with `docker run` at install time. That put
the container definition in shell, where it ran exactly once and drifted: the D2
amendment (`CADDY_ADMIN=0.0.0.0:2019`) could be fixed in the installer and still
leave every already-installed box broken, and `docker rm -f mosdash-caddy` was
unrecoverable without re-running the installer. Separately, `ensureBaseConfig()`
had no caller at all, so `srv0` never existed and `upsertRoute` POSTed 404 even
against a reachable Caddy — an independent defect the same absent bootstrap
explains.

**Resolution: an `ensure_caddy` job owns the proxy.** `src/caddy/bootstrap.ts`
ensures the network, both named volumes, the container, its start, a bounded
readiness poll on the admin API, and finally `ensureBaseConfig()`. It is enqueued
at boot and re-enqueued by the reconciler whenever no running `mosdash-caddy` is
present, so removing the proxy heals within 30 seconds. `install.sh` keeps only
the volume creation.

Consequences of note:

- **Discovery is by container name, not by label.** A proxy from an older install
  carries no `mosdash.*` labels and is invisible to a `managed=true` filter; a
  label lookup would conclude nothing is there and try to bind `:80` twice. The
  Engine's name filter substring-matches (verified against a real daemon:
  filtering `caddy` returns `/caddy`), so `findContainersByName` compares exact
  names after stripping the leading slash.
- **An existing container is adopted, never recreated.** It is holding live TLS
  connections. If an adopted container fails the readiness poll — which every
  pre-amendment container will, its admin API being bound inside the container —
  the error names `CADDY_ADMIN=0.0.0.0:2019` as the cause and `docker rm -f
mosdash-caddy` as the fix. Destroying an operator's running proxy unasked is
  worse than a clear error.
- **The volume names `mosdash-caddy-data` / `mosdash-caddy-config` are frozen.** A
  new name means an empty certificate store, re-issuance of everything, and a
  burnt Let's Encrypt rate limit.
- **The proxy's memory cap is hardcoded at 512MB**, deliberately not
  `MOSDASH_DEFAULT_MEMORY_MB`. That setting is the default for user apps; lowering
  it to fit more apps on a small box must not throttle the component they are all
  served through.
- **The sidecar carries `mosdash.managed=true` + `mosdash.role=proxy` and no
  resource id.** A synthetic resource id would resolve to no row, which is exactly
  what the orphan sweep deletes. Both sweeps (`reconciler.ts`, `jobs/index.ts`)
  now skip on `mosdash.role` explicitly, ahead of the resource-id check that
  spares it today by coincidence — relying on that coincidence is one refactor
  away from mosdash force-removing its own proxy every 30 seconds.
- **The reconciler's re-enqueue uses a time-bucketed job id.** `enqueue` inserts
  without `OR IGNORE`, so a duplicate id throws; that conflict is caught and read
  as "already queued", which is what stops the tick crashing every 30s while the
  proxy is down. The id is bucketed rather than constant because `complete()`
  leaves the row as `done` under the same id and `pruneFinishedJobs` only clears
  it after 168 hours — a constant id would collide with its own completed row, so
  the self-heal would fire once per install and never again. `maxAttempts` is 1:
  concurrency is exactly 1, and a bootstrap retrying internally while Docker is
  down occupies the worker that user deploys are queued behind.

**Amendment to the zero-downtime guarantee.** `deploy.ts` destroyed the new
container on _any_ error, including a Caddy failure, after which the reconciler
re-enqueued the deploy every 30 seconds — an unbounded loop. The drain step is now
gated on the route switch having succeeded (the literal enforcement of "the old
container is never stopped until the new one passes the health gate _and_ the
Caddy route has switched"), and the failure path distinguishes the two cases: a
failure before the switch removes the new container, a failure of the switch
itself keeps the healthy container and says traffic is unchanged. The resource row
is not repointed at a kept-but-unrouted container, so the reconciler still sees
the old container matching the row and does not redeploy.

## Slice C — the readiness poll was asking the wrong question (2026-08-24)

Three defects, one root cause: `waitForAdmin` asked "does _anything_ answer on
127.0.0.1:2019?" and treated the answer as proof that the container mosdash had
just started was serving. It is proof of neither, and it asked without a clock.

**Amendment to the readiness poll.** That host port is reachable by any process
on the box, so a stale Caddy or a host-installed caddy service answers 200 while
the container is dead; and Caddy's admin API comes up independently of its HTTP
servers, so a Caddy whose `srv0` failed to bind `:80` answers 200 throughout.
mosdash logged "started Caddy" in both. The poll now asks in order:
`inspectContainer` says the container mosdash started is running — the only one
of the three that is evidence about _that_ container, the others being evidence
about whatever holds the port; the admin API answers; and, after
`ensureBaseConfig()` has guaranteed `srv0` exists, a real connection to `:80` is
accepted. Placing the bind check _after_ the config install is deliberate: before
it, an empty config on a fresh `--resume` volume is legitimate and
indistinguishable from a failed bind, so the check would have no single correct
answer. A container mosdash created that has already restarted fails immediately
rather than being polled — Caddy exits when it cannot bind, `unless-stopped`
turns that into a loop, and the poll would otherwise catch it during an up-phase.
The adopted path deliberately skips that check: an operator's proxy that has been
up for months across a reboot legitimately has restarts.

**Every admin-API call is now bounded at 5 seconds.** `ping()` used a bare
`fetch`, and `waitForAdmin` checked its 30-second deadline only _after_ that
fetch resolved — so a half-open connection blocked forever. Concurrency is
exactly 1 and the worker awaits its handler with no timeout, so this parked every
user deploy behind it indefinitely; the 15-minute lease is no rescue, because
`recoverExpiredLeases()` runs only at `startWorker()`. **This was the "stuck job"
observed on 2026-08-24.** Measured against a socket that accepts and never
replies: `ping()` returned `false` in 5002ms instead of never. The bound is on
`request()` rather than `ping()` alone because `upsertRoute` sits on the deploy
critical path and has the identical hang shape. A general worker-level timeout
was rejected: `Promise.race` does not cancel the losing handler, so it would
leave one running while the loop claimed the next job, silently breaking the
concurrency-1 invariant. Making `recoverExpiredLeases()` periodic is the correct
general fix and is deferred to its own slice.

**A running container is not a reachable one — `publishedPortCount`.** The
sharpest finding of the verification run, and one not anticipated when the slice
was planned. When a published host port is already held, the Engine starts the
container anyway and simply leaves the mapping unprogrammed:
`HostConfig.PortBindings` is correct while `NetworkSettings.Ports` is `{}`. Caddy
is then alive and healthy _inside_ the container while nothing on the host can
reach it. Gate 1 passes, gate 2 can never succeed, and the adopted-path error
blamed a missing `CADDY_ADMIN` after burning the full 30 seconds — the wrong fix
entirely. `ContainerState` gained `publishedPortCount`, counting only mappings
the Engine actually programmed (an unbindable port is present as a key with a
`null` value, not absent), and the poll fails on running-with-zero-published-ports
with a message naming the ports to check. Verified: 30186ms and a misdiagnosis
became 21ms and the right one.

**`ensureBaseConfig` now checks for `srv0` specifically, not for any `apps` key.**
Every `upsertRoute` POSTs to `/config/apps/http/servers/srv0/routes/`, so a config
resumed from an autosave carrying an http app under a different server name left
mosdash unable to add a single route while `ensureBaseConfig` reported nothing to
do. The consequence is recorded plainly: `POST /load` replaces the entire
configuration, so a hand-edited config lacking `srv0` is now overwritten where
before it was preserved. That is the correct trade — preserved-but-broken made
mosdash unusable — but it is not silent: a warning names the replacement first.

**The reconciler's re-enqueue gate moved from "running" to "answering".** Gating
on the Docker running flag was the same mistake one layer up: a Caddy in a
bind-failure restart loop, or one wedged with a dead admin API, reads as running,
so the bootstrap — the only thing that can repair it — was never re-queued and
the hardened poll would never run again. The gate is `caddy.ping()`, deliberately
not the full serving probe: it runs every 30 seconds forever, it must not flap,
and the bootstrap does the thorough diagnosis once queued. One case remains
undetected by design — running, admin answering, `srv0` not bound — because
catching it means a `:80` probe every tick; the bootstrap repairs it whenever it
next runs.

**`queueCaddyBootstrap` no longer swallows every error.** A primary-key conflict
_is_ the answer ("this bucket already holds a row"), but a locked database or a
full disk is a real failure that must not vanish — it presents to the operator as
"no site loads and nothing in the log". Matched on `SQLITE_CONSTRAINT` with a
message fallback.

**`maxAttempts` stays at 1.** Reconsidered and kept. A bootstrap retrying with
backoff occupies the single worker that user deploys are queued behind; the
recovery path is the reconciler's 5-minute bucket, which the gate change above is
what makes actually fire. Observed cost: after a failure, self-heal waits for the
next bucket boundary — up to 5 minutes with the proxy down. That is the accepted
D7 trade, now measured rather than assumed.

**Still not surfaced in the UI.** A failed bootstrap remains a `logger.warn` at
the job boundary: the `ensure_caddy` payload carries no `deploymentId`, so there
is no row to attach a failure to. The error messages were made specific instead —
each names the gate that failed and the command to run (`ss -ltnp`,
`docker logs mosdash-caddy`), which is what an operator on a self-hosted box
actually reads. A system-status surface is its own slice.

### Verified against a real daemon (2026-08-24, WSL2 Ubuntu 24.04, Engine 29.7.2)

- Happy path unregressed: proxy rebuilt from nothing in **1363ms**, 0 restarts,
  `srv0` with `[":80",":443"]`, admin 200, `:80` 200, certificates preserved.
- `ping()` against a blackhole socket: **false in 5002ms**, not never.
- A foreign 200-answering listener on `:2019`: bootstrap **failed** instead of
  reporting success.
- `:80` and `:2019` conflicts, created path: **622ms and 21ms**, each naming the
  conflict rather than timing out.
- `srv0` deleted with `apps` left in place: the tightened check **repaired** it and
  `:80` went from refused to 200. The old truthiness check would have returned.
- **Route switch and HTTPS proven without public DNS**, via Caddy's `internal`
  issuer and `curl --resolve`: `web-production.lvh.test` served nginx, and against
  Caddy's extracted local root, `--cacert` gave **`verify=0`** — a fully verified
  chain.
- **Zero-downtime redeploy (§16 step 9): 400/400 requests returned 200** across a
  swap from `nginx:alpine` to `nginx:1.27-alpine`, upstream moving
  `172.18.0.4` → `172.18.0.2`. Zero failures.
- Idle RSS under `bun run` (not the smaller compiled binary): **69.1MB**.

**Still unverified, and not claimed.** Let's Encrypt issuance (§16 step 8) and a
full server reboot (§16 step 12). This box is private RFC1918 only, so ACME cannot
reach it — an internal issuer stands in for everything about the HTTPS path
_except_ issuance itself, and issuance is not what this slice touched. There is
also no systemd unit here, so the reboot criterion has nothing to exercise.

**One caution recorded from the test run.** Forcing a host-port conflict left the
Engine with a container whose bindings were configured but unprogrammed, and a
`docker restart` did not repair it — only a daemon restart did. That is Engine
behaviour, not mosdash's, but it is the state `publishedPortCount` now detects
and reports rather than misdiagnosing.

## Slice D — the build daemon, and two ways a sidecar lies about being ready (2026-08-24)

Phase 2 begins with BuildKit rather than with GitHub. §26 narrates the other
order — connect an App, pick a repo, push — but two things in Phase 2 cannot be
verified on a private RFC1918 box, and both are _inbound HTTP_: GitHub's redirect
back from the manifest flow, and its webhook POST. Building GitHub first would
put both at the bottom of the stack, so every later failure would have two
candidate causes. Inverted, the build pipeline is proven against a real daemon
before anything unverifiable is touched, and DoD 3, 4, 7, 8 and 9 are all
reachable without GitHub existing at all.

### D8 — BuildKit is a managed sidecar, and `privileged` is gated at the client

BuildKit runs as a container mosdash owns, exactly as Caddy does: adopted by
name if present, created if not, re-queued by the reconciler when it goes. The
bootstrap is a deliberate structural clone of `src/caddy/bootstrap.ts`, because
the failure modes are identical and that module is the product of a slice spent
learning them.

**`ContainerSpec` gained `privileged`, and `createContainer` refuses it on any
spec without a `mosdash.role` label.** A privileged container is root on the
host, so the flag is a privilege boundary rather than a tuning knob, and the
check is enforced in the client instead of trusted to callers — it is one line,
and what it prevents is a user reaching root on the box. Verified three ways: a
resource-labelled spec asking for privileged is refused, the same spec without
it is accepted (the guard is not over-broad), and a `sidecarLabels("builder")`
spec with it is allowed. There is deliberately no UI for it.

**`DockerClient` gained `loadImage(tar: ReadableStream)`.** A standalone BuildKit
container does not share the Engine's image store, so a build's output comes back
as a tarball that has to be handed to the daemon. The parameter is a stream and
never a Buffer: an image tar is routinely hundreds of megabytes and buffering one
would breach the RAM budget outright. This was the risk flagged as the largest in
Phase 2, so it was prototyped before any other code in the slice — and it works.
Measured end to end: a 3.6MB tarball cost **4.1MB of RSS**, proportional to the
buffer rather than to the image, and the loaded image ran. No spool-to-disk
fallback was needed. Like `/images/create`, `/images/load` reports failure inside
a 200 response, so the body is read to completion and inspected rather than
trusting the status.

### Two false-ready bugs, both found by testing rather than by reading

**The image's entrypoint is already `buildkitd`.** Passing
`["buildkitd", "--addr", ...]` as the command produced `buildkitd buildkitd
--addr ...`, where the stray argument is silently ignored and the daemon falls
back to its default unix socket. The container starts, logs a healthy worker,
reports 0 restarts — and is unreachable over TCP. `command` therefore carries
**flags only**, and the comment says so, because nothing about the running
container reveals the mistake.

**A TCP connect proves nothing when a port is published.** The first readiness
probe opened a socket and returned true if it connected. Docker's userland proxy
binds the host side of a published port and accepts connections whether or not
anything is listening inside the container, so that probe passed against the
broken daemon above — the exact false success the Caddy slice was spent
eliminating, reproduced one module later. `fetch` cannot stand in either: Bun's
client is HTTP/1.1, BuildKit's gRPC server requires HTTP/2, and a fetch-based
probe returns false against a _healthy_ daemon. Verified both directions before
committing to the fix.

The probe now writes the HTTP/2 client connection preface and waits for any
inbound byte. A gRPC server must answer it with a SETTINGS frame; a port
forwarder with nothing behind it cannot. Measured: `data=false` against the
broken daemon, `data=true` against a working one. Shelling out to
`docker exec ... buildctl` was rejected despite being simpler — it bypasses the
`DockerClient` interface and assumes a local socket, which the SSH implementation
in a later phase would break.

### The bucketed job id sets a blind window, and 5 minutes is wrong for a builder

The reconciler re-queues with a time-bucketed id so a burst of ticks collapses to
one job. The cost is that once a bucket holds a _finished_ row, the id collides
with it and nothing can be re-queued until the bucket rolls over. For the proxy
that is the accepted D7 trade. For a build daemon it is the wrong one: BuildKit
is removed routinely — a prune, an upgrade, an operator clearing disk — and while
it is down nothing already serving is affected. Observed directly: after the
container was removed, four consecutive reconciles logged "queueing bootstrap"
and queued nothing, because the bucket already held a completed row.

BuildKit's bucket is therefore **one minute**, which collapses a tick burst just
as well and bounds the blind window to two reconcile passes. The outage log line
is also latched to once per outage rather than once per tick — an unguarded line
repeats every 30 seconds while nothing happens, burying the one line an operator
needs. Measured after the fix: **self-heal in 15 seconds** from `docker rm -f`,
0 restarts, one log line.

Its gate is the running flag alone, not the full readiness probe. The probe
opens a socket and waits, the reconciler runs every 30 seconds forever, and a
build daemon being down is not an outage — so it is logged at info, not warn.

### Verified against a real daemon (2026-08-24, WSL2 Ubuntu 24.04, Engine 29.7.2)

- Bootstrap from nothing: **49.4s** including the image pull; the next tick took
  the adopted path in **59ms**.
- Container state: privileged, 1GB cap, `mosdash.managed=true` +
  `mosdash.role=builder`, port published to **127.0.0.1 only**, 0 restarts.
- `buildctl debug workers` over TCP lists a real worker.
- Self-heal after `docker rm -f`: **15s**, 0 restarts, one log line.
- Privilege guard: refused on a resource spec, accepted on a sidecar spec, and
  not over-broad on a non-privileged resource spec.
- `gate:rss`: **78.3MB** against a 78.7MB baseline — no measurable change, as
  expected for a component that is a container.
- **BuildKit idles at 12.2MiB, not the ~30MB estimated in PHASES §30.**
  `scripts/measure-rss.ts` was corrected to report the measured figure; never
  quote a sidecar number that is a guess.

### Still unverified, and not claimed

Nothing here proves a build. `loadImage` is proven against a tarball BuildKit
produced, but the build pipeline that will call it — Railpack, the Dockerfile
frontend, build-arg redaction, build-directory cleanup — is the next checkpoint.
Railpack is not installed on this box, and installing it is a step of that
checkpoint rather than an assumption of this one.
