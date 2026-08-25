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
  so `MUSDASH_DOCKER_SOCKET` is viable.
- **Pin the API version in the path.** The daemon reports `1.55` but serves
  `/v1.44/` requests fine; unversioned URLs would shift under a daemon upgrade.

**Environment proven in:** Ubuntu 24.04.4 LTS (WSL2, kernel 5.15.167.4), Docker
Engine 29.7.2, Bun 1.4.0, non-root user in the `docker` group. Note the Windows
host runs Bun 1.3.14; the Linux number is the one that counts, since it matches
the deployment target.

## Reverse proxy — Caddy

Caddy runs as a container musdash manages, on the shared `musdash` network so it
resolves app containers by name via Docker's embedded DNS. Routes are managed by
PATCHing its JSON admin API, using `@id` for addressable objects so each route
can be replaced or deleted independently.

- The admin API binds to the musdash network only, **never published to the
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

Each musdash instance registers its own App via the manifest flow — POST a
manifest, the user confirms, GitHub redirects back with a code, exchange it for
credentials. Store the private key encrypted with the same key used for env vars.

Auth is a JWT signed with the App's RSA key (10-minute expiry), exchanged for an
installation access token (1-hour expiry, scoped to selected repos), cached in
memory by installation id. Use `@octokit/app`; do not hand-roll it.

Webhooks: **verify the HMAC-SHA256 signature before parsing the body**, respond
`202` immediately and enqueue the work — GitHub times out at 10 seconds.

The manifest subscribes to `push` and nothing else. `installation` and
`installation_repositories` are lifecycle events GitHub delivers to every App
automatically and — because no permission covers them — rejects outright in
`default_events`: including them makes the whole manifest invalid, which GitHub
reports as "not a valid GitHub App manifest". `routes/github.ts` still handles
both deliveries.

## Builds — Railpack, not Nixpacks

Zero-config builds use Railpack. Nixpacks is in maintenance mode and its own
authors recommend Railpack as the replacement; Railpack is Go-based, interfaces
directly with BuildKit, and produces substantially smaller images (~38% smaller
for Node, ~77% for Python).

BuildKit runs as a container musdash manages, the same way it manages Caddy, with
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

musdash's actual job is a **YAML transform pipeline**: parse, then reject
dangerous constructs with a clear error (`privileged: true`, `network_mode: host`,
docker-socket mounts, bind mounts to sensitive host paths) rather than silently
stripping them; then inject the shared network, `musdash.*` labels,
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

The user pastes an IP and adds musdash's public key. Nothing to install, version,
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
`/var/run/docker.sock` and matching the §16 deployment target. Run musdash from
the Linux filesystem, not `/mnt/d/` — the 9p mount is slow and breaks file
watching.

Roughly half of Phase 1 (the Docker client, deploy job, Caddy, the swap, the
reconciler) cannot be verified on Windows. Those acceptance criteria are marked
`[manual, linux]` so a builder cannot claim verification it did not perform.

### D2 — musdash stays a host binary; health checks dial container IPs

§9's health gate and §18's `MUSDASH_CADDY_ADMIN` default
(`http://musdash-caddy:2019`) both assume container-name DNS, which only resolves
from inside the user-defined network. But §17's `install.sh` puts musdash on the
host with a mounted socket.

**Resolution: musdash remains a host process.** The health gate resolves the
container's IP from `inspect` rather than its name, and Caddy's admin API is
published loopback-only, so `MUSDASH_CADDY_ADMIN` defaults to
`http://127.0.0.1:2019`. This keeps `install.sh`, socket access, and the RSS
measurement method exactly as specified. Containerising musdash would have
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
— musdash binds `0.0.0.0:8000` while the `users` table is empty, then binds
`127.0.0.1` once an admin exists. The insecure window is exactly one account
creation, and it closes automatically.

### D4 — `MUSDASH_ACME_STAGING` defaults to `true`

§18 defaults it `false`, but §21 and this file both say to use the Let's Encrypt
staging endpoint during development, always. A `false` default means the first
careless dev run burns real certificates against a limit of 50 per registered
domain per week.

**Resolution: default `true`.** Production is the deliberate case, so
`install.sh` sets `MUSDASH_ACME_STAGING=false` explicitly. Safe by default;
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
- Container carries all four `musdash.*` labels, a 256MB cap, and `Tty:false`
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
inapplicable because musdash does not build these images and cannot label them.
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

### D7 — musdash owns the Caddy container, and adopts one it did not create

`scripts/install.sh` created the proxy with `docker run` at install time. That put
the container definition in shell, where it ran exactly once and drifted: the D2
amendment (`CADDY_ADMIN=0.0.0.0:2019`) could be fixed in the installer and still
leave every already-installed box broken, and `docker rm -f musdash-caddy` was
unrecoverable without re-running the installer. Separately, `ensureBaseConfig()`
had no caller at all, so `srv0` never existed and `upsertRoute` POSTed 404 even
against a reachable Caddy — an independent defect the same absent bootstrap
explains.

**Resolution: an `ensure_caddy` job owns the proxy.** `src/caddy/bootstrap.ts`
ensures the network, both named volumes, the container, its start, a bounded
readiness poll on the admin API, and finally `ensureBaseConfig()`. It is enqueued
at boot and re-enqueued by the reconciler whenever no running `musdash-caddy` is
present, so removing the proxy heals within 30 seconds. `install.sh` keeps only
the volume creation.

Consequences of note:

- **Discovery is by container name, not by label.** A proxy from an older install
  carries no `musdash.*` labels and is invisible to a `managed=true` filter; a
  label lookup would conclude nothing is there and try to bind `:80` twice. The
  Engine's name filter substring-matches (verified against a real daemon:
  filtering `caddy` returns `/caddy`), so `findContainersByName` compares exact
  names after stripping the leading slash.
- **An existing container is adopted, never recreated.** It is holding live TLS
  connections. If an adopted container fails the readiness poll — which every
  pre-amendment container will, its admin API being bound inside the container —
  the error names `CADDY_ADMIN=0.0.0.0:2019` as the cause and `docker rm -f
musdash-caddy` as the fix. Destroying an operator's running proxy unasked is
  worse than a clear error.
- **The volume names `musdash-caddy-data` / `musdash-caddy-config` are frozen.** A
  new name means an empty certificate store, re-issuance of everything, and a
  burnt Let's Encrypt rate limit.
- **The proxy's memory cap is hardcoded at 512MB**, deliberately not
  `MUSDASH_DEFAULT_MEMORY_MB`. That setting is the default for user apps; lowering
  it to fit more apps on a small box must not throttle the component they are all
  served through.
- **The sidecar carries `musdash.managed=true` + `musdash.role=proxy` and no
  resource id.** A synthetic resource id would resolve to no row, which is exactly
  what the orphan sweep deletes. Both sweeps (`reconciler.ts`, `jobs/index.ts`)
  now skip on `musdash.role` explicitly, ahead of the resource-id check that
  spares it today by coincidence — relying on that coincidence is one refactor
  away from musdash force-removing its own proxy every 30 seconds.
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
127.0.0.1:2019?" and treated the answer as proof that the container musdash had
just started was serving. It is proof of neither, and it asked without a clock.

**Amendment to the readiness poll.** That host port is reachable by any process
on the box, so a stale Caddy or a host-installed caddy service answers 200 while
the container is dead; and Caddy's admin API comes up independently of its HTTP
servers, so a Caddy whose `srv0` failed to bind `:80` answers 200 throughout.
musdash logged "started Caddy" in both. The poll now asks in order:
`inspectContainer` says the container musdash started is running — the only one
of the three that is evidence about _that_ container, the others being evidence
about whatever holds the port; the admin API answers; and, after
`ensureBaseConfig()` has guaranteed `srv0` exists, a real connection to `:80` is
accepted. Placing the bind check _after_ the config install is deliberate: before
it, an empty config on a fresh `--resume` volume is legitimate and
indistinguishable from a failed bind, so the check would have no single correct
answer. A container musdash created that has already restarted fails immediately
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
musdash unable to add a single route while `ensureBaseConfig` reported nothing to
do. The consequence is recorded plainly: `POST /load` replaces the entire
configuration, so a hand-edited config lacking `srv0` is now overwritten where
before it was preserved. That is the correct trade — preserved-but-broken made
musdash unusable — but it is not silent: a warning names the replacement first.

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
`docker logs musdash-caddy`), which is what an operator on a self-hosted box
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
behaviour, not musdash's, but it is the state `publishedPortCount` now detects
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

BuildKit runs as a container musdash owns, exactly as Caddy does: adopted by
name if present, created if not, re-queued by the reconciler when it goes. The
bootstrap is a deliberate structural clone of `src/caddy/bootstrap.ts`, because
the failure modes are identical and that module is the product of a slice spent
learning them.

**`ContainerSpec` gained `privileged`, and `createContainer` refuses it on any
spec without a `musdash.role` label.** A privileged container is root on the
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
- Container state: privileged, 1GB cap, `musdash.managed=true` +
  `musdash.role=builder`, port published to **127.0.0.1 only**, 0 restarts.
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

## Checkpoint 2 — a directory becomes an image (2026-08-24)

Both build strategies now work end to end against a real BuildKit, from a
directory already on disk. Deliberately no GitHub: the build is the substance of
Phase 2's Definition of Done and the push is only the trigger, so proving it
against local fixtures removes it as a variable from every later checkpoint.
Five of the ten §26 criteria are met here, months before a webhook exists.

### D9 — two strategies, one redaction point, external binaries throughout

`railpack build DIRECTORY --name TAG` and `buildctl build --frontend
dockerfile.v0` are invoked with `Bun.spawn` (shell out, never reimplement).
Both are pinned and both are installed by `scripts/install.sh` rather than at
first use, so a missing one is a clear install-time failure instead of an ENOENT
inside somebody's first deploy. **`buildctl` is copied out of the BuildKit image
musdash already runs** — the client and daemon versions then match by
construction and there is no second download to keep in step.

The two strategies differ in one way that matters: **Railpack loads the finished
image into Docker itself, `buildctl` does not.** With a standalone BuildKit
container there is no shared image store, so the Dockerfile path writes
`type=docker,...,dest=` to a tarball and streams it back through
`DockerClient.loadImage`. The tarball goes to a file rather than piping the
subprocess straight into the daemon: piping works, but it couples two failures
into one unreadable state, since a load failing midway leaves the build
subprocess running and loses its error. The file lives in the build directory
that is deleted either way.

**Redaction is applied at one point, in `buildImage`, not in each strategy.** A
per-strategy redactor is one forgotten call away from leaking, and build args are
secrets as often as not. It reuses `redactValues` from the deploy pipeline rather
than growing a second redactor. Both pipes are also read concurrently: BuildKit
writes progress to stderr and results to stdout, and consuming them in sequence
deadlocks at the pipe buffer.

The layer cache lives in `data/build-cache/<resource>`, deliberately NOT inside a
build directory — those are deleted when their build ends and would take the
cache every time. Scoped per resource: one global key lets one app evict
another's layers, and a per-deployment key misses on every build.

### Build directories are deleted twice, on purpose

They are the second-largest disk leak after images and the leak is silent — a box
fills weeks later with nothing in the UI to explain it. So the build removes its
own directory in a `finally`, and `sweepBuildDirs` runs daily as the backstop for
a SIGKILL or an OOM that never ran one. Age-based rather than cross-referenced
against the deployments table: a build directory has no value once its build is
over, so "old" is the only question worth asking and it needs no database read.

### A verification that verified the transport, not the code

Checkpoint 1 recorded `loadImage` as proven because a prototype streamed a
tarball into `/images/load` and got a 200 with `Loaded image:` in the body. The
first real Dockerfile build then failed with "the tar was not in docker format"
against a tarball `docker load` accepted without complaint.

The transport was fine; the parser was wrong. `/images/load` reports through a
`stream` field, while `/images/create` uses `status` — and `parseProgress`, built
for the pull path, knows only the latter and returned an empty string for every
line. The prototype had printed the raw body and checked the HTTP status, so it
exercised the socket and never the code that reads it. **A prototype that proves
a transport has not proven the function built on it**, and the checkpoint-1 entry
claimed more than it had earned. `/images/load` is now parsed on its own terms.

### The canary that proved nothing, twice

DoD 9 asks that build-time secrets stay out of build logs, so the Dockerfile
fixture deliberately `RUN echo`s a build arg — the secret has to actually reach
the log for redaction to mean anything. Two runs reported zero leaks while also
reporting zero redactions, which is the signature of a test that never ran the
thing it claims to check: BuildKit was serving the layer from cache, so the RUN
never executed. `--no-cache` is now reachable through `BuildContext.noCache`,
which exists for verification rather than as a user-facing option.

The second false pass was the harness's own: it searched for `[REDACTED]` while
`redactValues` emits `[redacted]`. Redaction had been working the whole time and
the check was blind. Both directions are now confirmed by observing the actual
log lines.

### Verified against a real daemon (2026-08-24, WSL2, BuildKit v0.27.0, railpack 0.37.0)

- **DoD 3** — zero-config Node **and** Python built by Railpack, and both images
  serve HTTP 200 with the expected body. Not merely built: run and curled.
- **DoD 4** — a Dockerfile repo built through buildctl, loaded via `loadImage`,
  runs and serves 200.
- **DoD 7** — Python cold **28849ms**, warm **2060ms**: a 14x speedup.
- **DoD 8** — the build directory is gone after success, gone after a build that
  exits non-zero, and an orphan aged past 24h is reclaimed by the sweep.
- **DoD 9** — the canary reached the log twice (the RUN line and its stdout) and
  was redacted in both: `RUN echo "build-time canary was [redacted]"`. Zero
  leaks across 55 lines.
- RSS during a build: 42.4MB → **44.8MB peak** → 46.1MB after, across 53 log
  lines. No retained streams; the shell-out premise holds.
- `gate:rss`: **78.2MB**, unchanged.

### Still unverified, and not claimed

No resource can be built from a repository yet — there is no `git` resource kind,
no schema for one, and nothing wired into `runDeploy`. That is checkpoint 3, and
it is where the risk of a built image being mistaken for a registry image, and
silently never rebuilt, actually lives.

## Checkpoint 3 — git resources deploy from source (2026-08-24)

`resources.kind` gains `"git"`, migration 0002 adds the Phase 2 tables and
columns, and `runDeploy` branches at step 3 to build instead of pull. Source
still arrives from a local directory: the seam is `SourceFetcher`, and
checkpoint 4 replaces the implementation without touching anything else here.

### D10 — a built image lives in its own column, not in `source_json`

`source_json` answers "what is this resource built or pulled FROM". For an image
resource that is `{image}`; for a git resource it is `{repo, branch, pack, ...}`.
The tag a build produces goes to a separate `built_image` column, and
`resourceImage()` branches on kind to return it.

The alternative — writing the built tag into `source_json` — is the trap this
checkpoint was sequenced to expose. A git resource whose `source_json` holds an
image reads as an image resource on its next deploy and **silently stops
rebuilding**: no error, no failed job, just a push that never takes effect. It
is the same shape as the D6 prune bug, and equally invisible until someone
notices their deploys have been doing nothing.

`setResourceImage()` now throws for a non-image resource rather than succeeding,
and the settings route only accepts an image field for an image resource — a
refusal in the one place that can still reach the column, rather than a
convention.

### Step 3 branches; steps 4 through 8c do not

The build is a phase inside `runDeploy`, not a job of its own. Two jobs at
concurrency 1 can be separated in the queue by an unrelated deploy, leaving the
deployment row "running" across both with no single owner of the failure path,
and `runDeploy` already owns marking a deployment failed, the SSE log topic, and
cleanup-by-stage. Splitting it would duplicate all of that.

Everything from step 4 on is byte-identical for both kinds. That is deliberate:
the ordering from the health gate through the route switch to the old
container's removal is the product's core guarantee, and a second copy of it for
git resources would be a second place for it to rot.

### `useExistingImage` — rollback must not rebuild

A rollback names an image that already exists. Branching on `resource.kind`
alone would make a git resource **rebuild from source** on rollback, which
defeats the button entirely: the point is to return to the artifact that was
running, not to re-derive one from the same source that produced the version
being rolled back from. The reconciler has the same problem more sharply — it
runs every 30 seconds, so a flaky daemon would trigger a fresh build per tick.

`DeployPayload.useExistingImage` is set for any trigger other than `manual`, and
step 3 builds only when it is absent.

### The bug the rollback test caught

The first implementation keyed the step-8c write on whether _this deploy_ had
built something (`builtImage === null`). That is correct on the build path and
wrong on every other one: a rollback of a git resource builds nothing, so the
flag stayed null, the image-resource branch ran, and `source_json` was
overwritten with `{"image":"musdash/gitapp:23gr9g75"}` — destroying the
repository spec on exactly the path the column was introduced to protect.

Verified by reading the row after a real rollback, not by reasoning about it.
`listProtectedImages()` showed the second symptom in the same breath: the
running image had dropped out of the keep-set, so a prune would have deleted the
image the resource was serving from.

**Keyed on `resource.kind` now.** The lesson is narrow and worth keeping: a
guard on "what did this operation do" is not a guard on "what kind of thing is
this", and only the second one holds across every path into the write.

### Verified against a real daemon (2026-08-24, WSL2, Engine 29.7.2)

- **Forward migration on a populated Phase 1 database** — 1 resource, 13
  deployments, 41 jobs, only `0001_init` applied. `0002_github` applied cleanly,
  every row preserved, `auto_deploy` backfilled to 1 and the new nullable
  columns to NULL. This test cannot be re-run once the schema has moved on.
- **The compiled binary** applied both migrations from a fresh data dir — the
  only thing that proves the static-import path (trap 6).
- A git resource **built and deployed end to end**: `musdash/gitapp:23gr9g75` in
  3842ms, whole deploy 9188ms, container serving `node-dockerfile ok` on HTTP 200.
- `source_json` intact after deploy, after a second build, and after a rollback.
- **Rollback ran 0 builds** and redeployed the previous tag.
- **Zero-downtime regression on an image resource: 400/400 requests 200, zero
  failures**, route switched 172.18.0.2 -> 172.18.0.6. This is the gate on the
  `runDeploy` edit and it was run, not assumed.
- `listProtectedImages()` covers both built tags; a built image cannot be
  re-pulled, so pruning one destroys the rollback target permanently.
- `gate:rss` **78.9MB**, `bun test` 73 pass.

### A false alarm worth recording

The first zero-downtime run reported 22 failures out of 400. It was not a
regression: `MUSDASH_WILDCARD_DOMAIN` had been restored to commented-out at the
end of Slice C, the `domains` table is empty, and with no host there is no route
to switch — so Caddy kept a stale upstream from a previous session and the
resource was already unreachable before the test began. With the variable set,
the same test is 400/400. **A verification environment that has drifted reports
a bug in the code rather than in itself**, and the first move on a surprising
regression is to check what changed underneath the test.

### Still unverified, and not claimed

Source comes from a local directory. There is no GitHub App, no tarball fetch, no
webhook, and no repository picker — the create form takes a path as free text and
is not reachable from the UI's normal flow. Commit metadata columns exist and are
never populated. All of that is checkpoint 4.

---

## Checkpoint 4b + 5 — GitHub, wired end to end (2026-08-25)

The client from checkpoint 4a becomes reachable: an App registers through the
manifest flow, installations sync, the create form gains a picker, and GitHub's
webhook reaches an endpoint that verifies before it parses. `resources.kind ===
"git"` stops meaning "a path someone typed" and starts meaning a repository.

### D11 — GitHub auth and webhook verification are hand-rolled

§26 of PHASES.md says "Use `@octokit/app`. Do not hand-roll this," and again
"Use `@octokit/webhooks`." Both are declined, and this entry is the record
`src/github/jwt.ts:11` has been forward-referencing since checkpoint 4a.

`@octokit/auth-app` measured **~10MB idle RSS**. The budget is 100MB and the
binary currently idles at 78.9MB, so one convenience dependency spends half the
remaining headroom. What it buys is a `createSign` call behind a cache, and what
`@octokit/webhooks` buys is a `createHmac` call and a constant-time compare.
Both are already in `node:crypto`, which costs nothing because the runtime ships
it. The RAM budget is the product's reason to exist; a dependency that eats 10%
of it to save 60 lines is the trade the budget exists to refuse.

The cost is real and worth naming: GitHub's auth and signature schemes are now
ours to keep correct. That is acceptable because both are small, both are
specified in writing, and **signature verification is unit-tested against a
tamper case** — one of the four things CLAUDE.md sanctions tests for. The JWT is
not independently tested; it is exercised by every API call that works.

### The webhook is a separate Elysia instance, and that is load-bearing

`appRoutes` guards every request with a session check that **303s to `/login`**.
GitHub follows redirects, gets a 200, and records the delivery as **successful**.
Auto-deploy would look configured from both ends — a green deliveries page, a
resource with a repo attached — and never fire. Nothing logs, nothing retries,
nothing fails.

So `/webhooks/github` lives on its own `new Elysia()` mounted before
`appRoutes`. Elysia 1.4 scopes hooks `local` by default, and this codebase
declares no `as: "global"`, no `as: "scoped"`, and no `.as(...)` anywhere —
verified by grep, and then verified again by mounting a probe route beside a
guarded instance and confirming it was not intercepted. **Adding a global-scoped
hook anywhere breaks this route first and silently**, which is the reason the
scoping choice is written down rather than left to the reader.

HMAC replaces the session as the authenticator, which is also why the CSRF gate
does not apply: there is no cookie and no browser.

### Verify before parse, on the bytes GitHub actually sent

`parse: "none"` and `await request.text()`. Re-serializing a parsed object is
not byte-identical to what was signed — `{"a": 1}` and `{"a":1}` have different
digests and GitHub does not send canonical JSON. The test asserts exactly that
case rather than trusting it.

`request.clone()` is not available as an escape hatch here: Elysia has consumed
the stream by the time a hook runs, and cloning throws `ERR_BODY_ALREADY_USED`.
That bug is already recorded above for CSRF; the same fact shapes this route.

An unverified body never reaches `JSON.parse`.

### `REUSES_IMAGE` — an enumeration, not an inference

`enqueueDeploy` derived `useExistingImage` from `trigger !== "manual"`. That was
correct for three triggers and wrong the instant a fourth existed: a webhook
deploy would have been told to reuse an image, and step 3 would have tried to
`docker pull` an image literally named `(building)`. Every push-deploy fails,
with a registry error pointing at Docker rather than at the enqueue.

It is now a set of the triggers that reuse — `rollback` and `reconcile` — and
the two comments asserting the old inference are gone. This is the same lesson
as the checkpoint 3 rollback bug one section up: **a guard derived from "what is
this not" breaks when the set grows; a guard that names what it means does not.**

### Coalescing pushes, and why the blind window is worse here

A burst of pushes at job concurrency 1 would queue a deploy each. The bucketed
job id from the reconciler collapses them, with a **60s** bucket.

But the tradeoff is sharper than it is for the sidecars. A bucketed sidecar
bootstrap that collides is only _delayed_ — the reconciler runs every 30s and
tries again forever. **A webhook has no retry loop.** A second, genuinely
different push inside the same bucket is dropped, not deferred, and the only
thing that redeploys it is the next push or a human. 60s is chosen to be shorter
than a realistic gap between distinct pushes while still absorbing a
`git push` of several commits, which arrives as one event anyway.

The deployment row is deleted when a coalesce loses, so a dropped push does not
leave a row displayed as "queued" with no job behind it.

### Three installation ids, and only one goes in the resource

`github_installations.id` is a ULID. `github_installations.installation_id` is
GitHub's integer. `resources.git_installation_id` is **GitHub's integer stored
as a decimal string** — `tarball.ts` does `Number(...)` on it and throws if it is
not finite. `NewInstallation.appRowId` is the _App's_ ULID, not the
installation's.

Writing the wrong one produces a 404 from GitHub at deploy time, hours after the
mistake and nowhere near it. The create route validates that the field is
digits-only and matches a known installation before it is stored.

### Disconnect nulls the linkage and keeps the repo

There is no foreign key from `resources.git_installation_id` to the
installations table, so deleting an App would otherwise leave resources pointing
at an installation that no longer exists. Disconnect clears the linkage and
**keeps `git_repo` and `git_branch`** — the repository is still the one the user
chose; only the credential is gone. The confirmation names how many resources
are affected before it happens.

`clearTokenCache()` runs on registration, re-registration, and disconnect.
Without it, tokens minted by a dead App stay in memory for up to an hour.

### The manifest nonce lives in `settings`, and is consumed by deletion

Not a module-level `Map`: one process or not, a restart mid-flow would strand
the user with a callback that can never validate. It is deleted before the code
is exchanged, so a replayed callback URL fails on the second attempt. A wrong
`state` leaves the stored nonce intact — a guessed value must not burn the real
user's pending flow.

Without the nonce, a crafted callback link sent to an admin registers an App the
attacker controls, which hands them the webhook secret and the ability to
trigger deploys.

### The redaction backstop does not cover these secrets

`GITHUB_SECRET_RE` matches `gh[pousr]_` tokens, codeload URLs, and PEM headers.
It does **not** match `client_secret` or `webhook_secret`, and the manifest
conversion returns all three in one response body. There is no safety net on
that object; the discipline is that it is never handed to a logger, in any form,
including as an error `cause`.

### The error path leaked the credential the body reasoning was protecting

`describe()` in `api.ts` had always refused to read a response body into its
message, and said why: a 401 body can echo fragments of the credential that
failed. It then interpolated the request **path** into two of its four messages.

For every endpoint built to that point the path was inert. The manifest exchange
is `/app-manifests/<code>/conversions`, and that code is the one credential that
buys `client_secret`, `pem` and `webhook_secret` in a single response. So the
most likely failure — a replayed or expired code, which lands on the 404 branch
— wrote the live credential to the log. `GITHUB_SECRET_RE` does not match a
manifest code, so the backstop never fired.

Found in validation, not in testing, and the shape is worth keeping: **a
sanitizer scoped to one field is a claim about every other field**, and the
comment asserting the body was dangerous is what made the path look safe.

`sanitizePath()` now reduces a path to its route skeleton before it reaches a
message, against an **allow-list** of route keywords: `/app-manifests/*/
conversions`, `/repos/*/*/commits/*`. A deny-list would need extending every time
an endpoint carrying a secret is added, and forgetting costs a credential; an
allow-list fails closed, so an endpoint nobody taught it about is masked
entirely.

### A push can now create a container that has never run

`resourcesForPush` filtered on `desired_state = 'running'`, which reads as "not
deliberately stopped" and also silently means "has deployed successfully at least
once". A resource created from the picker starts `stopped` and only becomes
`running` inside a successful deploy, so **auto-deploy did nothing until someone
clicked Deploy by hand** — while the toggle rendered checked. The UI asserted a
feature that was not running.

The distinguishing signal already existed: `current_deployment_id` is NULL at
creation and is written only alongside `desired_state = 'running'`, so NULL means
exactly "never deployed successfully" and can never mean "was stopped". The
predicate is now named — `desired_state = 'running' OR current_deployment_id IS
NULL` — because inline it reads as a filter someone widened, and the two meanings
it separates are the entire point.

The behavior change is deliberate and worth stating: a git resource now deploys
on its **first** push after creation, with no manual deploy first. A push can
therefore create a container for a resource that has never run, which was
previously impossible. A deliberately stopped resource still does not
auto-deploy.

### Known and deferred: the repo picker refetches on every project page

`GET /p/:projectId` awaits one authenticated GitHub call per installation,
paginating to completion, with no cache. It runs on every project page load —
including for projects holding no git resources at all — and with GitHub slow or
unreachable the page stalls behind a 15s timeout per installation before
rendering anything.

Server-rendering the picker was chosen deliberately (a fetch endpoint would be
the parallel client-side store the invariants refuse), and that choice stands.
Doing it unconditionally and uncached on the hot path is a separate question,
and the answer is a cache with an explicit invalidation point rather than a
different rendering strategy. Deferred rather than fixed here: caching is a
design change, the slice is already large, and the cost is latency on one page
rather than a wrong result.

The `repoTotal >= 200` notice in `project.eta` tells the user when the _size_ is
the problem. Nothing yet tells them when the _latency_ is.

### Still unverified, and not claimed

Two paths in this checkpoint are **inbound HTTP from GitHub**, and this is an
RFC1918 box — the same constraint recorded for Slice D above, now actually
binding. **The manifest callback redirect and the webhook POST have not been
exercised against real GitHub.** What has been verified is everything up to the
network edge: signature verification against locally-computed HMACs including
tamper cases, the webhook route answering 401 rather than redirecting to
`/login`, the dispatch and its skip conditions, nonce lifecycle, and the trigger
plumbing. Phase 2 DoD items 1, 2, 3, 5, 6 and 7 remain unproven until this runs
on a public host.

## Shared environment variables (2026-08-25)

PHASES.md §26 named three things Phase 2 never built. This is the largest:
variables resolve project → environment → resource, expand `${VAR}`, and carry
an explicit build/runtime scope. `docs/RUNNING.md` had documented the
inheritance since Phase 1 — it was the only part of that file describing
something that did not exist.

### D12 — one table per ownership shape, and a scope column on both

§26 says "add `shared_env_vars` with a nullable `project_id` and nullable
`environment_id`", and that is what this does rather than generalizing
`env_vars` with a nullable owner.

Generalizing would mean making `env_vars.resource_id` nullable, which forfeits
the `NOT NULL` foreign key and the `UNIQUE(resource_id, key)` that hold today,
and SQLite cannot drop a table-level UNIQUE with `ALTER TABLE` — it needs the
twelve-step table rebuild, on a table holding ciphertext, inside a migration.
That is the highest-risk operation available here and it buys nothing: the
resolver queries each level separately regardless, so "one table is simpler"
does not survive contact with the queries.

Nullable owner columns need care in return. `UNIQUE(project_id, key)` as a
table constraint would not constrain anything, because SQLite treats every NULL
as distinct and every environment-level row has a NULL `project_id`. Two
**partial** unique indexes scope each constraint to the rows that have that
owner, and a `CHECK` makes a row with both owners — or neither — unrepresentable
rather than merely discouraged.

The `scope` column ('runtime' | 'build' | 'both') is plain TEXT with no CHECK,
matching `deployments.trigger` and `jobs.type`: widening the union later then
needs no migration.

**This closes a leak.** Until now `runDeploy` decrypted one map and handed the
same one to `createContainer` and to `buildFromSource`, whose parameter was
already named `buildArgs` — so every runtime secret was also a build arg, baked
into image history. Existing rows migrate to `runtime`, which is a deliberate
behaviour change: a resource that relied on a variable reaching its build must
re-mark it.

### D13 — interpolation expands once, and refuses rather than guesses

`${VAR}` resolves after the three levels merge, so a resource variable can
reference a project one. Two limits, both deliberate.

**One pass, no recursion.** If `A=${B}` and `B=${C}`, `A` becomes the literal
text `"${C}"`. Recursion would need cycle detection, and an undetected cycle
hangs the worker — job concurrency is exactly 1, so that is a total outage, not
a slow deploy. A self-reference throws outright: `PATH=${PATH}:/x` is the shell
habit everyone types, and here there is no inherited environment to extend, so
it would otherwise yield a doubled value.

**An unresolvable reference fails the deploy.** Compose and shell substitute an
empty string; that is how a container boots with `DATABASE_URL=postgres://user:@/`
and corrupts data quietly. The error names the referencing key and the missing
name, and never a value.

The escape is `$$` → `$`, **not** backslash. `parseEnvText` runs first and
`unescapeDouble` consumes a backslash inside a double-quoted value, so
`\${FOO}` arrives as a bare `${FOO}` and is indistinguishable from a real
reference — verified against the parser rather than assumed. The cost is that
`$$` collapses unconditionally, so a value genuinely containing `$$` must be
written `$$$$`. That is the one usability regression, and it is unavoidable
with any escape.

### D14 — redaction coverage is decoupled from what is passed to the build

Splitting one map into two silently narrows redaction, and this is the subtle
failure the split introduces. `buildImage` derived its secret list from
`Object.values(req.buildArgs)`; once `buildArgs` is the build-only subset, a
runtime-only secret surfacing in build output — a Dockerfile that `cat`s a
mounted file, a token inside a lockfile URL — would newly print to a stream the
browser renders.

`BuildRequest` therefore carries `redactSecrets`: every value at every scope,
independent of what is actually passed as a build arg. Both layers keep their
redactor — `buildImage` because it is callable with a different `onLog`, and
`emit` because it is the single point every deploy line passes through.
Removing either creates a path with no redaction.

Resolution also moved _inside_ `runDeploy`'s try block. Outside it, an
interpolation error escaped before the deployment was marked running, so the
queue retried three times and the user saw a bare queue error instead of a log
line naming the variable. The same was already true of a `CryptoError` on a
tampered ciphertext.

---

## Build cache cap (2026-08-25)

`MUSDASH_BUILD_CACHE_GB` had been validated, exported and documented as the
"layer cache ceiling" since Phase 1, and read by nothing. Meanwhile
`data/build-cache/` grew without bound and a deleted resource left its cache
directory behind forever. This is that promise implemented.

### D15 — eviction is LRU by directory mtime, not largest-first

Largest-first optimises bytes reclaimed per deletion, which is the wrong
objective. The cache's only value is the hit rate on the next build of a
resource, so evicting the biggest directories systematically targets the biggest
apps — exactly the ones whose builds are slowest and whose cache is worth the
most seconds. LRU evicts the caches of resources nobody is deploying, which is
the right proxy for "no one will miss this".

Eviction is a prefix cut over the mtime order, not a per-entry fit test. Keeping
every directory that happens to fit and skipping past the ones that do not looks
equivalent and is not: a large newest cache gets dropped while two small older
ones survive, which is the largest-first behaviour this decision exists to
avoid. The newest entry is exempt from the fit test, because something has to
survive and it is the one most likely to be built again — without the exemption
a resource whose cache alone exceeds the watermark takes every older cache down
with it and the box ends up with nothing cached at all.

mtime is a real access signal rather than a guess. BuildKit's `type=local`
export rewrites `index.json` on every export, and every import in musdash is
paired with an export in the same `buildctl` invocation, so an import can never
occur without an export. Verified against a real `moby/buildkit:v0.27.0` daemon:
two builds five seconds apart moved the directory mtime by exactly that. No
`last_used_at` column and no migration — mtime already answers the question, and
it survives a database restore against an existing cache directory.

### D16 — two watermarks, evicting to 80% of the cap

Nothing is evicted until the total exceeds the cap; once it does, eviction runs
down to 80% of it. Evicting back to exactly the cap leaves a cache that trips
again on the next build, so it would evict one directory per day forever, and in
the log "ran daily and reclaimed almost nothing" is indistinguishable from "is
broken". The 20% of headroom buys weeks of quiet and makes each pass reclaim a
number worth reading. Both thresholds derive from the one existing knob; a
second env var would be knob proliferation for a number nobody will tune.

Both thresholds have to be checked, and the first implementation checked only
the low one. Summing newest-first and evicting as soon as the running total
passed 80% never consults the cap at all: it silently redefines the cap as 80%
of itself, and a lone 9GB cache under a 10GB cap was deleted outright, then
rebuilt and deleted again every day, with no warning because it never exceeded
the cap. That version deleted the tail unmeasured, which is what made it look
cheap. Measuring everything first costs ~350ms and under 1MB of heap at 20,000
blobs — the shape of a real cache — so the correct version is affordable and the
clever one was not worth its bug. A directory that cannot be fully read counts
as filling the whole cap rather than as zero, so the one directory nothing can
measure cannot be permanently exempt from the budget.

A single resource whose cache exceeds the entire cap is still evicted — a disk
that fills is worse than a build that runs cold — but it logs a warning naming
the directory and the cap, because every deploy for it silently building cold is
not something an operator should have to reverse-engineer.

### D17 — the sweep runs on the queue, though it is filesystem work

`sweepBuildDirs` runs inline in the scheduler and this does not, which looks
inconsistent. The distinction is cost, not Docker: that call is one `readdir`
over a handful of entries, while sizing the layer cache walks tens of thousands
of blobs. All filesystem access here is synchronous, so inline it would block
the event loop and stall the dashboard and its log streams. On the queue the
only thing it delays is the queue, which already absorbs multi-minute builds.

The queue also makes "never evict a cache that is being written" true
structurally rather than by a check that could race: worker concurrency is
exactly 1 and the worker awaits one handler at a time, so the sweep cannot
overlap a build. There is deliberately no in-flight check, and its absence is
commented so it does not read as an oversight.

Sizes are not persisted. A size table would need a migration and invalidation on
every build, and would go stale exactly when it matters — after a build the
sweeper has not seen. The walk runs once a day.

### D18 — the daemon cache is capped by flag, and the help text is wrong

Only the Dockerfile strategy writes to `buildCacheDir`. Railpack — the default
pack — caches inside the daemon's own `musdash-buildkit-cache` volume, which had
no gc configured at all. Capping one without the other would have shipped the
feature name without the feature, so `--oci-worker-gc` and
`--oci-worker-gc-keepstorage` are set from the same knob.

A flag rather than a `buildkitd.toml`, because the container's `command` array is
flags-only and a config file would need a bind mount this bootstrap does not
otherwise have.

The value is in **MB**, not bytes — verified against v0.27.0's own `--help`
rather than assumed, since an order-of-magnitude unit error is silent in both
directions. Percentages are rejected; this flag takes integers only. Reserved is
a quarter of the cap rather than equal to it: setting them equal leaves gc
nothing it is permitted to reclaim, which is how a cap becomes a daemon that
never collects.

Two fields are passed, not three, and the help text is why this is subtle. It
calls the value `"Reserved[,Free[,Maximum]]"`, but upstream parses it into
`GCReservedSpace`, `GCMaxUsedSpace`, `GCMinFreeSpace` in that order — so
position two is the maximum, not a free-space target. Following the help text
set the ceiling to ~197GB and the free-space target to 10GB, which left the cap
inert on any real disk while looking correct. The two-field form is unambiguous
under either reading and was verified to parse. This could not be settled by
observing the daemon: it accepts contradictory values (`Reserved` above
`Maximum`) without a word, so the assignment order in upstream's source is the
only evidence there is.

Omitting a field by writing it empty is not an option either: `"2560,,10240"` is
not "take the default", it is a parse error — buildkitd exits with
`strconv.ParseInt: parsing "": invalid syntax`, which would have failed every
install's build bootstrap at the readiness gate. An unrecognised flag also exits
rather than warning, so a wrong name fails loudly instead of silently doing
nothing.

Adoption deliberately does not recreate the container: `ensureBuildkit` reuses an
existing daemon by name and never inspects its command, so an upgrading install
keeps its uncapped daemon until an operator runs `docker rm -f musdash-buildkit`.
Recreating would discard the cache volume that makes redeploys fast, so this is
an upgrade note in RUNNING.md rather than code.

### D19 — the cache is deleted twice, on purpose

The same shape as build directories above. `runRemove` deletes a resource's cache
eagerly, with the row and before it goes — gated on `deleteRow` rather than
unconditional, because a caller that removes the container while keeping the
resource still wants its layer cache — once the row is gone the directory is identifiable
only as an orphan, which is a daily sweep away rather than immediate — and the
orphan pass is the backstop for a crash between the two. The eager delete never
throws: a cache directory nobody will read again must not fail a resource
deletion, and the only cost of a failure is that the bytes survive until
tomorrow.

Orphans are removed unconditionally, ahead of any size check, and never walked.
A cache whose resource is gone can never be imported again, so it is pure waste,
and deleting it first keeps its bytes out of the sizing walk entirely.

### Deviation — cache usage is not surfaced in the UI

PHASES.md §26 and the Phase 1 note above both ask for the cap "alongside image
usage". No image-usage surface exists either — `pruneImages` reports its
reclaimed bytes to pino and nowhere else — so building a cache widget alone would
invert the documented intent, and it would put the sizing walk on an HTTP request
path. Deferred to a disk-usage slice covering both.

## One-command install, and the dashboard on a bare IP (2026-08-25)

### D20 — the dashboard gets its own Caddy route, and it is a catch-all

D3 said "`install.sh` creates a Caddy route for the dashboard on its own
subdomain from the start." It never did — no dashboard route existed anywhere in
the code. The consequence was a lockout, not a cosmetic gap: `bindHostname`
narrows to `127.0.0.1` the moment the users table is non-empty, so the first
restart after creating an admin account moved the listener to loopback with
nothing proxying it. The operator was locked out of the box one restart after
installing it.

`ensureDashboardRoute()` now creates that route, and it has no host matcher.
A catch-all is not laziness: on a fresh VPS the only address the box has is its
IP, and a host matcher cannot express "whatever address the operator typed".
Let's Encrypt does not issue for IP addresses, so this path is HTTP only, and the
installer says so rather than implying otherwise.

Ordering is what makes a catch-all safe. Caddy evaluates routes in array order;
every resource route carries a host matcher and `terminal: true`, so a request
for a deployed app's domain matches its own route and stops. Only unmatched hosts
reach the dashboard. That guarantee holds only while the catch-all is LAST, and
`upsertRoute` appends, so a resource deployed later would land behind it — hence
the route is deleted and re-appended on every `ensureCaddy()` rather than created
once.

Setting `MUSDASH_DASHBOARD_HOST` narrows the route to that name, which also
turns automatic HTTPS on for it.

### D21 — `MUSDASH_BIND_ALL`, because loopback is only safe behind a proxy

§12's "bind 127.0.0.1 in production" is correct _given_ that Caddy fronts the
dashboard. When the operator is reaching it on the bare IP, the same rule is the
lockout above. The flag makes the precondition explicit instead of assuming it,
and the installer sets it to `true` exactly when no dashboard host is configured.

### D22 — the installer compiles on the host

The alternative was a release artifact, which is what Coolify does. It was
rejected for now because the repository is private and has no releases: a
download-based installer cannot work at all until both change. Compiling on the
VPS needs no published build, works from a private checkout, and produces a
binary matched to the host's libc. It costs about a minute and ~200MB for the Bun
toolchain and `node_modules`, which is why the source lives in `/opt/musdash-src`
and not under `/opt/musdash` — nothing there is runtime state worth backing up.

The build stops the service before overwriting the binary. Replacing it under a
running process is what leaves a half-upgraded install that restarts into old
code.

### Caddy reaches the host through an alias, not through localhost

The dashboard binds the host's loopback (D2) while Caddy is in a container, so
`127.0.0.1` from inside the proxy reaches the proxy. The container now gets an
`ExtraHosts` entry mapping `musdash-host` to the Engine's `host-gateway`, and the
dashboard route dials that. `host-gateway` is the _address_ the Engine
substitutes, so the alias on the left is ours to choose.

### Still unverified, and not claimed

None of this has been run against a real VPS. The catch-all route ordering, the
`host-gateway` mapping, and the end-to-end install were checked by typecheck,
unit tests, and shell syntax only.

## Slice: the dashboard address moves into the product (2026-08-25)

### D23 — the dashboard binds every interface, and the firewall is the boundary

§12, D3 and D21 all assumed "bind `127.0.0.1` in production, reached through
Caddy". That is unachievable with Caddy in a container. The proxy dials the host
through the `musdash-host` ExtraHosts alias, and the Engine resolves
`host-gateway` to the host's **bridge** address (docker0, typically 172.17.0.1)
— not loopback. A socket bound to `127.0.0.1` cannot accept that connection. The
earlier section "Caddy reaches the host through an alias, not through localhost"
asserted the opposite and was wrong: the alias mechanism is correct, the claim
about loopback was not.

**Resolution: `bindHostname()` returns `0.0.0.0` unconditionally, and
`MUSDASH_BIND_ALL` is removed.** The boundary moves from an implicit bind
address to an explicit firewall rule, which `install.sh` now creates. That is
the honest place for it — the old rule was already untrue in practice, since
`install.sh` set `MUSDASH_BIND_ALL=true` on every install without a dashboard
host, which is the default path. What is exposed without a firewall is the login
form, `/health` and `/assets`; every other route sits behind a SQLite session
and the global CSRF gate.

A stale `MUSDASH_BIND_ALL=false` line in an existing `musdash.env` is harmless:
zod object parsing ignores unknown keys, so it fails nothing and does nothing.

**Rejected: discovering the bridge gateway through `DockerClient` and binding
that address.** It would bake a local-socket assumption into the one interface
CLAUDE.md requires to stay free of them — a remote SSH implementation's
`networkGateway()` returns the _remote_ host's address, which it would be
actively wrong to bind locally. It also targets the wrong address, since the
daemon's `--host-gateway-ip` can override what `host-gateway` means, and a
socket bound to a bridge IP dies when docker0 is recreated with no rebind path.

### D24 — the dashboard gets TWO routes, and the catch-all is unconditional

D20 said setting `MUSDASH_DASHBOARD_HOST` "narrows the route to that name".
Narrowing removed the catch-all, and with it the only way back in when DNS
breaks, a registrar lapses, or issuance fails. Observed on a real VPS: every
request to the bare IP became a 308 toward an `https://<ip>/` that can never
have a certificate.

**Resolution: `ensureDashboardRoutes()` appends `musdash-dashboard-host`
(host-matched, which is what activates automatic HTTPS) and then
`musdash-dashboard` (catch-all), in that order, deleting and re-appending both
as a unit on every `ensureCaddy()`.** Caddy redirects :80 to :443 only for names
it manages, so a bare-IP request falls to the catch-all and is served over plain
HTTP rather than redirected. D20's ordering argument carries over verbatim: the
catch-all must stay last or it swallows every resource route.

The accepted cost is unchanged from D20 — the dashboard answers on any `Host`
header — and a foreign host gets a login page whose session cookie is scoped to
the host that set it.

### D25 — the hostname lives in the database, with the env as a fallback

`settings.dashboard_host` wins when the row exists; `MUSDASH_DASHBOARD_HOST` is
read only when it does not. Env-wins would have made the feature a no-op for
every existing install, since they all already carry the value in `musdash.env`.
Seeding the row from the env at first boot would have made "clear the hostname"
impossible — the next boot re-seeds it from a line the operator cannot edit from
the UI. Read-through has neither problem. Clearing the field writes an empty
row, not a deletion, because an absent row falls back to the environment and the
operator who cleared it meant "none, including that one".

Applying it is a new job type, `apply_dashboard_host`, enqueued with a fresh
ULID. **Not** `ensure_caddy`: the reconciler enqueues that under a 5-minute
bucketed id and swallows primary-key conflicts, so a save inside the same bucket
would collide with an already-completed row and silently do nothing — the
operator presses Save, sees a success flash, and nothing happens. A healthy
proxy is also never re-bootstrapped, so `ensure_caddy` would not run at all. Any
deterministic id has the same failure in a different costume; a fresh ULID
cannot collide, and the handler is idempotent so a duplicate is a harmless
no-op.

### D26 — the restart is a route action, never a job

The worker calls `complete()` _after_ its handler returns. A handler that exits
the process never returns, so its row stays `leased`, `recoverExpiredLeases()`
re-claims it fifteen minutes later, and the process restarts again. A restart
job is a slow restart loop.

`POST /settings/restart` therefore stops the worker, reconciler and scheduler,
then `setTimeout(process.exit, 750)` so the 303 reaches the browser first. It
refuses while any job is `pending` or `leased` — refusing costs three seconds
and needs no state, where draining means a background timer holding a promise
nobody is watching. systemd is detected by `INVOCATION_ID`, which needs no
subprocess and no knowledge of the unit's own name; it cannot see a unit with
`Restart=no`, which is why the UI shows the `systemctl` command alongside the
button rather than instead of it.

**The dashboard hostname does not need a restart** — nothing reads
`config.dashboardHost` at runtime once the database is the source of truth, and
the bind is unconditional. The button ships anyway, in its own card, because it
is the only way to pick up the settings that are still environment-only.

### D27 — a reachability probe, because a firewall failure is otherwise silent

After applying the route, the job fetches `http://127.0.0.1:80/health` with a
bare-IP `Host` header. That traverses host → the proxy's published :80 → the
catch-all → the ExtraHosts alias → back into this process, so a `200 ok` proves
the bind address, the bridge path, the firewall and the catch-all's continued
existence in one call. The bare-IP `Host` is deliberate: a matching hostname
would hit the automatic HTTPS redirect instead of the dashboard.

Without it, a host firewall that DROPs traffic from the docker bridge presents
as an unexplained 15-second timeout with nothing in any log. `ensureCaddy()`
runs the same probe warn-only — that job has `maxAttempts: 1`, and a new hard
failure mode in it would turn a working proxy into a failed bootstrap on an
unusual-but-valid firewall setup.

### D28 — the ACME issuer is reconciled, not written once

`ensureBaseConfig()` early-returns when `srv0` exists, and Caddy runs `--resume`
against a persisted config volume, so the TLS automation policy was written
exactly once, on the first boot ever. A box first bootstrapped with
`MUSDASH_ACME_STAGING=true` kept issuing untrusted staging certificates forever,
and changing the env var and restarting did nothing at all — which reads to the
operator as "musdash cannot get me a certificate".

`caddy.ensureTlsAutomation()` now PATCHes
`/config/apps/tls/automation/policies` when the persisted issuer differs from
the configuration, and logs when it does. Flipping staging off triggers real
issuance, which is rate limited to 50 per registered domain per week — that is
the intended outcome, and the reason this logs rather than doing it quietly.

### Verified, and not verified

Verified locally: 125 tests pass, `bun run check` clean (prettier, biome with
warnings as errors, `tsc --noEmit`), `bash -n scripts/install.sh` clean.

**Not verified against a real VPS.** The bridge-path claim, the catch-all
restoring plain HTTP on the bare IP, certificate issuance, and the restart
button are reasoned from the Caddy and Docker documentation plus live probing of
one box's _symptoms_ — not from running this code on it.

## The public URL is derived, not configured (2026-08-25)

`MUSDASH_DASHBOARD_HOST` and `MUSDASH_PUBLIC_URL` always encoded the same
domain in two formats — bare for the Caddy host matcher, scheme-prefixed for
GitHub's callback and webhook URLs. Requiring both is two chances to get one
fact wrong, and the two fields disagreed about the scheme: one forbids it, the
other (`z.string().url()`) requires it. Nothing validated the first.

That is not hypothetical. A live install was set to
`MUSDASH_DASHBOARD_HOST=https://musdash.neatwrk.com`. The value went straight
into a Caddy host matcher, which matches the literal string, so the route could
never match any request. No certificate was requested, every request fell
through to Caddy's default HTTP→HTTPS redirect, and both the HTTP and HTTPS
addresses were dead. musdash logged a clean startup throughout. The dashboard
was unreachable and nothing anywhere said why.

`getPublicUrl()` (`src/settings.ts`) now returns `https://` + the effective
dashboard host, which is already database-first via `getDashboardHost()`. The
operator sets one thing — the domain — on the Settings page.

**Derivation wins over `MUSDASH_PUBLIC_URL`, not the reverse.** Env-wins looks
safer and is worse: every existing install already carries the env line, so the
value would go stale the instant the domain is changed from the Settings page,
silently pointing GitHub at the old name. That is the same invisible breakage
this change exists to remove. The env var survives only as the fallback for what
derivation cannot express — something else fronting musdash on a different name,
a tunnel or an external load balancer, where no dashboard host is set at all.

`MUSDASH_DASHBOARD_HOST` also gained a refinement rejecting `:` or `/`, so the
scheme mistake now fails at startup with a message naming the fix instead of
producing a route that matches nothing. The refinement is written inline rather
than reusing `isValidHostname()` from `src/caddy/client.ts`, which imports
`config.ts` — importing it back would be circular.

### Verified, and not verified

Verified locally: 125 tests pass, `bun run ci` clean (prettier, biome with
warnings as errors, `tsc --noEmit`). The refinement was exercised by booting
`config.ts` with `https://musdash.neatwrk.com` (rejected, one clear message) and
with the bare name (boots). `getPublicUrl()` was exercised against a migrated
database across four states: host saved from the UI, host changed from the UI,
host cleared in the UI, and no row at all — deriving in the first three and
falling through to the env var only when the host is explicitly cleared or
absent.

**Not verified against a real VPS.** The GitHub App registration round trip
against a derived URL has not been run.
