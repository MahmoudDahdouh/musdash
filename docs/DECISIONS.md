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

- ~~The admin API binds to the musdash network only, **never published to the
  host**.~~ **Superseded by D29:** the musdash network is where every user app
  lives, so "the musdash network only" meant "every app". The admin API is a
  unix socket in a directory only musdash's user can enter.
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
whatever process it happens to find rather than booting one. Since D42 the
booted copy is isolated from the caller's environment.

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

## VPS test fixes (2026-09-25)

`docs/VPS-TEST-2026-09-25.md` ran the Phase 1 Definition of Done on a real
512MB RamNode box. This section covers the findings that were defects in the
code. C-3 (the host thrashing on reboot without swap) and the memory margin in
I-3 are properties of the host and are not addressed here.

### C-1 — new resource routes are inserted at the front

`upsertRoute` created a new route with `POST .../routes/`, which appends. The
dashboard's catch-all has no host matcher and is terminal, so every route
appended after it was unreachable: each resource answered with the dashboard's
login redirect after its first deploy, on every install, and a redeploy PATCHed
it in place behind the catch-all. D20's defence — re-appending the dashboard
routes in `ensureCaddy()` — only ran when the proxy was bootstrapped, which a
healthy host never does.

New routes now go in with `PUT .../routes/0`, which inserts at index 0, so the
catch-all stays last by construction rather than by a repair that has to run.
Resource routes all carry host matchers and no two share a host, so their order
among themselves does not matter. `ensureDashboardRoutes()` still deletes and
re-appends on every bootstrap; that is what repairs a config written before this
fix.

### D29 — the Caddy admin API is a unix socket, and an outdated proxy is replaced

`CADDY_ADMIN=0.0.0.0:2019` (the D2 amendment) made the admin API reachable from
the host's loopback mapping — and from every interface inside the container,
including the `musdash` network that every user app is attached to. A test app
read the full route list with `wget http://musdash-caddy:2019/...`. The same
unauthenticated API accepts `POST /load`, so any deployed app, a compromised
dependency, or a one-click template could point the dashboard's hostname at
itself and capture the admin login. The host-side loopback binding was correct;
the container-network side was the hole.

**Resolution.** The proxy's admin API listens on
`unix//run/musdash-caddy/admin.sock|0222`, in a host directory
(`$MUSDASH_DATA_DIR/caddy`, mode 0700, owned by musdash's user) bind-mounted
into the container. The client talks to it with Bun's `fetch(url, { unix })`, as
the Docker client already does. Port 2019 is no longer published at all, and
`MUSDASH_CADDY_ADMIN` is removed — a stale line in `musdash.env` is ignored.

- **The directory is the access control, not the socket mode.** The socket is
  0222 because `connect()` needs write permission only and Caddy's default 0200
  admits root alone; musdash runs as its own user. The mode suffix needs Caddy
  2.8+, so the bootstrap now pulls `caddy:2-alpine` on every create rather than
  only when absent, falling back to a cached copy only if the pull fails.
- **The client sends `Host: 127.0.0.1`, not `localhost`.** Caddy 2.10+ skips the
  Host check on unix sockets, but 2.9 and earlier enforce it and allow only an
  empty host, `127.0.0.1` and `::1` — `localhost` would be a 403 on every call,
  and a replaced proxy would never pass the readiness gate. Found by the
  Validator reading Caddy's tagged sources; the fake admin API used for the
  client check could not have caught it.
- **The base config no longer writes an `admin` block.** It used to write
  `admin.listen: 0.0.0.0:2019`, and a persisted config's admin block beats
  `CADDY_ADMIN` on `--resume`, which would have reinstated the TCP listener on
  every restart.
- **An outdated proxy is replaced, amending D7.** D7 adopts an existing proxy and
  never recreates it. That cannot hold when the proxy itself is the hole: the
  listener and the mount cannot be changed on a running container. The proxy now
  carries `musdash.proxy_spec=2`; one without it — including a pre-D7 container
  with no labels — is removed and recreated once. Certificates survive on
  `musdash-caddy-data`. The replacement autosaves under
  `XDG_CONFIG_HOME=/config/musdash`, so the old `autosave.json` (with its TCP
  admin block) is never resumed but stays on the volume for anyone who
  hand-edited it. The image is pulled before the old container is removed, so
  the outage is a container start, not a download.
- **The replacement has no rollback.** :80 and :443 cannot be held by two
  proxies, and recreating the old definition would reinstate the hole. If the
  new proxy fails to come up, the readiness gates say why, the reconciler
  re-queues the bootstrap within its 5-minute bucket, and the dashboard stays
  reachable over an SSH tunnel to :8000 (D31 admits loopback). That is the
  accepted cost of closing the hole on every upgrading install.
- **Routes are re-asserted from the database on every bootstrap**
  (`syncResourceRoutes`). The replacement starts blank, and nothing previously
  reconciled Caddy's routes with the `resources` table at all — a lost config
  volume, or a reboot handing a container a new IP, left sites dark with the
  database still correct. It writes only on a real difference, since every
  admin write is a full reload.
- **Host mounts are a sidecar-only privilege**, like `privileged`:
  `createContainer` refuses `hostMounts` on a spec without a `musdash.role`
  label, and refuses volume names containing a path, which the Engine would
  otherwise read as a host bind.

A rootless or user-namespaced Docker daemon cannot write into a directory owned
by musdash's user, so the socket never appears; the readiness error names the
socket path. That configuration was never supported and is still not.

### D30 — the proxy migrates queued connections across reloads

The zero-downtime switch dropped exactly one request per deploy and per
rollback, lined up to the millisecond with Caddy logging a full reload after the
route PATCH. The ordering was correct and the old container was serving
throughout. The cause is below musdash: every admin write reloads Caddy, Caddy
binds :80/:443 with `SO_REUSEPORT` (`listen_unix.go`) so the new config can
listen before the old one closes, and when the old socket closes Linux resets
the connections still in its accept queue. The client saw curl exit 35.

**Resolution: the proxy container gets `net.ipv4.tcp_migrate_req=1`** (Linux
5.14+), which makes the kernel move those queued connections to another socket
in the same reuseport group instead of resetting them. The sysctl is
namespaced, so it changes only the proxy's own network namespace.

- **Rejected: avoiding the reload.** Every admin change is a full reload in
  Caddy; there is no partial one. A stable upstream name moved by Docker network
  aliases would avoid the reload, but an alias cannot be removed from a running
  container without disconnecting it, which kills the old container's in-flight
  requests — trading one dropped request for a dropped drain.
- **The kernel is checked first**, from this host's `/proc`, because runc fails
  the container _start_ on an unknown sysctl — a proxy that never starts is far
  worse than an occasional dropped request. On an older kernel the bootstrap
  logs a warning and creates the proxy without it.

### D31 — the dashboard refuses public peers itself

D23 made the host firewall the boundary for port 8000. On the test provider's
stock Ubuntu 24.04 image ufw is installed but inactive, `install.sh` only adds
rules, and `/health` answered the public internet — as did the login form, over
plain HTTP, bypassing Caddy's TLS.

**Resolution: a global `onRequest` hook answers 403 to any request whose TCP
peer is not loopback, RFC 1918, CGNAT (100.64/10), IPv6 ULA or link-local**
(`src/http.ts`). Caddy reaches the dashboard from its address on the musdash
bridge, which Docker allocates from private pools; a local tunnel or SSH forward
arrives on loopback. The peer is the socket's address, never a forwarded header.
The firewall rules stay, as a second layer.

- **Rejected: enabling ufw from `install.sh`.** Turning on a default-deny
  firewall on someone's server can cut off SSH on a non-standard port or any
  other service already running there. Refusing public peers in the process
  closes the exposure without touching anything musdash does not own.
- **No toggle.** Something fronting musdash from a public address — the one case
  this refuses — should go through Caddy like everything else. A tunnel or a load
  balancer on a private network still works, which is what `MUSDASH_PUBLIC_URL`
  is for.
- **Private is not the same as trusted.** Other tenants on a provider's shared
  private network pass this check; login is still required, and the ufw rules
  `install.sh` writes shut them out when ufw is enabled.

### Minor findings

- **M-1** — confirmed and wider than reported. Every `pattern` in `src/views`
  had an unescaped `-` in its character class: the project name and the
  resource, database and environment names. Browsers compile `pattern` with the
  `v` flag, where that is a syntax error, so all four fields silently skipped
  client-side validation. All four now escape it (`\-`), and each was compiled
  with the `v` flag straight from the file. A first pass wrongly called this
  unreproducible after reading tool output instead of the file's bytes; the
  Validator caught it.
- **M-2** — the error handler logs method and path (not the query, which carries
  OAuth codes), and 404s are logged at info rather than error.
- **M-3** — the Settings page's inline "applying" note is hidden when the save
  redirect's flash already says the same thing.
- **M-4** — `bun run rss` prints the peak (VmHWM) next to the idle figure on
  Linux. Informational only; the gate stays an idle number.
- **I-3, the code half** — `install.sh` sent the build's output to `/dev/null`,
  so an OOM-killed compile exited under `set -e` with no message. Output now goes
  to a log whose tail is printed on failure, and exit 137 is named as memory.

### Verified, and not verified

Verified locally (macOS, no Docker daemon): typecheck, lint, and the existing
test suite; the idle RSS gate (35.9MB); and the following, by throwaway scripts
that were NOT committed (N-14 — the two that matter are now tests, see below): the new Caddy client against a fake admin API on a unix socket
(first deploys insert ahead of the catch-all, redeploys patch in place,
`ensureRoute` writes nothing when unchanged); the peer classifier against
public, private, mapped and IPv6 addresses; the dev server serving loopback and
LAN requests through the hook; the build-step error path, including a simulated
SIGKILL.

**Not verified against a real Docker daemon or VPS.** The proxy replacement,
the socket appearing in the bind-mounted directory with the right permissions,
`tcp_migrate_req` removing the dropped request, and a public request to :8000
receiving a 403 all need a rerun of DoD steps 8–10 and a public probe of :8000
with the report's own method.

## Review of `a619984` — the new code issues (2026-09-25)

A code review of the fix commit (`docs/VPS-TEST-2026-09-25.md`, "New code
issues") found fourteen more. All are addressed here; none has run against a
real Docker daemon yet.

### D32 — BuildKit's API is a unix socket too (N-1)

`buildkitd` listened on `tcp://0.0.0.0:1234` inside a privileged container on
the `musdash` network — the C-2 hole on the other sidecar, with a worse payoff:
any app could run arbitrary builds on the host's CPU and memory, and fill or
prune the build cache. D29's reasoning transfers exactly, and so does its fix.

- **`--addr unix:///run/musdash-buildkit/buildkitd.sock`**, in
  `$MUSDASH_DATA_DIR/buildkit` (0700) bind-mounted into the container, with
  `--group` set to musdash's gid. buildkitd creates the socket 0660 owned by
  `root:<group>` and leaves an existing parent directory alone (containerd's
  `mkdirAs` only creates a missing one), so musdash can connect and nobody else
  on the host can reach the directory.
- **No published port, and `MUSDASH_BUILDKIT_ADDR` is removed.** buildctl and
  railpack are handed `unix://…` from `config.buildkitAddr`, which is now
  derived. A stale line in `musdash.env` is ignored.
- **The readiness probe speaks HTTP/2 over the socket**, the same preface probe
  as before. The published-port gate is gone with the port.
- **An outdated daemon is replaced** (`musdash.builder_spec=2`), keeping
  `musdash-buildkit-cache`. Unlike the proxy this needs no preflight: no traffic
  flows through a build daemon, and the job queue guarantees no build is running
  while the bootstrap is.

### N-2 — the proxy replacement is proven before the old proxy is removed

D29 accepted "no rollback". The reviewer's point stands: a rejection of the new
definition is detectable before the old proxy is touched, and was not checked
for. `ensureCaddy()` now runs a **preflight** when replacing: a throwaway
`musdash-caddy-preflight` built from the same spec, minus the published ports,
the named volumes (two Caddys must never share a certificate store) and the
musdash network, with its own socket directory. It must run and answer on its
admin socket within 20 seconds. That exercises the image, the sysctl, the bind
mount and the socket's permissions — everything except the :80/:443 bind the
live proxy holds. On failure the old proxy keeps serving, and the error carries
the preflight's last log lines, which are otherwise lost with the container.

Separately, a proxy created in this run that fails to start or to become ready
is now removed. It carries the current spec label, so the next bootstrap would
otherwise adopt the broken container forever instead of creating a fresh one.

### N-3 — a resource cannot take the dashboard's hostname

The domain form now refuses the dashboard's hostname, and `routeHosts()` strips
it from every resource's route whichever way it arrived: an auto subdomain that
collides, or a dashboard host set after the domain was attached. Saving the
dashboard hostname now runs the route sync first, so an existing resource route
gives the name up before the dashboard's route claims it.

### N-4 — what is and is not settled about I-1

Settled from source: Caddy starts the new config before stopping the old
(`caddy.go`: `run(newCfg)`, then `unsyncedStop(oldCtx)`), so a reuseport peer
exists for the migration to go to. And a connection Go has already accepted is
not at risk mid-handshake: `Shutdown` treats a `StateNew` connection as idle only
after five seconds, and Caddy's grace period is unbounded.

Not settled: HTTP/3 on 443/udp is outside `tcp_migrate_req`, and the
unexplained failure 20 seconds before the redeploy switch has no candidate cause
in the switch itself — on a 512MB host during an image pull, memory pressure is
the likelier one. Only a re-run of DoD steps 9–10 closes I-1. On a kernel older
than 5.14, every deploy now says so in its own log at the switch, rather than
only in a bootstrap warning nobody reads.

### N-9 — the musdash network's own subnets are trusted

The peer check admitted only the private ranges, so a host whose Docker
`default-address-pools` hands out public space would have the dashboard refuse
its own proxy. The reconciler now reads the musdash network's subnets at startup
and on every tick (a Docker read, never on a request) and the check admits
them too. A failed read keeps the previous list. The reachability probe reports
a 403 as exactly this, instead of blaming the firewall.

### N-10 — the deploy peak is logged by every deploy

A boot-and-idle run cannot see a deploy peak. Every deploy now logs
`peakRssMb` (the process's lifetime high-water mark) and `rssMb` on its
"deploy finished" line, so the figure M-4 asked for is recorded on real hosts.
The gate script's peak line says it covers boot and idle only.

### N-12 — the route sync removes as well as writes

`syncResourceRoutes()` now makes Caddy's resource routes match the database in
both directions. A route exists exactly for a resource that is desired running,
has a port, and has at least one host. Any other `musdash-*` route is deleted,
and the dashboard's two are never touched. "Zero hosts" must mean "no route":
a resource route with an empty host list has no matcher, which would make it a
catch-all ahead of the dashboard's. A desired-running resource whose container
is momentarily down keeps its route, because the reconciler is about to redeploy
it. Adding or removing a domain enqueues a new `sync_routes` job, so the change
reaches Caddy immediately instead of at the next deploy. Stopping a resource
deletes its route.

### Minors

- **N-5, N-6, N-7** — the stale comments on how routes are created, on the
  firewall being the boundary, and on the dashboard binding loopback are
  corrected.
- **N-8** — the 403, 404 and 500 bodies are rendered from
  `src/views/pages/status.eta`, so no user-facing sentence lives in
  `src/http.ts`.
- **N-11** — the Settings "applying" note is hidden only on the redirect from
  the hostname save itself (`&saved=host`), not by any flash.
- **N-13** — accepted for now, and recorded where it will be found: the proxy
  bootstrap reads kernel support from musdash's own `/proc`, and both sidecar
  sockets need a filesystem shared with the daemon. `DockerClient` stays
  neutral; Phase 5 (remote servers) has to ask the remote host for both.
- **N-14** — the verification claims above were true but not reproducible.
  The two that guard regressions are now tests: `src/caddy/client.test.ts`
  (route order, patch in place, no-op `ensureRoute`, the Host header) against a
  fake admin API on a unix socket, and `src/http.test.ts` (the peer classifier,
  trusted subnets, fail-closed, `X-Forwarded-For` ignored). This widens
  CLAUDE.md's four-area testing policy by two, deliberately: C-1 and the
  dashboard exposure were each one careless edit away from shipping again, and
  the policy's own test of "where the real bugs are" now includes both.

### What the Validator found in the fixes, and what changed

- **Critical, and older than all of this: a malformed request's body reached
  the error log.** Elysia 1.4 builds a `ValidationError` message as JSON with
  `found: <the whole body>`, in production mode too, and validates before any
  handler — so an env form that failed its schema (a missing `csrf` is enough)
  wrote the decrypted values in its textareas to the journal at error level,
  against "never log a decrypted env value". `handleError` now logs only the
  method, path and code for `VALIDATION` and `PARSE`, answers 400, and a test
  spies on every log level to prove the body never appears.
- **N-3 had a hole**: a wanted resource whose container was down at sync time
  kept its old host list, so a name that had just become the dashboard's could
  come back with the container. The sync now rewrites the hosts of such a route
  anyway, keeping the upstream it already dials.
- **N-4 checked the wrong thing**: the deploy note asked the host kernel, not
  the running proxy. The proxy now carries `musdash.proxy_migrate=1|0`; the
  deploy log reads that, and a proxy created without the sysctl on a kernel
  that now has it is replaced through the same preflight.
- **A sync must not change a live route's port.** The database port can be
  ahead of the running container (edited for the next deploy), so the sync
  keeps the port an existing route dials and only the deploy moves it, after
  its health gate. A deploy that ends with no hosts or no port now deletes the
  route instead of leaving it on the container it is about to remove.
- **Cleanup scope.** A freshly created proxy is removed only if it never came
  up (start, restart check, admin socket); a later `verifyServing` false
  negative leaves it for the next bootstrap to re-check rather than turning into
  an outage. BuildKit gets the same never-came-up cleanup, and a `builder_gid`
  label so a changed gid replaces the daemon instead of adopting a socket this
  process cannot open. Stale sockets are removed before a fresh create and
  before every preflight; cleanup failures are logged, not swallowed.
- **The reconciler probes BuildKit's socket**, not just its running flag, so
  a daemon whose socket is unusable is re-bootstrapped.
- **The 403 page is self-contained** (`src/views/forbidden.eta`, styles
  inline), because the peer who sees it is refused `/assets` too. A failed
  subnet read warns once per outage instead of logging at debug.

### Verified, and not verified

Verified locally (macOS, no Docker daemon): `bun run check`, the full test
suite including the 33 new tests, and the idle RSS gate.

**Not verified against a real Docker daemon or VPS:** the BuildKit socket and
its `--group` permissions, the proxy preflight, `sync_routes` removing a stale
route, and the trusted-subnet refresh. They join the list in the VPS report's
"Needs a real Docker daemon or VPS" section.

## BuildKit's memory cap is sized from the host (V-1, 2026-09-25)

The 1GB re-test (`docs/VPS-TEST-2026-09-25.md`, V-1) found BuildKit capped at a
fixed 1 GiB on a host with 961 MiB: `docker stats` showed the limit as the whole
host, so the invariant "every container has a hard memory limit" held on paper
and limited nothing.

### D33 — the cap is computed from the Docker host's memory

**The premise was tested before the fix.** On the 1GB VPS (cgroup v2, kernel
6.8.0-51) the running daemon was capped by hand at 384 MiB and a build step
allocated 50 MiB a second. The kernel killed that step inside the
`musdash-buildkit` container's cgroup (`CONSTRAINT_MEMCG`, not a global OOM),
buildkitd stayed up, the host bottomed out at 166 MiB available and recovered,
and the dashboard and an app answered throughout. Build steps are charged to
the daemon's container, so a cap smaller than the host contains a runaway
build. Recorded in the VPS report as "V-1 premise test (before the fix)".
**Proven on cgroup v2 only; not verified on cgroup v1.**

**The formula** (`src/build/memory.ts`, all MiB):

```
raw     = min(MemTotal − 576, floor(MemTotal / 2))
stepped = floor(raw / 32) × 32
cap     = clamp(stepped, 192, 8192)          floored = stepped < 192
```

The terms cross at MemTotal = 1152: below it the fixed reserve binds, above it
the half-of-host rule does.

| Host  | MemTotal used      | − 576 | ÷ 2   | 32-step of min | **Cap**            |
| ----- | ------------------ | ----- | ----- | -------------- | ------------------ |
| 512MB | ~470 (est.)        | −106  | 235   | −128           | **192** (floor)    |
| 512MB | 512 (nominal)      | −64   | 256   | −64            | **192** (floor)    |
| 1GB   | **961 (measured)** | 385   | 480   | 384            | **384**            |
| 1GB   | 1024 (nominal)     | 448   | 512   | 448            | **448**            |
| 2GB   | ~1950 (est.)       | 1374  | 975   | 960            | **960**            |
| 2GB   | 2048 (nominal)     | 1472  | 1024  | 1024           | **1024**           |
| 4GB   | ~3900 (est.)       | 3324  | 1950  | 1920           | **1920**           |
| 4GB   | 4096 (nominal)     | 3520  | 2048  | 2048           | **2048**           |
| 8GB   | ~7900 (est.)       | 7324  | 3950  | 3936           | **3936**           |
| 8GB   | 8192 (nominal)     | 7616  | 4096  | 4096           | **4096**           |
| 16GB+ | ≥16384             | —     | ≥8192 | —              | **8192** (ceiling) |

Only the 1GB row rests on a measurement. The table is reproduced by the
command in the slice's criterion 5, which evaluates the module directly.

**MemTotal comes from the daemon**, through a new read-only
`DockerClient.info()` (`GET /v1.44/info` → `MemTotal`, int64 bytes), never from
musdash's own `/proc`. Once the daemon is remote (Phase 5) the two are different
machines, and a cap sized from the wrong one limits nothing. `info()` throws a
`DockerError` unless `MemTotal` is a positive integer, so a malformed answer
fails the bootstrap instead of becoming a NaN limit.

**The reserve is 576 MiB: what must survive while a build runs.** Recorded on
the 1GB host at idle with two nginx apps, 2026-09-25 16:54 UTC:

- `free -m` available: 510, 535 and 536 MiB in three readings;
- musdash 63, Caddy 67, BuildKit 66–69 (its cgroup `memory.current`), the two
  apps ~14 together — 210 MiB in musdash and its containers;
- so OS + dockerd + containerd ≈ 961 − 535 − 210 ≈ **216 MiB**.

The reserve then counts musdash at its deploy peak rather than idle (128, V-3),
Caddy 67 and the apps 14: 216 + 128 + 67 + 14 = **425 MiB measured**. The rest,
~150 MiB, is margin that has not been measured: the `railpack` and `buildctl`
client processes and dockerd/containerd's spike while `/images/load` imports
the built image — all host processes, outside BuildKit's cap — and the file
pages the kernel must keep resident to avoid C-3's eviction loop. ≈ 575 → 576.
On the 1GB host, 425 + 384 = 809 MiB leaves ~150.

With the 510 reading instead of 535, the measured part is 450 and the total
≈ 600, above 576. The number does not rest on choosing 535: the premise test
observed the margin directly — with BuildKit at its 384 MiB cap the host still
had 166 MiB available.

- **The reserve covers the measured workload only** — two idle nginx apps.
  Every further running app, up to its own 512 MiB cap, eats into what is left.
  A host running many apps and building on the same box can still run out; the
  cap bounds the build, not the sum.
- **It must be revisited if V-3 moves.** musdash's 128 MB deploy peak is one of
  its terms.

**Half above the crossover.** A resource's old container keeps serving through
its own rebuild — the zero-downtime guarantee — so a build must not be able to
push out what is serving: half to the build, half to everything else. It also
reproduces the old 1 GiB on a 2GB host, the size RUNNING.md recommends for
building.

**The floor is 192 MiB.** buildkitd idles at ~66 MiB on the 1GB VPS; 192 leaves
~125 for one small step. Below that the daemon's first build is killed in its
own cgroup. It does **not** make a 512MB host safe to build on, and no cap in
buildkitd's working range can: that host had 181 MB available at idle after
install, and 126 MB of BuildKit growth plus musdash's +65 MB deploy peak uses
all of it. What to do about 512MB hosts is C-3's decision; this slice only
makes the floor visible with a warning when a daemon is created on it.

**The ceiling is 8 GiB.** It binds only at 16 GiB and up. It is a judgement
against a leaking build on a big host, not a measurement.

**The 32 MiB step** keeps the number round. 32 rather than 64 so a "1GB" host a
few MiB smaller than 961 does not lose a whole 64 MiB step. Any step makes the
cap boundary-sensitive: two hosts a few MiB apart can get caps 32 MiB apart
(961 → 384, 993 → 416). The cap and the host's memory are therefore logged on
every boot (`memoryMb`, `hostMemoryMb` on the "started" and "adopted" lines),
which also guards the one silent failure mode — a unit error such as reading
MemTotal as kilobytes would put every host on the ceiling.

**The override, `MUSDASH_BUILDKIT_MEMORY_MB`.** The formula cannot see swap
(`/info` does not report it, and swap is the likely fix for C-3) or memory used
outside Docker. It also **lowers** the cap on 1GB and ~2GB hosts, so a build
that passed before the upgrade may run out of memory after it, and without an
override the only remedy would be a bigger VPS. `MUSDASH_BUILD_CACHE_GB` is the
precedent for disk.

- Validated by zod as an integer ≥ 192, the formula's own floor; below that, or
  not a number, musdash refuses to start with "Invalid configuration".
- At or above MemTotal it **fails the bootstrap** with both numbers — a cap
  that large limits nothing — before any container is looked up or removed, so
  the running daemon is untouched. It is never clamped: an explicit setting is
  not silently replaced by the computed value.
- **The upper bound alone does not prevent V-1.** An override just under
  MemTotal brings it back in practice, so every bootstrap with an override
  above the computed cap — creating or adopting — logs a warning naming both
  numbers. Adopting matters: after the host shrinks, the label still matches.
- If a daemon created with an override exits while starting, the error says the
  cap came from `MUSDASH_BUILDKIT_MEMORY_MB` and may be too low.

**The label bump.** `musdash.builder_spec` goes from `2` to `3`, and a new
`musdash.builder_memory_mb` records the cap the daemon was created with. The
adopt-or-replace check requires spec, gid and memory to match. The memory label
is needed on top of the generation bump because a memory limit is fixed at
create time and adoption never recreates: without it, a 1GB host resized to
2GB would keep its 384 MiB daemon forever and RUNNING.md's remedy would do
nothing. An override change, or its removal, takes effect the same way. A
replacement costs one daemon restart — no traffic flows through BuildKit, the
queue guarantees no build is running, and `musdash-buildkit-cache` survives.

The replacement warning names the actual reason, first match wins, with a
`reason` field (`d32` | `gen2` | `gid` | `memory` | `gid+memory`) plus
`oldMemoryMb` and `newMemoryMb`:

1. no spec label, or one other than `2`/`3` → D32's "API was reachable" wording
   (a newer value after a downgrade lands here too; imprecise, but still right
   to replace);
2. spec `2` → created before the cap was sized from the host (D33);
3. spec `3`, gid differs → names the old and new gid, and adds the memory
   change in the same line when that differs too. Before this slice a gid
   change was wrongly reported with the D32 wording;
4. spec `3`, memory differs → "memory cap changed from <old> MiB to <new> MiB".

**Why Caddy's fixed 512 MiB cap is not in this slice.** On a 512MB host it has
the same shape — the cap is at or above MemTotal (~470), so it limits nothing —
while on 1GB it does limit Caddy. It stays out: the invariant's threat is user
code, and Caddy runs none; D7 recorded the fixed value deliberately; and
changing the proxy's definition bumps `musdash.proxy_spec`, which runs the
preflight and a **visible proxy restart on every install** — an outage BuildKit's
replacement does not have. Whether 512MB is supported at all is C-3's decision.
A follow-up gated on C-3 can reuse `DockerClient.info()`.

Out of scope and still open: swap in `install.sh` or a minimum host size (C-3,
I-3), counting swap in the formula, V-3 itself, a CPU cap for BuildKit, and
turning a build step's exit 137 into an "out of memory" line in the deploy log.

### Verified, and not verified

Verified locally (macOS, no Docker daemon): `bun run ci`, the unchanged test
suite, the formula against every row of the table above, and the override's
parsing (unset → the formula; `64`, `191` and `abc` → "Invalid
configuration"). Before building: `MemTotal` is `SystemInfo`'s int64 of bytes
in the Engine API v1.44 spec.

**Not verified against a real Docker daemon or VPS:** `info()` against a live
Engine, the gen-2 → gen-3 replacement keeping the cache, the override replace
and reject paths, and a runaway build under the computed 384 MiB cap through a
real deploy. The premise test above used a hand-set cap, not this code.

## Sign-in hashing is bounded (V-3, V-2, 2026-09-25)

The 1GB VPS logged `peakRssMb: 128` after the first deploy and V-3 blamed
deploys. Measuring before planning showed otherwise: a redeploy with no pull
raised the process peak to 61 MB, a deploy that pulled a new image to 67 MB.
The 128 MB came from argon2id at Bun's default `m=65536,t=2,p=1` — 64 MiB per
hash or verify — run for the account setup and the first sign-in just before
that deploy. `peakRssMb` is the process's lifetime high-water mark, so the
deploy was blamed.

### D34 — argon2id at 7 MiB, one operation at a time

**Parameters.** argon2id stays (fixed stack) at `m=7168 KiB, t=5, p=1`. The
OWASP Password Storage Cheat Sheet
(https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html,
checked 2026-09-25) lists five argon2id settings that "provide an equal level
of defense", trading CPU for RAM: m=47104 t=1, m=19456 t=2, m=12288 t=3,
m=9216 t=4, m=7168 t=5 (all p=1). Its summary line asks for "a minimum
configuration of 19 MiB of memory, an iteration count of 2"; 7168 is below
that headline figure and is justified by the list's equivalence statement.
Memory is this product's constraint, and m×t is 35,840 here against 36,864 to
47,104 for the others, so the smallest block costs nothing in CPU. The unit is
KiB (bun-types 1.4.0 `bun.d.ts`: "Memory usage, in kibibytes"), proven at
runtime by the PHC string Bun writes: `$argon2id$v=19$m=7168,t=5,p=1$`. One
hash takes ~11 ms on an Apple M5; expect several times that on a 1 vCPU VPS.

**One gate.** `src/password.ts` is the only file that calls `Bun.password`.
Every hash and verify passes a single in-process gate: one runs at a time,
at most `MAX_WAITING = 8` wait in order, and the next attempt is refused with
a 503 "busy" page before anything is allocated. Bun runs these operations on
worker threads, so without the gate concurrent attempts each held their own
block, up to the width of Bun's worker pool (measured locally: 30 parallel
hashes at 7 MiB took RSS from 10 to 105 MB, so not all 30 ran at once, but
many did). With it, argon2 holds one block at a time whatever N is. Eight
waiters because there is one legitimate user, and eight queued operations wait
about a tenth of a second locally (~11 ms each); a 1 vCPU VPS is several times
slower, still well under a second. The gate is decided by queue length only,
never by the email, and the old `.catch(() => "")` on the unknown-email path
is gone: it answered a busy unknown email with an instant "incorrect" while a
busy known email got a 503, which revealed whether an address had an account.

**Rehash on sign-in.** Hashes written before this change still verify — the
parameters travel in the PHC string — but cost 64 MiB each. A successful
sign-in against one rewrites it at the new parameters, with an `UPDATE`
conditional on the hash just verified. A failed rehash logs only
`{ userId, errorName }` and the sign-in still succeeds. The error object is
never logged: drizzle 0.45's `DrizzleQueryError` message can embed the query
parameters, i.e. the new and old hash. The SQLite errors seen so far (e.g. a
UNIQUE violation) carry no parameters, but the rule has to hold for every path
that might. Until the owner next signs in with a password — with 30-day
sessions, possibly weeks — anyone can still make the server run the old
64 MiB verify, one at a time; serialized old-parameter verifies were seen to
level off at idle + ~97 MiB locally, and the window's bound is the measured
128 MB, not arithmetic. Timing between a known and an unknown email differs
during that window and matches after it.

**A task that never settles** would hold the gate's slot forever: the eight
waiters hang until their clients give up and every later sign-in gets a 503
until restart. Only `Bun.password` runs behind the gate, and it always
settles, so this is accepted rather than guarded with a timeout.

**Throttled log.** A busy rejection logs at most once a minute: the first
immediately, later ones counted and reported by the next line or by one timer
at the end of the window. A flood cannot fill the journal, and no line ever
carries an email, password or hash.

**Measured (compiled binary, macOS, fresh data directory).**

|                                                            | Before                                           | After                                                                                                                                                                      |
| ---------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Memory per hash/verify                                     | 64 MiB                                           | 7 MiB (measured +7.9 MiB for one setup hash)                                                                                                                               |
| 50 concurrent bad sign-ins                                 | concurrent 64 MiB blocks, up to Bun's pool width | ~10 answered "incorrect", ~40 answered 503 `retry-after: 2`, none 500, for unknown and known emails alike (runs split 10/40 and 9/41; the split depends on arrival timing) |
| Process peak through setup, sign-in and a 50-request burst | —                                                | run 1 (builder): idle 44.9 → max 75.1 MB (+29.5); run 2 (reviewer): idle 44.2 → max 69.3 MiB (+24.6)                                                                       |

The brief's criterion 12 set +25 MB for that last row: run 1 missed it, run 2
met it, so the threshold sits inside run-to-run noise. The miss was accepted
explicitly at the approval gate, not waved through. The growth is not argon2: 50 concurrent `GET /setup` with no hashing at all raised RSS
from 44.7 to 59.1 MB, and 50 concurrent `POST /setup` rejected by validation
to 62.9. About 18 MB is Bun and Elysia holding 50 requests at once; argon2's
share is the ~8 MiB above. That leaves ~3.5 MB of run 1's +29.5 unexplained,
and it is recorded as such rather than assigned a cause. The bound that matters is re-measured on the 1GB
VPS (V-3 criterion 13, target `VmHWM` ≤ 85 MB, was 128).

**Residuals, named.**

- **Request bodies (B-1).** Elysia buffers each request body before any
  handler runs, and nothing sets `maxRequestBodySize`, so Bun's 128 MB
  default applies per request. Concurrent large POSTs to `/login` can still
  buffer that much each before the gate is reached. Pre-existing, unrelated to
  argon2, its own slice. **Fixed by D35**: bodies are now capped at 1 MiB, and
  forms at 256 KiB before parsing.
- **CPU.** A sustained flood keeps one core busy running argon2 back to back,
  and the owner's own sign-in may be answered 503 during it; existing sessions
  keep working.
- **No per-IP limiting.** Behind Caddy the TCP peer is Caddy, so a limiter
  would key on `X-Forwarded-For`, which D31's trusted-peer rule would let any
  private peer forge. That needs its own decision.

**Tests.** `src/password.test.ts` widens the test policy by one file, like
N-14 did: a gate that fails to release locks the only user out for good, and a
misread `memoryCost` unit silently brings V-3 back. Neither shows in a
click-through. It covers the parameters in the written hash, `needsRehash`,
one-at-a-time ordering, the waiting bound, and release on error; each was
checked to fail when the code is broken.

**V-2.** The VPS reads 57–63 MB idle where the macOS gate reads ~36 MB. On
Linux about 40 MB of that is `RssFile` — clean pages of the mapped compiled
binary, reclaimable — and ~18 MB `RssAnon`, musdash's own heap. `bun run rss`
now prints that split on Linux. The gate still judges the total, which is the
conservative number, and CI's Linux run is the one to trust.

**D33 knock-on.** D33's 576 MiB reserve counted musdash at 128 MB, which was
argon2, not deploys. With this change about 55 MiB of it is unmeasured slack.
It is not re-sized until the VPS re-measure.

### Verified, and not verified

Verified locally: `bun run ci`, `bun test` (163 pass), the parameters in the
written hash, the 503 path for both email kinds, the busy log lines, the
rehash of a literal old hash on sign-in, and the tests failing when the gate
or parameters are broken. Not verified: anything on the 1GB VPS (criteria 13
and 15), and criterion 14 as written (medians timed inside the handler). An
end-to-end stand-in with curl — 3 runs, known vs unknown email — put the
medians within 1% (~11.6 ms each); that is not the instrumented measurement
the criterion asks for, and the omission was accepted at the approval gate.

## Request bodies are bounded (B-1, 2026-09-25)

Found while reviewing V-3: nothing set `maxRequestBodySize`, so Bun's default
of 128 MB applied to every request, and Elysia reads and parses the whole body
before a handler runs. Measured on the compiled binary: three concurrent
100 MiB `POST /login` requests grew RSS by **502 MiB**. Two would exhaust the
1GB VPS; the sign-in page is public.

### D35 — 1 MiB for everything, 256 KiB for forms, checked before parsing

**Two limits.** Bun's `maxRequestBodySize` is server-wide, so it is set to the
largest thing musdash legitimately receives: 1 MiB, the GitHub webhook's
allowance. It covers every path and every peer, including private peers that
reach :8000 directly (D31). Every other request is held to 256 KiB by a
global `onRequest` check on `Content-Length`, which runs before Elysia parses
the body and answers with a 413 page from `status.eta`. A `Content-Length`
that is not a plain integer (for example Bun joining two identical headers
into `"100, 100"`) is refused with a 400, so it cannot slip past the form
limit. A body with no `Content-Length` (chunked) is held only to the 1 MiB
ceiling. `src/index.ts` registers one hook, `guardRequest`, which rejects
public peers first (D31) and checks size second.

**Why these numbers.** The largest real form is the three env-var boxes:
200 variables with a few PEM keys is 20–40 KiB before URL-encoding, so
256 KiB is several times a heavy paste. musdash reads three fields from a
push webhook (`ref`, `deleted`, `repository.full_name`); typical pushes are
10–80 KiB, and 1 MiB covers a few hundred to about a thousand commits.
GitHub's own 25 MB cap was rejected because Bun's limit is server-wide:
allowing it for the webhook would allow it for `/login` too.

**The accepted cost.** A push whose payload is over 1 MiB is refused by Bun
before musdash sees it. It does not auto-deploy, musdash logs nothing, and
GitHub shows a failed delivery. Realistic causes: the first push of a
long-lived branch (up to 2048 commits) or one commit touching thousands of
files. The Deploy button still works. RUNNING.md says so.

**What Bun does, measured** (Bun 1.4.2, Elysia 1.4.29; plan reviewer's
throwaway scripts, then the builder's harness on the compiled binary):

- `Content-Length` over the ceiling: Bun's bare `413` with `Connection: close`
  as soon as the headers arrive, before any musdash code. Exactly at the limit:
  accepted. This bare 413 is Bun's response, not a string of ours — the one
  accepted exception to "user-facing strings live in templates".
- Chunked over the ceiling: also Bun's bare 413 and close. Elysia's `onError`
  still runs afterwards, but its response is never delivered. On the webhook
  it arrives as `UNKNOWN` with the message
  `"Request body exceeded maxRequestBodySize"`, which used to log at error
  level; `handleError` now matches that message and logs it at warn with only
  `{ method, path }`. If Bun rewords it, only the log level is lost.
- Answering early without reading the body: Bun reads and discards the rest
  and the connection is reused (a follow-up `GET /health` on the same
  connection returned 200). A handler that waits before reading makes Bun stop
  reading the socket. Unread bodies are therefore not held in memory; reading
  one costs about 1.7× its size.
- `Content-Length` framing is enforced, and `Content-Length` together with
  `Transfer-Encoding: chunked` gets a 400 and a close. Those are the two
  smuggling shapes that were tried, and both were refused.

**Measured after the change** (compiled binary, macOS `ps` RSS every 100 ms,
fresh data directory). Reproduce with `scripts/measure-body-limits.ts`
(scenarios `c10`, `c11`, `c12`; for the "before" column, pass a binary built
from a commit before D35):

| Load                                       | Before                  | After                                                             |
| ------------------------------------------ | ----------------------- | ----------------------------------------------------------------- |
| 3 × 100 MiB `POST /login`                  | 400 × 3, **+502.1 MiB** | 413 × 3, **+0.0 MiB**                                             |
| 50 × 1000 KiB `POST /login`                | —                       | 413 × 50 with the template page, +11.2 MiB                        |
| 50 × 1000 KiB webhook, bad signature       | —                       | 202 × 50 (no App registered), +19.5 MiB                           |
| chunked 2 MiB `/login`, `/webhooks/github` | —                       | 413 each; one warn line each, no error line, no body bytes logged |
| `bun run rss` idle, 3 runs                 | 36.8 / 39.6 / 39.8 MB   | 39.7 / 39.4 / 39.6 MB (medians equal)                             |

**Many connections at once.** The worst case is now about 3.4 MiB per request
(a 1 MiB webhook body held as buffer, string and HMAC input, plus ~0.36 MiB of
fixed per-request cost measured under D34). That takes about 150 concurrent
requests to exhaust the 1GB host's idle headroom, or about 44 to eat D33's
build margin — up from two and one. No in-flight cap was added: a counter that
fails to release would answer 503 to every POST and lock the only user out —
D34's argument without D34's guarantee that the task always settles — and the
threshold is now high. It is NOT true that a JavaScript counter cannot bound
Bun's buffering: Bun does not hold unread bodies, so a gate placed before the
read would work. For the same reason a 25 MB webhook allowance behind a
one-at-a-time read gate is technically possible and is a follow-up, not this
slice. The aggregate across many connections is the same residual as D34's
"no per-IP limiting".

**Caddy `request_body` rejected.** It would not cover private peers on :8000,
so Bun's limit is needed regardless; the hook already separates forms from
the webhook for every peer; Caddy's rejection is a bare page that bypasses the
template; and it would mean a dashboard-only branch in `routeBody`, the code
C-1 broke once, where a change in shape rewrites every resource route on
upgrade. Resource routes get no body limit from musdash: user apps own theirs.

**Tests.** One `describe` group in the existing `src/http.test.ts`, an area
N-14 already added: a real Elysia app on `serveOptions()` checks both limits,
the webhook exemption, the malformed-header 400, and the warn-level log.
Setting the ceiling back to 128 MiB makes exactly the ceiling test fail.
Without it, deleting `maxRequestBodySize` or a Bun upgrade that stops
honouring it would silently bring B-1 back.

### Verified, and not verified

Verified locally: everything in the table, `bun run ci`, `bun test`
(173 pass). Not verified: behaviour through Caddy on the VPS (criterion 13) —
in particular whether Caddy relays Bun's 413 for a body over 1 MiB or reports
a 502 after Bun closes the connection, and a real push delivery's payload
size.

## Exactly one account, enforced by the database (S-1, 2026-09-25)

Found while planning V-3. `POST /setup` checked `hasAdminUser()`, then awaited
the password hash, then inserted. Two setups landing inside that gap — two
tabs, or someone racing the owner at first boot — could both pass the check
and create two accounts with different emails. A double-submit with the same
email hit `users.email UNIQUE` and answered with a 500. musdash is single-user
by design, and a raw 500 must never reach the browser.

### D36 — a unique index on a constant, and nothing is ever deleted

**The guarantee lives in the database.** Migration `0004_single_user` adds
`CREATE UNIQUE INDEX idx_users_single ON users((1))`: an index on a constant
expression, so every row has the same key and a second row cannot be written
by any code path, current or future. Verified on Bun 1.4.2 / SQLite 3.51.0: a
second insert, with a different or the same email, throws a raw `SQLiteError`
with `code` `SQLITE_CONSTRAINT_UNIQUE` (drizzle 0.45's `.run()` does not wrap
it). A re-check just before the insert would also have closed the race — with
one connection and synchronous `bun:sqlite`, a check and an insert with no
`await` between them cannot interleave — but it guards one code path, and the
index guards them all. The check before hashing stays, so argon2 does not run
once setup is done.

**What the losing request sees.** `createUser` maps the unique violation to a
typed `AccountExistsError`, and `POST /setup` answers it with `303 /login` —
what `GET /setup` already does once an account exists. A double-clicking owner
lands on sign-in with the credentials they just typed. Any other insert error
is logged as `{ errorName, code }` only and rethrown with a fixed message:
`handleError` logs `String(error)`, and a future driver that wrapped the error
with its query parameters would otherwise put the hash in the journal (D34).

**Installs that already have two or more accounts.** Possible today, though
realistically rare or absent: only the race creates them, and an install that
has one can no longer hit it, since setup closes once any account exists. The
one known install, the 1GB VPS, has one. For such an install the migration
keeps the oldest account (ordered by `created_at`, then `id`) and **moves**
the others, with their sessions deleted, into `users_removed_0004`, a STRICT
table with the same columns. Nothing is destroyed; recovery is manual. The
table is deliberately not in `schema.ts` — nothing reads it. It matters
because the oldest row is not necessarily the owner's: if someone won a
first-boot race, theirs is the oldest, and deleting the rest would have
destroyed the owner's own account. After the migration commits, one error
line names the kept and moved addresses and the table, and tells the owner to
reinstall if the kept address is not theirs. A rolled-back migration logs
nothing.

Rejected: refusing to start (a failed migration takes the dashboard down, and
the host has no `sqlite3` to fix it by hand); a partial unique index (it still
admits one new row next to the old ones, keyed on application-written text);
skipping the index while duplicates exist (the invariant would stay off
exactly where it is already broken, with both accounts able to sign in).

**The runner moved, unchanged.** The migration list and the runner now live in
`src/db/migrations.ts`, which opens no database; `src/db/migrate.ts` calls it
with the real one. Transaction per migration and applied-tracking are as
before, and migrations are still static text imports (trap 6). A migration may
carry a `before` hook that runs inside its transaction and returns what to log
after the commit.

**Tests.** `src/db/single-user.test.ts` widens the test policy by one file, for
the same reason as N-14 and D34 — a regression one careless edit away that no
click-through would show. It runs the **full shipped list** of migrations, so
a later migration that rebuilds `users` and drops the index fails it; removing
the index line, or adding a throwaway rebuild migration, was checked to fail
it. It also runs the two-account upgrade with foreign keys on and off, and
checks the moved row arrives intact.

### Verified, and not verified

Verified locally on the compiled binary: 20 concurrent setups with different
emails, and 20 with the same email, each left exactly one account — one
`303 /`, the rest `303 /login` or the gate's 503, zero 500s — with no hash,
password or `request failed` line in the log. A database given two accounts
by the pre-D36 binary upgraded to one account plus the other moved
byte-for-byte into `users_removed_0004`; the kept account signs in, the moved
one does not. A one-account upgrade kept the existing session working.
`bun run ci`, `bun test` (179 pass). Not verified: the browser double-click
(criterion 14) and the upgrade on the 1GB VPS (criterion 18). Noted: the
argon2 gate's busy warn says "sign-in busy" for setup requests too; the
wording lives in `src/password.ts`.

## Refusals are pages, not bare text (V-4, 2026-09-25)

The 1GB re-test found that refusing the dashboard hostname as a resource
domain answered `409` with the words "that is the dashboard's own address" as
the whole page: no layout, no title, no way back. It was one of 39
`return status(4xx, "…")` calls in `src/routes/app.ts`, which Elysia 1.4
answers as `text/plain`. The two CSRF refusals (`app.ts`'s global guard and
`/logout`) were the same, and they are the most likely to be seen: any tab
left open from an earlier sign-in holds a stale token. Every one broke
"user-facing strings live in templates" and "show the user something useful".

### D37 — a keyed notice for what the UI can cause, a status page for the rest

**Errors a user can reach through the UI redirect back.** A duplicate name, an
invalid image reference, a missing repository, a bad branch, a bad, taken or
dashboard-owned domain, an env box that does not parse, and the GitHub
connect, callback and disconnect failures answer `303` to the page and tab
the form lives on, with `error=<key>` in the query. `src/routes/errors.ts`
lists the 15 keys; `src/views/partials/errors.eta` is the only place that
turns a key into a sentence, and the layout's existing notice shows it — the
one flash path UI-UX #24 asked for. The GET handlers accept a key only by
membership in the list, and the partial matches literal strings rather than
looking the key up in an object, so `__proto__`, markup or free text renders
nothing and is never echoed. A crafted link can show one of 15 fixed
sentences; that is accepted, since it carries no text of the sender's and
triggers nothing. Error redirects carry no `#fragment`, which would scroll the
notice out of view.

Redirecting loses what was typed into the dialog. Re-rendering the page with
the values instead would rebuild every page's view model in its POST handler,
reopen dialogs from script and re-run the git picker's GitHub API calls on
every failed submit, against an asset budget with about 1 KB left. For a
single-user tool whose worst case is retyping a dialog, that is out of
proportion. Where the server's rule fits an HTML `pattern` — the branch and
the domain fields — the browser now refuses first, so the common mistakes
never reach the redirect. Both patterns were checked in Chromium 152 against
the server's `isValidGitRef` and `HOSTNAME_RE` inputs; the browser is
stricter only on surrounding whitespace, which the server trims.

**Everything else is a real status page in the signed-in layout.** The 16
"not found" cases, the nine 400s that only a stale tab or a hand-made request
can reach, and both CSRF refusals render `src/views/pages/status.eta` with
the real status code, the sidebar and a link back to projects, through
`statusFor(session, status)` in `src/routes/layout.ts` (where `layout()` moved
so `auth.ts` can use it). The new 403 page says to go back and reload that
page: reloading the 403 itself would re-post the stale token. It renders only
the session's current token, in the layout's sign-out form, never the one
submitted; the refusal and its `CSRF check failed` warning are unchanged. A
route that does not exist still gets the signed-out 404 from `handleError`,
which runs without a session.

**Two folded fixes.** Creating an environment whose name the project already
has now redirects with `env-name-taken`, instead of hitting
`UNIQUE(project_id, name)` and answering 500. And an env box that does not
parse no longer puts the parser's message into the URL: that message quotes
the rejected line, which is often `KEY=secret`, and it landed in browser
history and any access log. The redirect now carries only `env-invalid-line`
or `env-scope-duplicate`; the detailed strings are dropped, not logged. The
cost is that the notice no longer names the line. Naming it safely (box and
line number, no value) needs structured errors from `src/env/parse.ts`, a
tested module, and is a follow-up.

**Left as they were.** The four 404s in `src/routes/sse.ts` (an `EventSource`
never shows a body), the asset 404, the webhook's answers, the unreachable 401
guards, `handleError`'s 400 and 413, and the free-text sentences `/settings`
already carries in its query (`flash`/`msg`), which break the same rule and
are a follow-up.

### Verified

`scripts/check-error-pages.ts` reproduces it against a compiled binary on a
scratch data directory, with Docker pointed at a socket that does not exist:

    bun run build
    bun scripts/check-error-pages.ts dist/musdash 18433

It exercises every row: each keyed redirect's exact `Location`, the notice on
the page it leads to, every table row unchanged, all 15 keys covered, a
sentinel typed into every refused field absent from every `Location`, page
and log line, garbage keys and the old `envError` parameter echoing nothing,
all 16 404s and the 400s as signed-in HTML, both 403s, and the signed-out 404. What no form can create — a connected GitHub installation, and an image
resource with no image — is seeded into the scratch database while the binary
is stopped, so musdash stays its only writer while it runs. The run's data
directory is removed; its log is kept in `$TMPDIR` for reading. Result on
macOS: 72 checks, all pass. `bun run ci` and
`bun test` (179) pass; `public/app.css` and `public/app.js` are unchanged.
Not yet run on the VPS.

## Host size and swap (C-3, I-3, 2026-09-25)

The first VPS test ran on a 512MB RamNode host with no swap. Installing came
within ~45MB of an OOM kill twice — `fwupd` during the Docker install, then the
Bun compile (I-3). Later, with only the Phase 1 stack running, apt's daily
timers pushed it into thrash (`kswapd0` at 25%, `docker ps` hung for minutes),
and after a reboot the host never answered again and needed a power cycle
(C-3). The same test on a 1GB host with no swap passed the whole Definition of
Done, reboots included. Nothing stated a minimum host size, and nothing set up
swap.

### D38 — 1 GB is the minimum; the installer adds swap below 2 GB

**The supported minimum is 1 GB**, with 2 GB recommended for building from
GitHub, as RUNNING.md already advised. That is the only size with a passing
record. 512MB is documented as unsupported until a run with swap passes the
reboot step; the installer warns below ~900 MiB of MemTotal and carries on,
since a piped install cannot ask a question, and refusing would only move the
failure somewhere less clear.

**Below 1900 MiB of MemTotal, with no swap active, `install.sh` creates a 1 GiB
swapfile** at `/musdash.swap` (0600, `sw,nofail` in `/etc/fstab`) before it
installs Docker, since the Docker install is the first dip. Without swap the
kernel can reclaim only file-backed pages, so under pressure it evicts the
executables it is running and reads them back in a loop — the thrash C-3
recorded. Swap gives idle anonymous pages of host processes (dockerd,
containerd, apt, the compile) somewhere to go instead. 1 GiB covers the
measured spikes (fwupd 188MB, Bun 163MB) with room to spare, and is small
enough that a host process leaking without bound still hits the OOM killer
rather than grinding the disk for long. `MUSDASH_SWAP=0` skips it. Hosts of 2
GB and up are left alone.

**Containers cannot use it, so every memory limit stays hard.** Every
container musdash creates — apps, Caddy, BuildKit — sets `MemorySwap` equal to
`Memory` (`src/docker/impl.ts`), which Docker on cgroup v2 turns into
`memory.swap.max = 0`. Checked on the 1GB host with the swapfile active:
`docker info` shows no swap-limit warning, and all four containers read
`swap.max=0`. On cgroup v1 without swap accounting Docker would drop that
setting and let containers swap without bound, so a v1 host gets no swap. The
Compose pipeline, when it is built, must set `memswap_limit` the same way.

**Best effort, and nothing the operator owns is changed.** Like the firewall
rules (D23, D31), the step only adds: existing swap is left as it is, and
every skip or failure is one log line, never an aborted install. It is skipped
inside OpenVZ/LXC containers (which cannot `swapon`), on a root filesystem
other than ext4 or XFS (btrfs needs a NOCOW file, ZFS has no swapfiles), and
with less than 3 GiB free on `/`. `fallocate` is tried first, with `dd` as the
fallback for filesystems that reject a fallocated swapfile. Re-running the
installer, which is how upgrades work (D22), is a no-op once swap is active; a
file left swapped off is re-enabled, and the fstab line is added only when no
line names that file.

Rejected: `vm.swappiness` or `vfs_cache_pressure` changes (a lower swappiness
biases the kernel toward evicting file pages, which is C-3's failure mode, and
they belong to the operator); disabling apt's timers (they are the operator's
security updates; the thrash is the host's lack of headroom, not apt's fault);
refusing to install below 1 GB (see above); counting swap in D33's BuildKit
cap (BuildKit cannot use swap either).

**Two costs, recorded.** Pages of musdash's heap can now reach disk, including
decrypted env values while a deploy holds them; the swapfile is root-only, and
Docker already keeps each container's environment in plaintext under
`/var/lib/docker`. And on a host with swap, RSS can read lower than the
process really is, because swapped-out pages do not count; RUNNING.md says to
read `VmSwap` next to it. The CI gate measures on a runner without swap and is
unaffected.

### Verified, and not verified

On the 1GB host (RamNode KVM, Ubuntu 24.04.1, kernel 6.8, ext4, cgroup v2).
The swap step was run on its own: `ensure_swap` and `persist_swap` with their
variables, cut from `scripts/install.sh` (from `SWAP_FILE=` to the
`ensure_swap` call) into a file headed by `set -euo pipefail` and a plain
`log` function, then run with bash as root. Results: `MUSDASH_SWAP=0` skips
it; the first run creates and enables 1 GiB in 90 ms with one fstab line; a
re-run says swap is already active; after `swapoff` it re-enables the same
file without a second fstab line; after `swapoff` and deleting the fstab line,
one line is added back; with swap live and its fstab line deleted, a re-run
adds the line back; with `/etc/fstab` made immutable (`chattr +i`), the step
logs that swap will not survive a reboot and exits 0. `shellcheck -S warning`
(0.9.0) is clean on `install.sh`. Not yet verified: swap surviving a reboot, a
full fresh install on the swap host, the skip paths (container, cgroup v1,
filesystem, disk), and 512MB with swap.

## A deploy waits for a new name's certificate (V-6, 2026-09-25)

On the 1GB re-test, `web2`'s first HTTPS request, sent the moment its first
deploy said "Deploy succeeded", failed with a TLS internal error; Caddy had
its certificate about 8 seconds later. The report called it on-demand
issuance, and RUNNING.md said the same. It is not: musdash configures
automatic HTTPS (one automation policy, no `on_demand`), so Caddy starts
obtaining a certificate the moment a route's host matcher carries the name —
at deploy step 8a — and in the background. A first deploy has no old
container to drain, so "Deploy succeeded" followed the route write by
milliseconds, and the resource page reloaded to a link that did not work yet.

### D39 — after the switch, wait up to 30s for hosts new to the route

**What happens.** After the route switch and before the deployment is marked
succeeded, the deploy job waits for a certificate for every host that was not
on the route before this write, sharing one 30s deadline. The deploy log says
`Waiting for a certificate for …`, then per host `Certificate ready for <host>
(Ns)`, or `No certificate for <host> after 30s. Caddy keeps retrying; check
that <host> points at this server and ports 80 and 443 are open.` The
deployment is marked succeeded either way: the container is serving, and a
missing certificate is DNS or ACME, which a failed deploy would not fix.

**Which hosts are "new".** `upsertRoute` already reads the stored route before
it writes it; it now returns that route's hosts, so the job knows which names
are new at no extra admin request (every admin write reloads the proxy, D30).
A redeploy with unchanged hosts probes nothing and behaves exactly as before.
An IP-literal domain is never waited on: it cannot be sent as SNI.
The cost is accepted: a name already on the route that never got a
certificate is not waited on again, and a domain added to a running resource
goes on the route through `sync_routes`, not a deploy, so it is not waited on
either. The Domains tab now says a new name's first certificate takes seconds
to a minute.

**How it is observed.** A TLS handshake from the host to the proxy's published
443 on `127.0.0.1`, with the name as SNI, the chain not verified, and ready
meaning the handshake completed and a SAN covers the name
(`src/caddy/tls-probe.ts`). It sends no request into the app. Not verifying
the chain is deliberate: D4 makes Let's Encrypt staging the default, whose
certificates no client trusts, and the question is only whether Caddy has one
for the name yet. Caddy's admin API has nothing that reports the state of an
ACME certificate, its storage is not reachable through `DockerClient`, and
its events need a module the stock image lacks. The probe does not trigger
issuance — automatic HTTPS already started it — so it costs nothing against
rate limits; a name that never points here costs up to 30 handshake failures
in Caddy's log on its first deploy. The dial address is one constant, for
Phase 5's remote servers.

**The drain counts from the switch.** The old container still stops only after
the health gate and the route switch, and at least 10s after the switch; the
drain now subtracts the time the wait already took, because the requests it
protects were all started before the switch. A redeploy that adds a name pays
at most the 30s wait, not the wait plus 10s.

**It must never throw.** `runDeploy`'s catch treats any error after the route
switch as a failed switch: it would mark a live deploy failed while traffic is
already on the new container. The probe settles exactly once on every path —
refused, silent peer, TLS alert, synchronous throw from `tls.connect` — clears
its timer and destroys its socket, and the step that calls it has its own
catch. That is why `src/caddy/tls-probe.test.ts` widens the test policy by one
file, for the same reason as N-14, D34 and D36: a regression that looks fine
until the day a deploy is marked failed for no visible reason. It runs against
real loopback sockets — a closed port, a listener that never answers, a TLS
server with a static test certificate (SAN match, wildcard, mismatch), and one
that answers a name it has no certificate for with an internal-error alert,
which is what Caddy does.

**Measured.** On Bun 1.4.2, `node:tls` reports SANs as `DNS:a, DNS:b` and the
alert as `ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR`. Loading it at boot left idle
RSS within noise (`gate:rss` 36.6MB before, 35.3MB after, macOS). `bun test`
185 pass; the probe file passed five runs in a row. Not verified yet: the VPS
criteria — a first deploy on a fresh name showing `Certificate ready` before
`Deploy succeeded`, a redeploy showing no wait, and an unpointed name timing
out after 30s with the deploy still succeeding.

Follow-ups: move `checkReachable()` and `probeHttpPort()` onto the same dial
constant; Caddy is published on IPv4 only while the Domains hint mentions
AAAA records.

## The deployment page catches up when its status changes (V-5, 2026-09-25)

Watching a deploy on the 1GB re-test, the page switched to "Succeeded" but
still read "Started: Not started" and "Duration: —" until a reload. Deploy
and rollback redirect to `/d/:id` while the deployment is still queued, and
the page's live component changed only the status label; Started, Duration,
the error notice, the image line and the empty-log text were drawn once.

### D40 — reload when the status differs from the drawn one; replay only unseen lines

**The page reloads**, 600 ms after an event brings a status different from
the one it was drawn with — the pattern the resource page already uses, so
no timestamp, format or wording is copied into `app.js`. It compares against
the drawn status rather than reloading on a final status, because
`/d/:id/events` sends the current status on connect: a finished deployment's
page would otherwise reload forever. It reloads on every change — queued to
running (Started appears), running to succeeded or failed, and each step of a
retry — and schedules at most one reload per page.

**The log no longer doubles.** The page renders the stored lines and then
opened a stream that replayed all of them again, so after any reload every
line showed twice. The stream URL now carries `?skip=<lines rendered>`, and
the replay starts after them. `deployLogTail` returns the whole buffer the
replay walks, and the route renders it in one synchronous pass, so the count
is exact; the replay and the subscription are set up in one synchronous step,
so nothing falls between them. A non-numeric `skip` counts as 0.

**Accepted gaps.** The reader's scroll position in the log is lost at the
reload when a deploy ends, as on the resource page. If the 2000-line buffer
evicts lines between render and connect, that many lines are skipped — only
possible while a very long deploy is still writing. When the browser
reconnects a dropped stream by itself, it reuses the page's `skip`, so lines
already received live since page load show twice (before, the whole log
did). Follow-ups: a retry leaves the previous attempt's `finishedAt` and
error in place while it runs (`src/jobs/deploy.ts`), so the reloaded page
shows "0s" and the old error until it ends; `dropDeployLogs` is never
called.

**Verified** against a compiled binary with no Docker, where a deploy runs
queued, running, failed, running, failed, running, failed: the rendered
`skip` equals the lines drawn at each stage, and `/d/:id/logs` sends exactly
the unseen lines for `skip` of 0, 2, 5, 6, `abc`, `-3`, `1.5`, empty and
huge values. `bun run ci` passes with `app.js` at 14.9 of 16 KB; `bun test`
185 pass. Not yet verified in a browser: the reloads themselves, and a
finished deployment's page loading exactly once.

## One Bun version, everywhere (T-2, 2026-09-25)

CI installed `bun-version: latest`, and `install.sh` installed whatever
`bun.sh/install` served that day, while development ran Bun 1.4.2. So the
binary the RAM gate measured, the binary a user's host compiled, and the one
tested locally could each come from a different Bun — and CLAUDE.md's "pin to
installed versions" had nothing to pin against. A Bun release that raised
idle RSS would have reached users' hosts without the gate ever seeing it.

### D41 — `.bun-version` is the pin; CI and the installer both read it

`.bun-version` at the repository root holds the one version (1.4.2). Both CI
jobs install it with setup-bun's `bun-version-file`. The installer now
installs Bun after it fetches the source, reads the checkout's
`.bun-version`, and installs that exact release (`bun.sh/install` with
`bun-v<version>`) when `$BUN_INSTALL/bin/bun` (`/usr/local/bin/bun` by
default, where the installer always put it) is missing or reports a different
version; a re-run with the pin unchanged is a no-op. A Bun elsewhere on `PATH`
is no longer used for the build. The file must hold a bare version such as
`1.4.2`, not a range or `latest`. Moving to a new Bun is
therefore one commit that changes `.bun-version`: CI tests and measures it,
and every host picks it up on its next upgrade. Without the file (an old
checkout via `MUSDASH_SRC`), an existing Bun at that path is kept and a
missing one is installed at latest. Follow-up: the `@types/bun` and
`bun-types` dev dependencies still float separately from the runtime pin.

Verified on the 1GB host with the installer's Bun step run on its own against
a scratch `BUN_INSTALL`: a fresh install gets 1.4.2, a re-run installs
nothing, moving the pin to 1.4.1 installs 1.4.1, and removing the file keeps
the installed Bun. `shellcheck -S warning` is clean. The CI side runs on the
next push.

The same pass fixed T-1: `.prettierignore`'s bare `build` also matched
`src/build/`, so Prettier had never checked those files, and five had
drifted. The output-directory patterns are now anchored to the root
(`/build`, `/dist`, `/out`, `/coverage`, `/.next`), and the five files are
formatted.

## The RAM gate runs isolated (R-3, 2026-09-26)

`scripts/measure-rss.ts` spawned the binary with the caller's environment:
port 8000, `./data` and the real Docker socket. On a host running musdash that
is a second instance with an empty database, and its reconciler removes every
`musdash.*` container as an orphan — which happened on the 1 GB host when the
binary was started by hand, and the live reconciler redeployed both apps
within ~25 s. A separate data directory alone would not help: the socket is
what does the damage.

### D42 — the gate drops `MUSDASH_*`, and Docker is opt-in and guarded

The child gets the caller's environment minus every `MUSDASH_*` variable,
plus `NODE_ENV=production`, a free port, a fresh temporary data directory
(removed afterwards, also on Ctrl-C or a cancelled job, with SIGKILL if SIGTERM
is ignored for 5 s) and a Docker socket path that does not exist. That run is
safe beside a live service, and leaves the sidecar bootstrap and the
reconciler's Docker calls out of the idle figure: 52.9 MB on the 1 GB host
next to a live musdash at 63 MB.

CI must keep measuring the conservative number, so it passes
`--with-docker`: the real default socket, with the worker pulling and starting
Caddy and BuildKit during the idle, as before. The flag first lists
containers labelled `musdash.managed` with the docker CLI and refuses when any
exist or the list fails, so it cannot be the host it would damage. The
closing line now quotes the measured sidecar figures (Caddy ~50–70 MB,
BuildKit idle ~66 MB) that CLAUDE.md does.

Verified on the 1 GB host beside the live service: a 5 s and a 60 s run
passed, the same seven containers ran before and after, no `./data` or
temporary directory was left, and `--with-docker` refused. The CI side runs on
the next push.

## Every boot re-ensures the sidecars (R-1, 2026-09-26)

The boot-time `ensure_caddy` and `ensure_buildkit` jobs shared the reconciler's
time-bucketed ids (5 minutes for Caddy, 1 for BuildKit, D7 and D8), and
finished job rows are kept for seven days. A restart in the same bucket as the
previous boot therefore collided with that process's finished row, the
conflict was swallowed as "already queued", and the bootstrap never ran:
setting `MUSDASH_BUILDKIT_MEMORY_MB` and restarting within the minute changed
nothing and logged nothing (V-1 10–11), and an upgrade within five minutes of
the previous boot skipped the proxy spec replacement (D29), the issuer
correction (D28) and the route sync. A lease stranded by a crash mid-bootstrap
had the same effect.

### D43 — the bucket is per process

Both ids now carry a nonce computed once at module load, the process start time
in base 36: `ensure-caddy-<nonce>-<bucket>`, `ensure-buildkit-<nonce>-<bucket>`.
Inside one process nothing changes: the startup reconcile, the boot enqueue and
the ticks still collapse onto one row per bucket, and the blind window is
still the bucket. A new process can never match a row an earlier one left, so
every boot runs both bootstraps. A bootstrap the previous process left pending
may also run; the handlers are idempotent. The nonce must stay module-level:
computed per call it would give every tick a fresh id and queue a bootstrap
every 30 seconds.

Rejected: a fresh ULID for the boot enqueue only (D25's pattern) would break
the collapse with the startup reconcile and the first tick, putting two or
three bootstraps ahead of the startup deploys; re-arming the finished row in
the queue would overwrite its `last_error`, still collapse onto a stranded
lease, and change a function every job type uses.

Verified on the 1 GB host: two restarts 15 s apart in the same minute, the
second with `MUSDASH_BUILDKIT_MEMORY_MB=320`, both logged `ensure_caddy` and
`ensure_buildkit` completing (same bucket, different nonce), and the second
replaced the daemon at 320 MB; removing the override and restarting restored 384. With the daemon removed by hand, the next tick queued exactly one
bootstrap and it came back. No test: the id helpers are private, and the
behaviour needs a restart.

## A failed deploy is not retried (R-2, 2026-09-26)

A Dockerfile RUN step that exceeded BuildKit's memory cap failed three times on
the 1 GB host, each attempt rebuilding to the cap on the single worker: deploy
jobs took the queue's default of three attempts with 10 s and 60 s backoff
(line 93 here, PHASES §8), and nothing on that path can tell a deterministic
failure from a transient one — a builder exit is one `BuildError` whatever the
cause. Reading the queue also showed a second hazard: a retry whose backoff has
expired is claimed by `created_at`, so it can run after a newer deploy of the
same resource succeeded and put the older image back, repointing the resource
and its rollback target.

### D44 — deploy jobs get one attempt

`enqueueDeploy` (manual, rollback, reconcile) and `enqueueDeployCoalesced`
(push) pass `maxAttempts: 1`, as the sidecar bootstraps already do (D7). Stop,
remove, route sync and prune keep the queue's backoff. Recovery from a failed
deploy is the Deploy button or the next push; a failed redeploy leaves the old
container serving. The cost is a push that lands during a transient outage (a
registry or GitHub blip, Caddy restarting mid-switch): it is not deployed until
the next push or a click. An allow-list of retryable errors can be added for
pushes later if that matters. This makes the D40 follow-up about a retry
showing the previous attempt's error and duration moot.

Follow-up, not changed here: the reconciler re-enqueues a redeploy every 30 s
for a resource that should be running and has no container, with no check for
one already queued, so an image that fails every time queues a deploy per tick.

Verified on the 1 GB host: the runaway build failed once (`attempts 1` of 1,
`retrying: false`), the deployment stayed failed, and the app's previous
container kept serving.

## The Variables boxes show what is saved (R-5, 2026-09-26)

Saved values were never shown again, so the three boxes on a resource's
Variables tab, the project's and each environment card's were always empty
even when variables existed — and saving replaces all three boxes of that
level, so adding one variable deleted every other. The confirmation dialog said
so; the empty boxes invited exactly that mistake.

### D45 — each level's own boxes are prefilled with its saved text

On the env tab only, the page decrypts that level's own rows (`getEnvText`,
`getSharedEnvText`), groups them by scope in the order they were saved, and
fills each box with `KEY=value` text from `formatEnvText`. Saving is then a true
edit of what is shown, and the replace semantics stand as the deliberate
reading of PHASES.md's "Upsert": the form edits the whole set. This reverses
the UI plan's "values never reach the page" for the edit boxes only; the
Resolved environment table and the key chips stay names-only, and no other
tab decrypts anything.

The rule in CLAUDE.md is that decrypted values are never logged; showing them
to the one signed-in user is a different exposure, the one every PaaS makes
on its variables page. What changes is that script running in an
authenticated page could now read them, where before it could only overwrite
them; Eta's autoescape and the no-attacker-text-in-JS rule are the defence.
Encryption at rest, which protects the database file and its backups, is
unchanged. To keep the values out of caches and stale pages, the two env-tab
responses send `Cache-Control: no-store`, the three forms carry
`autocomplete="off"`, and a page restored from the back/forward cache with an
env form reloads, so Back after a save cannot show and re-post the old
values.

`formatEnvText` now escapes only what the parser reverses (`\\`, `\"`, `\n`,
`\r`, `\t`) and writes everything else raw inside double quotes; the
`JSON.stringify` it used wrote `\u001b`-style escapes that the parser keeps
literally, so a prefilled save would have changed such a value. Comments in
the boxes are not kept (the parser drops them), and a NUL in a value, which
only a hand-built request can store, becomes U+FFFD in a browser.

Verified with an isolated local instance over HTTP: the boxes are prefilled on
all three forms, an unchanged save keeps every variable, adding one keeps the
rest, `</textarea><b>x`, `${A}` and `$$` survive, `no-store` appears only on the
env tab, and no value reaches the log.
