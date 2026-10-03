# Phase 3 plan — Compose stacks and one-click templates

Written 2026-09-29, against `main` at `09d6005`. This is the working plan for
reaching the Phase 3 Definition of Done in [PHASES.md §27](PHASES.md). It does
not replace the per-slice spec: each slice below still goes through the loop in
[CLAUDE.md](../CLAUDE.md) (research → spec → **approval** → build → verify →
validate → **approval**). What this file fixes in advance is the order of the
slices, the design each one builds on, the decisions to record, and how each
Definition of Done item gets proven.

When a slice lands, record its decisions in [DECISIONS.md](DECISIONS.md) under
the next free number (D65 onward) and tick it in [§9](#9-progress). Delete this
file when Phase 3 is done; git keeps it.

---

## 1. The Definition of Done, and where each item is proven

| #   | PHASES.md item                                                  | Slice  | Proven by                                                     |
| --- | --------------------------------------------------------------- | ------ | ------------------------------------------------------------- |
| 1   | Paste a Compose file with three services; all start             | S2     | VPS: web + api + db stack, `docker ps` shows all three        |
| 2   | Designate one service public; it is reachable over HTTPS        | S2, S3 | VPS: `curl -I https://<auto domain>` → 200 from that service  |
| 3   | Services resolve each other by name                             | S2     | VPS: `web` fetches `http://api:…`, `api` connects to `db`     |
| 4   | Redeploy preserves volume data                                  | S2, S4 | VPS: write a row to db, redeploy, row still there             |
| 5   | Deleting the stack prompts about volumes and honours the choice | S4     | VPS: delete once keeping, once destroying; `docker volume ls` |
| 6   | `privileged: true` is rejected with a clear message             | S1, S2 | `bun test` on the validator + the form shows the refusal      |
| 7   | Plausible, n8n and Ghost from templates, each end to end        | S6, S7 | VPS: each reachable over HTTPS, signs up, survives redeploy   |
| 8   | Placeholders generate distinct secrets per deployment           | S6     | `bun test` + two installs of one template differ              |
| 9   | A template exceeding available RAM warns before deploy          | S6     | 2 GB VPS: Plausible shows the warning with the numbers        |
| 10  | Idle RSS still under 100 MB                                     | S8     | `bun run gate:rss` on the final commit                        |

About item 10: PHASES.md §30 lets Phase 3 reach 120 MB, but CLAUDE.md sets the
gate at **100 MB**, and the ceiling only moves by an explicit decision. This plan
keeps 100 MB. Nothing below adds a long-lived component or a dependency.

About item 8: "per deployment" means **per installed stack**, not per deploy
run. If the database password changed on every redeploy, the app would lose its
database. Values are generated once, when the resource is created, and stored
like any other variable (§3.5).

---

## 2. Where we start

### What already helps

- **Bun 1.4.2 parses YAML itself.** `Bun.YAML.parse` (checked: it resolves
  anchors and `<<` merge keys). No `yaml` package is needed, so there is no new
  dependency to measure.
- **The VPS has Docker 29.8.1 (API 1.56) and Docker Compose v5.5.1**, installed
  by `get.docker.com`, on cgroup v2, with 1968 MiB of RAM and **5.1 GB free disk
  (73% used)**.
- **The deploy pipeline** (`src/jobs/deploy.ts`) already has the pieces a stack
  needs: the health gate (`healthGate` :802, `assertNotRestarted` :886), the
  route switch with dial-by-name (D48, :410-479), the certificate wait (D39),
  env resolution with one-pass interpolation (D13, `resolveEnvVars` in
  `queries.ts:935`), redaction (`safe()`, :155), and the subprocess streaming
  pattern in `runBuilder` (`src/build/run.ts:96`).
- **The job queue** takes new job types without a migration (`jobs.type` is TEXT
  with no CHECK).
- **`createVolume` / `removeVolume`** exist on `DockerClient` (`impl.ts:765`).
  Only the sidecars use them.

### What is in the way

Each of these would break the first time a stack runs. Fix them in the slice
that introduces the stack, not later.

1. **`reclaimStrays` (`deploy.ts:715`) removes every managed container of a
   resource except `resource.containerId`.** On a stack, it would delete every
   service but one.
2. **The reconciler maps one container per resource** (`reconciler.ts:55-62`).
   It would move `containerId` between services and restart log streams every
   30 s. It would also redeploy a whole stack when a single one-shot service
   exits.
3. **Log streams are keyed by resource and follow one container**
   (`logs/stream.ts:20`).
4. **`deploy.ts:537` writes `{image}` into `source_json` for every non-git
   kind.** A compose resource that reached it would lose its file.
5. **`runRemove` never removes volumes**, although `resource.eta:484/493` and
   the route comment `app.ts:839` say it does. Image and git resources have no
   volumes today, so nothing is lost yet. The copy is still wrong.
6. **The `domains` table has no service or port.** Caddy has one route per
   resource with one upstream (`routeIdFor`, `caddy/client.ts:475`).
   `syncResourceRoutes` deletes every `musdash-*` route it does not expect
   (`jobs/routes.ts:132`), so new route ids must be known to it.
7. **Asset headroom is nearly gone.** `app.css` is 31,447 of 32,768 B and
   `app.js` is 15,711 of 16,384 B. The template grid and the service-routing UI
   will not fit.
8. **Deploy logs are never freed.** `publishDeployLog` (`events.ts:61`) keeps
   up to 2,000 lines for every deployment for the life of the process.
   `dropDeployLogs` exists but nothing calls it. Pull progress from Compose
   makes those logs much longer, so fix this before Compose lands (S0).
9. **`/r/:id/domains/:domainId/delete` does not check that the domain belongs to
   `:resourceId`** (`app.ts:694`). This is harmless with a single user, but
   service-scoped domains touch this handler, so fix it in S3.

---

## 3. Design

These are the choices each slice builds on. Each one is recorded as a decision
when its slice lands, and the Validator checks slices against them.

### 3.1 Resource model

- `resources.kind` gains `"compose"` (`ResourceKind` in `schema.ts:117`). The
  column is TEXT, so the only change is to the type.
- `source_json` for compose:

  ```ts
  type ComposeSource = {
    composeFile: string // the user's YAML exactly as pasted or templated; ≤ 64 KiB
    origin: "paste" | "template"
    templateId?: string // e.g. "plausible"
    templateVersion?: string // meta.json version at install time
    services: string[] // service names from the last successful normalisation
    publicService: string | null // gets the auto domain
  }
  ```

- `resources.container_port` stays NULL for compose. The port lives on each
  domain (§3.6).
- `resources.memory_limit_mb` holds the **sum of the stack's service limits**,
  written after normalisation. The RAM warning and the settings page read one
  number for every kind.
- `deployments.image` is NOT NULL. For compose it holds
  `compose@sha256:<first 12 hex of the file>`, so the deployments table stays
  readable.
- A new column, `deployments.compose_file TEXT` (NULL for other kinds), keeps
  the exact file each deploy used. Rollback and "Deploy this again" (D61)
  redeploy that text. It never holds secrets, because interpolation happens
  later, in a temporary file.
- **No `compose_services` table and no `volumes` table.** This departs from
  PHASES.md. Docker already knows both through its labels
  (`com.docker.compose.project`, `com.docker.compose.service`, and our
  `musdash.*` labels). A second copy in SQLite would drift, and the reconciler
  would then need to reconcile the copy too. Service state is read from
  `listManagedContainers()` and volumes from a label-filtered volume list.
- `domains` gains `service_name TEXT` and `container_port INTEGER`. Both are
  NULL for image and git resources, and both are required for compose.

Migration `0007_compose.sql`: `ALTER TABLE deployments ADD COLUMN compose_file
TEXT;` `ALTER TABLE domains ADD COLUMN service_name TEXT;` `ALTER TABLE domains
ADD COLUMN container_port INTEGER;` Register it the usual way: a static text
import plus an entry in `MIGRATIONS`.

### 3.2 The pipeline: let Compose normalise, then validate what it produced

The key choice: **validate Compose's own normalised output, not the raw YAML.**
`docker compose config --format json` does the whole spec. It resolves anchors,
`extends`, short syntax (`./data:/x:ro` becomes `{type: bind, source: /abs,
target, read_only}`), environment lists, interpolation and profiles. It does
this without contacting the daemon. Checking bind mounts in raw YAML means
parsing every short-syntax variant, and one missed spelling is a host mount. On
the normalised model each check is a field comparison. It is also the most
direct form of "shell out, never reimplement".

That creates one gap. `config` **reads host files** named by `include:`,
`extends.file`, `env_file`, and `configs`/`secrets` entries with `file:`, and it
runs as root. So a cheap pre-scan of the raw YAML must refuse those before
`config` runs.

```
A  prescan   (pure; Bun.YAML.parse)    refuse include / extends.file / env_file /
                                       file-backed configs+secrets / build / top-level
                                       name / services without image; size ≤ 64 KiB;
                                       collect ${NAME} references
B  env       (pure)                    resolved vars ∪ placeholders; a reference with no
                                       value and no default fails, naming the key (D13)
C  normalise (subprocess)              docker compose -p <project> -f <tmp>/in.yaml
                                       --project-directory <tmp>   (user vars as process env)
                                       config --format json
D  validate  (pure, authoritative)     §3.3 rules on the normalised model
E  transform (pure)                    labels, networks, memory, restart, logging,
                                       volume labels (§3.4, §3.7)
F  apply     (subprocess)              write <tmp>/stack.json (0600) → compose pull →
                                       compose up -d --remove-orphans → gate → routes
   finally                             delete <tmp> (it holds interpolated secrets)
```

- **The project name** is `musdash-<resourceId lowercased>`. Compose accepts
  `[a-z0-9_-]`. Container names become `musdash-<rid>-<service>-1`, which are
  deterministic because `container_name` and replicas above 1 are refused.
- **The rendered file is JSON.** Every JSON file is valid YAML, so nothing has
  to serialise YAML.
- **The rendered file is temporary.** It lives in `data/compose/tmp/<deploymentId>/`
  (dir 0700, files 0600) and is deleted in `finally`. Any left over are swept at
  boot and by the daily scheduler, as build dirs are (D19). Nothing on disk
  holds interpolated secrets between deploys. `stop` and `down` do not need the
  file: `docker compose -p <project> stop|down` works from labels alone. The
  spike (S0) must confirm this for v5.5.1.
- **The subprocess environment is fixed** (D65 items 9 and 14): `PATH`,
  `HOME` (an empty dir under data), and `DOCKER_HOST` from the DockerClient's
  endpoint. It never inherits `process.env`. User variables are added only to
  the `config` call's environment, minus `PATH`, `HOME` and keys starting
  `COMPOSE_`, `DOCKER_` or `BUILDKIT_`. `config` writes values back with `$`
  escaped, so `up` runs on its output with no user environment at all, and no
  env file is ever written.
- **The CLI sits behind the Docker seam.** A new `ComposeCli` in
  `src/docker/compose.ts` is the only code that spawns `docker compose`.
  `DockerClient` gains `composeHost(): string`, which returns `unix://<socket>`
  today. Phase 5's SSH implementation returns its own host, and nothing above
  the seam changes. This keeps the invariant that only `src/docker/**` talks to
  Docker.

  ```ts
  interface ComposeCli {
    config(p: ComposeInvocation): Promise<unknown> // stdout JSON, 30 s, 4 MiB cap
    pull(p: ComposeInvocation, onLog: (l: string) => void): Promise<void>
    up(p: ComposeInvocation, onLog: (l: string) => void): Promise<void>
    stop(project: string, onLog: (l: string) => void): Promise<void>
    down(project: string, onLog: (l: string) => void): Promise<void> // never --volumes
  }
  type ComposeInvocation = {
    project: string
    dir: string
    file: string
    env?: Record<string, string> // config only
  }
  ```

  Streaming reuses `runBuilder`'s pump. Lift the pump into
  `src/proc/stream.ts` so it is not typed to `BuildContext`. It keeps partial-line
  holdback (so redaction cannot be split), the hard timeout, SIGTERM then
  SIGKILL, and the drain. Use `--progress plain` or `--ansi never`, whichever S0
  shows gives line-shaped output.

- **Form time and job time.** The create and settings handlers run only A and
  the raw-YAML half of D, which are pure and take milliseconds, so a pasted
  `privileged: true` is refused on the form (DoD 6). The job runs all of A–F,
  and its D is the authority. No handler spawns Compose.

### 3.3 Validation rules

Each refusal is one line naming the service and the field. The messages live
in an Eta partial keyed by rule code, as `errors.eta` does, and the deploy log
prints the same sentence. **Refuse, never strip** (DECISIONS: Compose).

| Refused                                                                               | Why                                                                            |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `privileged: true`                                                                    | root on the host                                                               |
| `network_mode: host`, `container:*`; `pid`/`ipc`/`uts`/`userns_mode`/`cgroup: host`   | escapes the container's namespaces                                             |
| any `volumes` entry of `type: bind`, `npipe`, `cluster`                               | host paths. Phase 3 is named volumes only (§3.7)                               |
| a volume named `docker.sock` or targeting `/var/run/docker.sock`                      | root-equivalent, and named explicitly in PHASES.md                             |
| top-level `volumes.*.external: true`, or `volumes.*.name` set                         | could attach another stack's or a sidecar's volume (e.g. `musdash-caddy-data`) |
| top-level `networks.*.external: true`, or `networks.*.name` set                       | same, for networks. musdash adds its own network itself                        |
| `cap_add` (any), `devices`, `device_cgroup_rules`, `gpus`, `runtime`, `cgroup_parent` | host capabilities and devices                                                  |
| `security_opt` containing `unconfined` or `disable`                                   | turns off seccomp or AppArmor                                                  |
| `oom_kill_disable: true`, `oom_score_adj` < 0                                         | a leaking stack must not take down the box                                     |
| `mem_limit` ≤ 0, or `memswap_limit` other than equal to `mem_limit`                   | no "unlimited" (invariant). Swap stays off (D38)                               |
| any `ports` entry (`"81"` alone publishes a random host port, D65)                    | bypasses Caddy and ufw (Docker writes iptables itself). `expose` is fine       |
| `container_name`                                                                      | global names collide, including with `musdash-caddy`                           |
| `deploy.replicas` > 1, `scale` > 1                                                    | routing and naming assume one container per service                            |
| `build`                                                                               | `docker compose build` bypasses BuildKit's memory cap (D33, D50)               |
| `volumes_from` pointing at a container (not a service)                                | reaches into containers outside the stack                                      |
| labels beginning `musdash.` or `com.docker.compose.`                                  | ownership labels are musdash's                                                 |
| an image that fails `isValidImageRef`                                                 | same rule as image resources                                                   |

A few things are **allowed**: `depends_on`, `healthcheck`, `command`,
`entrypoint`, `environment`, `expose`, `tmpfs`, `ulimits`, `sysctls`,
`extra_hosts`, `init`, `user`, `working_dir`, `configs`/`secrets` with
`content:` or `environment:`, `profiles` (inactive profiles simply don't start),
and `x-*` extensions.

### 3.4 Networking

A service's name is an alias on **every** network it joins. If every service
joined the shared `musdash` network, two stacks that each have a `db` would both
answer to `db`, and one stack's `web` could reach the other's database. And
every address on `musdash` is a trusted peer of the dashboard (N-9). So:

- Every service stays on the stack's own default network
  (`musdash-<rid>_default`). That is how services resolve each other by name
  (DoD 3).
- **Only services that have a domain also join `musdash`**, so Caddy can dial
  `musdash-<rid>-<service>-1:<port>`. The transform adds
  `networks: {default: {}, musdash: {}}` to those services, and declares
  `musdash: {external: true, name: <config.network>}` at the top level. That is
  the one external network allowed, and only musdash adds it.
- **This departs from PHASES.md DoD 1** ("all start on the musdash network").
  DoD 1 is read as "all start", and DoD 3 is met on the stack network. Phase 4's
  "connect an app to a database by container name" will need a per-service
  "reachable from other resources" switch. That switch is out of scope here and
  listed in §8.
- **Risk: address pools.** Each stack creates a network. Docker's default
  address pools run out after roughly 30 networks ("could not find an
  available, non-overlapping IPv4 address pool"). S0 measures the real number
  on the VPS. The deploy log maps the error to a sentence. Changing
  `daemon.json` is out of scope because it restarts Docker under every app.

### 3.5 Environment variables and placeholders

- **Resolved variables are the interpolation environment of the file.** They
  are not injected into every service. A service gets what the file gives it,
  for example `DATABASE_URL: ${DATABASE_URL}`. This departs from PHASES.md step
  6 ("merge resolved environment variables"). With blanket injection, every
  secret would land in every container, including the public one. The
  Variables tab on a compose resource says "available to the Compose file as
  `${NAME}`".
- Scope: both `runtime` and `both` count. `build` has no meaning for a stack,
  and the tab hides the scope selector.
- **Missing references fail the deploy** (D13): a reference with no value and no
  `:-`/`-` default. This is checked by the prescan (B), so it does not depend on
  how Compose words its warning. The message names the key, never a value.
- **Placeholders** use the DECISIONS convention, plus the port suffix Coolify's
  templates rely on:

  | Placeholder                       | Value                                                |
  | --------------------------------- | ---------------------------------------------------- |
  | `SERVICE_PASSWORD_<NAME>`         | 32 chars `[A-Za-z0-9]` from `crypto.getRandomValues` |
  | `SERVICE_USER_<NAME>`             | 16 chars `[a-z]`                                     |
  | `SERVICE_BASE64_<NAME>`           | 32 random bytes, base64                              |
  | `SERVICE_FQDN_<SERVICE>[_<PORT>]` | the host routed to that service (and port)           |
  | `SERVICE_URL_<SERVICE>[_<PORT>]`  | `https://` + that host                               |

  They are generated **when the resource is created**, and only for
  placeholders the file references that the user has not already set. They are
  stored as encrypted resource variables (scope `runtime`), so they show in the
  Variables tab, survive redeploys, are redacted in logs (they are in
  `secrets`), and can be edited. When a saved file introduces a placeholder
  that is not set yet, it is generated on save.

- `SERVICE_FQDN_*` also **creates the domain row** for that service and port.
  With `MUSDASH_WILDCARD_DOMAIN` set, the host is
  `<service>-<resource>-<env>.<wildcard>`. Without it, the template dialog
  requires a host for each FQDN placeholder before it will deploy.

### 3.6 Routing (DoD 2)

- Each domain row maps a host to a `(service_name, container_port)`. The auto
  domain goes to `publicService`, with the port the user picks in the create
  dialog.
- **One Caddy route per routed service**, id `musdash-<resourceId>--<service>`.
  The double dash cannot occur in a service name Compose accepts next to a
  ULID. Image and git resources keep `musdash-<resourceId>`. `routeHosts`,
  `wantedHosts` and `syncResourceRoutes` learn the compose shape. The sync keeps
  deleting any `musdash-*` id it does not expect, so a service that loses its
  last domain loses its route.
- Upstream: `musdash-<rid>-<service>-1:<port>`, by name (D48). Insertion stays
  at index 0 (C-1), and the dashboard tail is untouched.
- A domain whose service is not in the stack is refused on the form. If a saved
  file drops a routed service, the deploy fails with a message naming the
  domains that point at it. The routes are never silently removed.

### 3.7 Volumes (DoD 4, 5)

- **Named volumes only in Phase 3.** Compose already scopes them as
  `musdash-<rid>_<name>`. The transform also puts `musdash.resource_id`,
  `musdash.project_id` and `musdash.volume=<name>` labels on each declared
  volume, so they can be found after the resource row is gone.
- **Redeploy never removes volumes**: `up -d` with no `-V`, and `down` never
  gets `--volumes`. This is covered in S2's criteria and tested on the VPS
  (DoD 4).
- **Sizes** come from `GET /system/df?type=volume` (API ≥ 1.42). A new
  read-only `DockerClient.volumeUsage()` returns `{name, sizeBytes|null,
refCount, labels}`. `df` measures every volume on the host and took 9.8 s in
  the spike (D65), so **no page render awaits it**: the page loads, then fetches
  `/r/:id/volumes/sizes` (and `/settings/volumes/sizes`). That handler shares one
  in-flight `df` (30 s timeout) and caches the result for 10 minutes. On a
  timeout the sizes read "unknown".
- **Delete asks.** The compose resource's delete card lists the volumes with
  their sizes. It has one unchecked checkbox, "Also delete these N volumes (X
  GB). This cannot be undone.", and uses the existing confirm dialog. The
  choice travels in the job payload as `{deleteVolumes: boolean}`. Delete order
  follows trap 8:
  1. delete routes
  2. `compose down --remove-orphans` (containers and the stack network)
  3. remove volumes, only if chosen
  4. drop logs
  5. delete the row

  A crash before step 5 re-runs the same job. The row still exists, so the
  choice is still in the payload.

- **Kept volumes stay findable.** `/settings` gains a "Volumes left by deleted
  resources" list. It shows volumes whose `musdash.resource_id` has no row, with
  sizes and a per-volume delete (enqueued as `remove_volume`). Without this,
  kept data turns into silent disk use, which CLAUDE.md names as the top
  support problem.
- Fix the image/git delete copy (`resource.eta:484/493`). Those resources have
  no volumes.

### 3.8 Health, downtime and rollback

- **Order of a deploy:**
  1. `pull`, so a missing image fails before anything stops
  2. `up -d --remove-orphans`, in which Compose recreates changed services
  3. gate
  4. route switch
  5. certificate wait
- **The gate:**
  - _Routed services_ use the existing `healthGate`: HTTP to `<ip>:<port><healthPath>`, then `HEALTHCHECK`, then uptime, plus `assertNotRestarted`.
  - _Every other service_ must be running and not restarting, or exited 0 when it is a one-shot (`restart: "no"`).
  - All of this runs under one deadline (`config.healthTimeoutSec`). `--wait` is not used: it fails on a one-shot service that exits 0 (D65).
- **Downtime is documented, not hidden.** Compose stops a changed service before
  starting its replacement, so a stack has **brief downtime on redeploy**. The
  deploy page and RUNNING.md say so. There is no drain step, because there is no
  old container to drain.
- **A failed gate leaves the stack as Compose left it**, and the deployment is
  marked failed with the reason. There is no automatic rollback, because a
  database may already have migrated forward. The Roll back button (below)
  is the recovery path.
- **Roll back** redeploys the previous successful deployment's `compose_file`.
  **Deploy this again** (D61) redeploys that row's `compose_file`. Both use
  today's variables, the same as image apps.
- **Labels:** no `musdash.deployment_id` on stack services. Compose recreates a
  container whenever its labels change, so a per-deploy label would restart the
  database on every deploy. Services carry `musdash.managed`,
  `musdash.resource_id`, `musdash.project_id` and `musdash.service=<name>`.

### 3.9 Reconciler, strays and logs

- **A `musdash.service` label means the container belongs to Compose.**
  `reclaimStrays`, the reconciler's per-resource map, and `runRemove`'s
  per-container loop all skip such containers. Stacks get their own pass:
  - **Desired `running`:** for each service in `source.services` without a
    healthy container (missing, or exited ≠ 0, or exited 0 while not a
    one-shot), enqueue a `reconcile` deploy under the same D47 backoff.
    `restart: unless-stopped` heals most cases before the reconciler notices.
  - **Desired `stopped`:** enqueue `stop` if anything is running.
  - **Orphans:** a stack container whose `musdash.resource_id` has no row is
    removed, as today. So are stack networks labelled
    `com.docker.compose.project=musdash-*` with no row. Volumes are
    **never** swept automatically (§3.7).
- **Logs:** there is one ring buffer (1000 lines) and one rotated file per
  resource, as now. Stack lines are prefixed with `[service]`. One follow
  stream runs per service container, keyed `resourceId:service`. The Logs tab
  gets a service filter on the client, which only hides lines. This keeps the
  logs-RAM bound per resource, not per service.
- `resources.container_id` stays NULL for compose. Status comes from the
  service containers, and the resource is Healthy when every service passes the
  gate's rule.

### 3.10 Templates (DoD 7, 8, 9)

- **Where they live: embedded in the binary for Phase 3** (recommended; see
  open question Q1). Each template is a directory
  `templates/<id>/{docker-compose.yaml, meta.json, logo.svg}` with a generated
  `templates/index.ts` of static text imports (trap 6: dynamic imports vanish
  in the binary).
  - Why: it works on a firewalled server, each template is tested against the
    release it ships in, there is no network fetch to secure, and it is about
    250 KB, which S6 measures against the RSS gate.
  - Cost: the catalogue only updates when musdash updates. A remote
    `index.json` can be added later, still through this format. That
    departs from DECISIONS ("fetched and cached from an index.json"), so record
    it.
- `meta.json`:
  - `{id, name, description, tags[], docs, website, minimum_ram_mb, version, public: {service, port}, credit}`.
  - Validated with zod at load. `bun test` checks every shipped template: it
    passes the prescan and the raw-YAML rules, and its FQDN placeholders
    reference real services.
- **The grid.** `/templates?env=<environmentId>` is a server-rendered grid, with
  logos served as `<img src="/assets/templates/<id>.svg">`. The route sends
  `image/svg+xml` and `Content-Security-Policy: sandbox`, and serving through
  `<img>` means SVG scripts never run. Search filters cards on the client, in a
  page-scoped script (§3.12).
- **Deploy flow:**
  1. The user clicks a template. A dialog opens with the name (defaulting to the id), the environment, a domain field per FQDN placeholder, and the RAM warning.
  2. POST creates the compose resource with `origin: "template"` and generates the placeholders (§3.5).
  3. It enqueues a deploy and redirects to the deployment page.
- **The RAM warning (DoD 9).** It is shown in the dialog and never blocks
  deploy. Available memory is:

  ```
  host MemTotal (docker.info, cached 10 min)
  − musdash's own budget (100 MiB)
  − Caddy cap (D46) − BuildKit cap (D33)
  − Σ memory_limit_mb of resources whose desired_state is running
  ```

  When `minimum_ram_mb` exceeds it, the dialog shows all the numbers. Example:
  "Plausible needs about 2048 MiB. This server has 1968 MiB, of which about
  610 MiB is not yet promised to other apps." Every number shown is one the user
  can check.

- **Licensing.** Before any file is adapted from Coolify's templates, S7
  verifies the repository's current license (DECISIONS says MIT; check it, it
  may be Apache-2.0). It adds `templates/NOTICE` with the attribution the
  license requires, and records it in a decision.
- **Porting rules** from Coolify's format:
  - bare `- SERVICE_FQDN_X_3000` declarations become domain metadata
  - `volumes: content:` file injection is replaced by `configs: content:`
  - binds are replaced by named volumes
  - `exclude_from_hc` is dropped for the one-shot rule
  - every service gets an explicit `mem_limit`, so the RAM sum is honest

### 3.11 UI

- **Project page:**
  - Each environment gets a third button, "Compose / template". It opens a
    small menu with "Paste a Compose file" (dialog) and "Browse templates"
    (link to `/templates?env=`).
  - The paste dialog has the name, a textarea (monospace, 64 KiB max), the
    public service with its port, and an optional health path.
  - Refusals come back with the D37 notice pattern, and the textarea keeps its
    content, sent back through the redirect as a short-lived server-side draft
    keyed by session. It is never put in the URL.
- **Resource page for a compose resource:**
  - **Overview:** a services table (name, image, state, memory limit, routed
    host) and the deployments table.
  - **Logs:** with the service filter.
  - **Variables:** with interpolation wording and no scope selector.
  - **Domains:** each row names its service and port. The add form has a
    service `<select>` and a port.
  - **Settings:** the Compose file textarea, the public service, and the health
    path. The memory field is hidden, since per-service limits live in the file.
  - **Volumes** (new section on Overview): the list with sizes.
  - **Delete:** with the volumes checkbox.
- **Deployment page:** a "Stacks may have brief downtime on redeploy" note on
  compose deploys, and a link to the file as deployed (a read-only `<pre>`).

### 3.12 Staying inside the budgets

- **RSS:**
  - no dependencies
  - `Bun.YAML` is built in
  - Compose runs as a subprocess, so its memory is transient
  - templates are about 250 KB of embedded text
  - the new caches have size limits: the volume sizes cache covers 64 resources, and `docker.info` is one entry
  - `gate:rss` runs at the end of S2, S6 and S8
- **Assets.** Don't raise the global caps quietly. Add **page-scoped assets**:
  `stack.css`/`stack.js` for the compose and template pages, embedded and
  versioned like the others (D51), each with its own line in
  `scripts/check-asset-size.ts` (8 KB CSS / 8 KB JS). Pages that don't use them
  don't load them. Record this as a decision in S3.
- **Disk:** pull progress goes to the deploy log, which S0 bounds. Compose logs
  go through the same capped json-file driver: the transform sets
  `logging: {driver: json-file, options: {max-size: 10m, max-file: "2"}}` on
  every service and refuses any other driver. Volume sizes are visible (§3.7).

---

## 4. Departures from PHASES.md, to record as decisions

| PHASES.md says                                  | This plan                                                                 | Why                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------- |
| Validate the parsed YAML                        | Validate `docker compose config` output; prescan only for host-file reads | one normalised shape instead of every short syntax    |
| Write `data/compose/<id>/docker-compose.yaml`   | Temporary `data/compose/tmp/<deploymentId>/stack.json`, deleted after use | interpolated secrets are not kept on disk             |
| Inject the `musdash` network into every service | Stack network for all; `musdash` only for routed services                 | alias collisions across stacks; dashboard trust (N-9) |
| Merge resolved env into services                | Resolved env is the interpolation environment only                        | secrets only reach the services that name them        |
| `compose_services` and `volumes` tables         | None; Docker labels are the record                                        | no second copy to drift                               |
| Fetch and cache `index.json` from a repo        | Embedded catalogue for Phase 3                                            | firewalled servers; tested with the release           |
| Phase 3 RSS target ≤ 120 MB                     | ≤ 100 MB                                                                  | CLAUDE.md gate; nothing here needs more               |
| `source: "paste"\|"git"\|"template"`            | `paste` and `template`; git-sourced Compose deferred                      | not in the DoD                                        |

---

## 5. Slices

One slice per session, in this order. Every slice ends with `bun run ci` and
`bun test` passing, a Validator pass, human approval, and a commit named after
the slice. Slices marked **VPS** end with a check on the 2 GB host.

### S0 — Spike, and bound the deploy logs

**Why first:** several decisions above rest on Compose v5.5.1's behaviour, and
Phase 1 already showed that a spike is cheaper than a wrong assumption.

**Spike (no product code; the results go into a decision):** on the VPS, in a
scratch project, check each of these:

1. `config --format json` output: the form of `mem_limit`, `memswap_limit`,
   `deploy.resources.limits.memory`, volumes, `ports` and `networks`, and
   whether it reads files named by `env_file`/`include`/`extends` (it should,
   which is why the prescan exists).
2. `-p <project> stop|down` with no file.
3. Service-name aliases on a shared external network: whether two stacks'
   `db` both resolve.
4. `up -d` after only a label change: is the service recreated?
5. `--wait` with a one-shot service that exits 0.
6. Whether `--env-file` keys like `COMPOSE_FILE` and `COMPOSE_PROFILES`
   override explicit `-f`/`-p`/profiles, and whether `environment: [FOO]`
   pass-through reads the env file.
7. Which progress flags give line-shaped output.
8. Peak RSS of the `docker compose` process during `pull` and `up` of a
   three-service stack.
9. How many stack networks fit before the address pools run out.
10. How `/system/df?type=volume` behaves and how long it takes on a 1 GB volume.

**Product fix, S0-b:** bound the deploy logs.

- `dropDeployLogs` is called when a deployment has been finished for more than
  10 minutes and no subscriber is attached, driven from the scheduler's
  existing loop.
- The map keeps at most 50 deployments, dropping the oldest finished ones
  first.
- Criteria:
  - [test] the map never exceeds the bound
  - [manual] a finished deployment's page still renders its tail within 10 minutes
  - [manual] `gate:rss` unchanged

**Output:** decision D65, "Compose spike outcome", with each answer, plus the
S0-b commit. **VPS.**

### S1 — The Compose pipeline, pure (Core-Builder)

**Goal:** stages A, B, D and E as pure functions, with tests.

**Files (new):**

- `src/compose/prescan.ts`: `prescanCompose(text): PrescanResult`, which returns refusals and `references: {name, hasDefault}[]`.
- `src/compose/validate.ts`: `validateModel(model: unknown): Refusal[]`, applying the §3.3 rules to normalised JSON.
- `src/compose/transform.ts`: `transformModel(model, ctx): ComposeModel` (§3.4, §3.7, §3.8, §3.12).
- `src/compose/placeholders.ts`: `placeholdersIn(references)`, `generatePlaceholder(name, rng)`, `fqdnPlaceholder(name) → {service, port}`.
- `src/compose/env.ts`: `interpolationEnv(resolved, placeholders): {env, missing: string[]}`, which filters `COMPOSE_`/`DOCKER_`.
- `src/compose/types.ts`: `Refusal = {code, service: string|null, field: string}`, `ComposeSource`, and `ComposeModel`, the subset of the normalised model we read.
- Fixtures: `src/compose/fixtures/*.json`, captured from real `config --format json` output in S0. **Don't hand-write the normalised shape.**

**Criteria:**

- [test] every §3.3 row refuses its fixture with the right code and service. Each fixture's allowed twin passes.
- [test] prescan refuses `include`, `extends.file`, `env_file`, file-backed configs and secrets, `build`, and a service with no image; ≥ 64 KiB is refused.
- [test] the transform:
  - adds the labels
  - keeps `musdash.deployment_id` off services
  - attaches `musdash` only to routed services
  - sets `mem_limit` and `memswap_limit` (default 512 MiB when absent)
  - sets the logging driver, and `restart: unless-stopped` when absent
  - labels volumes
- [test] a reference with no value and no default is reported as missing. `${X:-d}` is not. `$$X` is not a reference.
- [test] placeholders generate the right lengths and charsets, and 1000 draws are distinct.
- [manual] nothing in `src/compose/` imports Docker, the DB, or the logger.

**Out of scope:** the subprocess, the job, the UI.

### S2 — Deploying a pasted stack (Core-Builder + UI-Builder) · **VPS**

**Goal:** DoD 1, 2 (auto domain only), 3, 4 (no delete yet), and 6 end to end.

**Core:**

- Migration `0007_compose.sql`, plus the `ResourceKind` and `ComposeSource` types.
- `src/proc/stream.ts`, lifted from `runBuilder`, with `run.ts` now using it and no behaviour change.
- `src/docker/compose.ts` (`ComposeCli`), and `DockerClient.composeHost()`.
- `src/jobs/deploy-compose.ts`, `runComposeDeploy`: A–F, gate, routes, certificate wait, `compose_file` on the deployment row. `runDeploy` dispatches on `kind` at the top, and **`deploy.ts:537` is guarded.**
- `reclaimStrays`, the reconciler and `runRemove` skip `musdash.service` containers (§3.9). Stacks get their own reconciler pass, and their own `stop` and `remove` paths. Remove never deletes volumes in this slice.
- Per-service log streams with `[service]` prefixes.
- Boot and scheduler sweep of `data/compose/tmp/`.
- Installer: `docker compose version` must succeed. If it does not, print the fix and continue (Compose resources then fail with that sentence).

**Routes:**

- `POST /e/:environmentId/resources/compose` validates name, file (prescan + raw rules), `publicService` (must be a service in the file) and port (`parseContainerPort`, required when a public service is chosen). It creates the resource and auto domain, generates placeholders, enqueues the deploy and redirects.
- `POST /r/:id/settings` accepts `composeFile` for compose resources, with the same checks.

**UI:** the paste dialog, the services table on Overview, compose-aware Settings, and the Variables wording.

**Criteria:**

- [manual, VPS] DoD 1, 2 (auto domain), 3, 4.
- [manual, VPS] DoD 6 on the form and, via a hand-made POST that skips the form, in the deploy log.
- [manual, VPS] an image resource deployed next to the stack keeps working, and the reconciler leaves the stack's containers alone for 10 minutes.
- [manual, VPS] `data/compose/tmp` is empty after a deploy, a failed deploy, and a SIGKILL of musdash mid-deploy followed by a restart.
- [manual, VPS] `ps` during a deploy shows the compose process with no inherited `MUSDASH_*` variables.
- [manual] a variable named `DOCKER_HOST` or `COMPOSE_FILE` does not change which daemon or file is used.
- [manual] `gate:rss` ≤ 100 MB.

**Out of scope:** multi-domain routing, the volume UI, delete-with-volumes, rollback, templates.

### S3 — Routing several services (Core-Builder + UI-Builder) · **VPS**

**Goal:** DoD 2 in full. Several services on several domains.

- `domains.service_name` and `container_port` are used for real. Route ids are `musdash-<rid>--<service>`. `routeHosts`, `wantedHosts`, `syncResourceRoutes` and `runStop`/`runRemove` route deletion are compose-aware.
- The Domains tab gets a service `<select>` and a port per domain. Changing the public service moves the auto domain.
- Fix the domain-ownership check on delete (§2, item 9).
- Page-scoped `stack.css`/`stack.js`, and the asset-gate lines (§3.12).

**Criteria:**

- [test] extend the Caddy route-order test: a stack's routes are inserted before the dashboard tail, and `musdash-not-found` stays last.
- [test] the sync deletes a service route when that service loses its last domain, and never touches an image resource's route.
- [manual, VPS] two services on two hosts are both reachable over HTTPS, and moving a domain between services switches its upstream.
- [manual, VPS] saving a file that removes a routed service fails the deploy, naming the domains.

### S4 — Volumes, delete, rollback (Core-Builder + UI-Builder) · **VPS**

**Goal:** DoD 4 and 5, and recovery.

- `DockerClient.volumeUsage(filter)` and `listVolumes(filter)` are read-only, cached and time-limited. `remove_volume` is a new job type.
- The Volumes section on Overview, and the delete card with the checkbox. `runRemove` for compose follows the trap 8 order with `{deleteVolumes}`.
- The `/settings` "Volumes left by deleted resources" list.
- Roll back and Deploy this again for compose, from `deployments.compose_file`.
- Fix the image/git delete copy.

**Criteria:**

- [manual, VPS] DoD 4: write a row, redeploy, change the file, redeploy, and the row is still there.
- [manual, VPS] DoD 5, run twice:
  - keep: the volume stays and appears on `/settings`
  - destroy: `docker volume ls` shows it gone
- [manual, VPS] SIGKILL during delete: after restart, the job completes with the same choice.
- [manual, VPS] roll back to the previous file restores the previous services.
- [manual] the sizes cache is bounded, and a slow `df` shows "unknown" without blocking the page past 10 s.

### S5 — Reserved slack

Slack for what S0–S4 turn up (they will). If nothing does, it becomes the
optional git-sourced Compose slice (§8).

### S6 — The template engine (Core-Builder + UI-Builder) · **VPS**

**Goal:** DoD 8 and 9 on a single seed template (use `whoami`/`nginx`, which is
cheap to run and test). The real catalogue comes in S7.

- `templates/` layout, a zod `meta.json` schema, `templates/index.ts`
  generated by `scripts/gen-templates.ts` and checked in CI (the generated
  file must match), and the `/assets/templates/<id>.svg` route.
- `/templates` grid with search, and the template dialog with domains and
  the RAM warning.
- `POST /e/:environmentId/resources/template` creates the resource with the
  placeholders and domain rows, then enqueues the deploy.
- `availableMemory()` in a module used by the dialog only. It reads
  `docker.info` (cached), the sidecar caps, and the SQL sum.

**Criteria:**

- [test] every shipped template passes the prescan and raw rules. Every FQDN placeholder names a real service. `meta.json` parses.
- [test] placeholder generation over two installs gives distinct values for every key (DoD 8).
- [test] `availableMemory` arithmetic, including clamping at 0.
- [manual, VPS] a template whose `minimum_ram_mb` exceeds availability shows the warning with its numbers, and one that fits does not (DoD 9).
- [manual] `gate:rss` with the catalogue embedded.

### S7 — The catalogue: Plausible, n8n, Ghost, then more · **VPS**

**Goal:** DoD 7.

- Verify the license, then add `templates/NOTICE` and a decision (§3.10).
- Port and test **Plausible CE** (ClickHouse + Postgres), **n8n**, and **Ghost**
  (MySQL). Each must:
  1. deploy
  2. be reachable over HTTPS
  3. complete its first-run setup
  4. survive a redeploy with its data
  5. be deletable
- **Plausible needs about 2 GB** because of ClickHouse. On the 2 GB VPS it will
  (correctly) raise the warning. It may still run if BuildKit is idle, but
  proving DoD 7 for it may need a 4 GB host. Decide that when S7 starts (open
  question Q3).
- Growing towards the ~30 curated templates in DECISIONS is **not** in the DoD.
  Each later template is a small follow-up with the same five checks. List
  candidates in RUNNING.md, don't ship untested ones.

### S8 — Phase close · **VPS**

- A fresh install on a clean VPS, then the full DoD run, 1–10, written up as
  `docs/VPS-TEST-PHASE3.md`, removed once its fixes land (CLAUDE.md).
- `gate:rss` on the final commit (DoD 10). Measure the sidecars and a running
  three-service stack separately, since the README must not quote a number that
  leaves them out.
- Docs:
  - RUNNING.md: a Compose section, including the downtime note, named volumes only, and no `build`/published ports.
  - PHASES.md DoD ticked.
  - CLAUDE.md: "Phases 1, 2 and 3 are built", plus the new rules the phase taught.

---

## 6. Risks

| Risk                                               | Where it bites | Mitigation                                                                                                  |
| -------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------- |
| Compose output or flags differ across versions     | S1, S2         | fixtures captured from real output (S0); the installer requires `docker compose`; record the tested version |
| A validation gap lets a host mount or root through | S1             | validate the normalised model; table-driven tests with allowed twins; the Validator reviews against §3.3    |
| Existing sweeps delete stack containers            | S2             | the `musdash.service` skip lands in S2 with a 10-minute soak criterion                                      |
| Address pools run out after ~30 stacks             | S2+            | measured in S0; mapped error sentence; documented                                                           |
| Stack downtime surprises users                     | S2             | stated on the deploy page and in RUNNING.md                                                                 |
| Disk fills from volumes and pulled images          | S4             | sizes in the UI; kept volumes listed; logs capped; the existing image prune                                 |
| Plausible does not fit on 2 GB                     | S7             | the warning is DoD 9; test DoD 7 on 4 GB if needed (Q3)                                                     |
| Asset caps block the UI                            | S3, S6         | page-scoped assets with their own budget                                                                    |
| Deploy logs grow RSS                               | S0             | S0-b bounds them before Compose makes them longer                                                           |
| A template's license is not what DECISIONS assumes | S7             | verify first; `NOTICE`; author our own if the terms don't allow adapting                                    |

---

## 7. Open questions for approval

**Q1 — Where does the catalogue live?**

- Recommended: embedded in the binary (§3.10).
- Alternative: a separate `musdash-templates` repo fetched at runtime, which
  needs an outbound fetch with a size cap, a cache, and an offline fallback.

**Q2 — Refuse or allow published `ports`?**

- Recommended: refuse. They bypass Caddy and ufw.
- Allowing them later is a one-rule change. A template that genuinely needs a
  raw TCP port (mail, game servers) waits for that.

**Q3 — Which host proves Plausible (DoD 7)?**

- The 2 GB VPS with the warning showing, or a temporary 4 GB VPS.

**Q4 — Should bind mounts inside the stack's own directory be allowed?**

- Recommended: no, for Phase 3. Named volumes only.
- Relative binds would need per-component symlink checks at every deploy
  (a container can plant a symlink in its own bind dir).

---

## 8. Out of scope for Phase 3

- Git-sourced Compose files (candidate for S5 slack or a Phase 3.x slice).
- `build:` in Compose.
- Private registries (`registry_credentials` is still unused).
- Zero-downtime for stacks.
- A remote template catalogue.
- Replicas.
- Bind mounts.
- Published ports.
- A per-service "reachable from other resources" switch (Phase 4 needs it for
  databases).
- `kind = 'database'`, backups and cron (Phase 4).
- Changing Docker's `daemon.json`.

---

## 9. Progress

| Slice | Status                    | Commit                    | Decisions |
| ----- | ------------------------- | ------------------------- | --------- |
| S0    | done                      | `fb3b9a6`                 | D65       |
| S1    | done                      | `27de0a3`                 |           |
| S2    | built, VPS checks pending | `ff4fa65`, `992b25e` (UI) | D66       |
| S3    | built, VPS checks pending | `1088bcf`                 | D66       |
| S4    | built, VPS checks pending | `07ecdd6`                 | D67       |
| S5    | —                         |                           |           |
| S6    | —                         |                           |           |
| S7    | —                         |                           |           |
| S8    | —                         |                           |           |
