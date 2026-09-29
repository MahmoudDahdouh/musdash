# Plan — CRUD, display names, random auto-domains, process toast, sidebar icons

Written 2026-09-29 from a read of the code as it stands (`v1.0.50`, migration
`0006`, decisions through D64). Nothing here is built yet. Each numbered slice
below is one BUILD → VERIFY → VALIDATE loop with a human approval before code
and before commit, per `CLAUDE.md`. Slices are ordered by dependency: 1 → 2 →
3 are the data layer, 4 → 5 are the shell. A slice's spec is still written
fresh at build time; this file fixes the design so those specs do not drift.

Contents

1. [Summary of what changes](#1-summary-of-what-changes)
2. [What exists today (facts the plan relies on)](#2-what-exists-today)
3. [Slice 1 — display names and slugs](#3-slice-1--display-names-and-slugs)
4. [Slice 2 — random auto-domains on sslip.io](#4-slice-2--random-auto-domains-on-sslipio)
5. [Slice 3 — full CRUD for projects, environments, resources](#5-slice-3--full-crud)
6. [Slice 4 — running-process toast](#6-slice-4--running-process-toast)
7. [Slice 5 — sidebar Home / Projects / Settings with HugeIcons](#7-slice-5--sidebar-with-hugeicons)
8. [Cross-cutting: budgets, gates, docs](#8-cross-cutting)
9. [Decisions needed before building](#9-decisions-needed-before-building)
10. [Order and estimate](#10-order-and-estimate)

---

## 1. Summary of what changes

| Ask                                                    | Design in one line                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resource names with `A-Za-z0-9`, spaces, `()[]`        | `name` becomes a free-form display name; a new immutable `slug` column (`[a-z0-9-]{1,32}`) is derived at creation and takes over every machine use (image tag, auto-domain label, uniqueness).                                                                                                          |
| Auto domain like `brave-otter.168.235.65.204.sslip.io` | The auto domain is generated **once** at creation from a vendored word list, stored in the existing `domains` row (`is_auto=1`), and routed from that row; the base is `MUSDASH_WILDCARD_DOMAIN` when set, else `<public-ip>.sslip.io` where the public IP is a Settings value seeded by the installer. |
| Full CRUD                                              | Add rename/description/delete for projects and environments and rename for resources; parent deletion runs **on the queue** as one job that tears down each child resource in the existing order before deleting the row.                                                                               |
| Persistent bottom-right toast during a running process | One global SSE endpoint that streams a snapshot of active deployments; the layout renders the toast server-side and Alpine keeps it live; clicking goes to `/d/<id>`. Deployments only, never dismissible, no client-side store.                                                                        |
| Sidebar `[Home, Projects, Settings]` with HugeIcons    | Three top-level items with inline `<symbol>` icons copied from the MIT-licensed HugeIcons free set (no dependency, no CDN); the whole Lucide sprite is replaced so stroke weights match. `Home` becomes `/` (overview), the project grid moves to `/projects`.                                          |

Nothing adds a process, a datastore, a dependency, or a build step. The only
budget at risk is `public/app.js` (673 bytes of headroom); §8 says how that is
handled.

---

## 2. What exists today

Facts verified from the code; the slices below assume them.

**Data model.** `projects(id, name, description)` → `environments(id, project_id, name, UNIQUE(project_id,name))` → `resources(id, environment_id, name, kind, …, UNIQUE(environment_id,name))` → `deployments`, `env_vars`, `domains(host UNIQUE, is_auto)`, all `ON DELETE CASCADE` with `PRAGMA foreign_keys=ON`. `shared_env_vars` cascade from both project and environment. `jobs` has no FK; ids live in `payload_json`. Migrations are hand-written STRICT SQL, `NNNN_name.sql`, statically imported in `src/db/migrations.ts` (next is `0007`); `schema.ts` is mirrored by hand.

**CRUD today.**

| Entity      | Create                           | Read                  | Update                                     | Delete                                                                   |
| ----------- | -------------------------------- | --------------------- | ------------------------------------------ | ------------------------------------------------------------------------ |
| Project     | `POST /projects`                 | `GET /`, `GET /p/:id` | missing                                    | missing (`deleteProject()` exists, no caller)                            |
| Environment | `POST /p/:id/environments`       | inside `/p/:id`       | missing                                    | missing (`deleteEnvironment()` exists, no caller)                        |
| Resource    | `POST /e/:id/resources`, `…/git` | `GET /r/:id` (5 tabs) | settings/source/auto-deploy, **no rename** | `POST /r/:id/delete` → `remove` job (`runRemove` in `src/jobs/index.ts`) |

**Name consumers.** Only two machine identifiers derive from `resources.name`: the auto-domain label (`autoDomainFor` in `src/caddy/client.ts`) and the built-image repository (`builtImageTag` in `src/build/images.ts`, regex `BUILT_IMAGE_TAG` shared with prune, `reusableBuilds`, rollback gating). Container names, Caddy route ids, labels, log files, build cache dirs are all id-based already. The regex `^[a-z0-9-]{1,32}$` is restated in seven places (CLAUDE.md, PHASES.md ×2, RUNNING.md, two agent files, the docker-client skill) and in `project.eta` client patterns.

**Auto domain today.** Requires `MUSDASH_WILDCARD_DOMAIN`; host is `<name>-<env>.<wildcard>`; written to `domains` at creation **and** recomputed live in `routeHosts` (`src/jobs/routes.ts`). No public-IP setting exists; D55 records that self-discovery is unreliable behind NAT. TLS is Caddy automatic HTTPS (no on-demand, no `ask`). ACME staging is the default (D4). `sslip.io` names correctly fall through the D55 IP-literal route to a resource route or the 404 (tested in `src/caddy/client.test.ts`).

**Events and live state.** In-process `EventEmitter` with topics `status:<rid>` (+ wildcard `status:*`, unused), `deployment:<rid>` (no wildcard), `log:<rid>`, `dlog:<did>`. SSE endpoints are per resource/deployment only; `/d/:id/events` sends the current status on connect. Enqueue publishes `status` only, never a `deployment` event with `queued`. `isWorkerBusy()` is true for prune/bootstrap jobs that have no page. No query exists for "all queued or running deployments".

**Shell.** `layout.eta` holds a 16-symbol inline Lucide sprite, a sidebar with `Projects` (→ `/`), the project/environment tree, and a pinned `Settings` link with an icon. `layout()` computes `navTree()` and RSS per request. Asset gate (`bun run gate:assets`, run by `check` and `ci`): `app.css` 30.7 KB of 32 KB, `app.js` 15.3 KB of 16 KB. Templates and `alpine.js` are not gated.

---

## 3. Slice 1 — display names and slugs

### Scope

- `resources.name` becomes a display name. Allowed: ASCII letters, digits, space, `(` `)` `[` `]`; 1–60 chars after trimming; internal whitespace collapsed to one space. Server rule lives next to `RESOURCE_NAME_RE` in `src/docker/client.ts` as `isValidDisplayName`; client `pattern` mirrors it with `( ) [ ]` escaped (browsers compile `pattern` with the `v` flag, M-1).
- New column `resources.slug TEXT NOT NULL DEFAULT ''`, backfilled `slug = name` (every existing name already matches the slug rule), then `CREATE UNIQUE INDEX idx_resources_env_slug ON resources(environment_id, slug)`. The existing `UNIQUE(environment_id, name)` stays (dropping it needs a twelve-step rebuild; two resources with the same display name in one environment is confusing anyway).
- `slugify(name)`: lowercase → every run of non-`[a-z0-9]` to `-` → collapse → strip edge dashes → cap at 28 chars (so `<slug>-<env>` stays under the 63-char DNS label limit with the wildcard scheme) → if empty, `r-<shortId(id)>`. On collision within the environment, append `-2`, `-3`, … The slug is **frozen at creation**; rename (slice 3) changes only `name`.
- Repoint the two consumers to `resource.slug`: `builtImageTag` (`src/jobs/build.ts`) and `autoDomainFor` (call sites in `src/routes/app.ts` and `src/jobs/routes.ts`, `src/jobs/deploy.ts`). `BUILT_IMAGE_TAG` keeps matching because a slug is a strict subset of the old rule.
- Replace `findResourceByNameInEnv` uniqueness with two checks: display name taken → existing key `resource-name-taken`; slug is generated with suffixing so it never fails.
- Projects: widen the existing client pattern to the same display charset (server already accepts 1–60 free text). Environments: **unchanged** in this batch (they stay `[a-z0-9-]{1,32}`; they are DNS labels in the wildcard scheme and a display/slug split for them is a separate slice).

### Files

| File                                                                                                                                            | Change                                                                                        | Role |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---- |
| `migrations/0007_resource_slug.sql`, `src/db/migrations.ts`, `src/db/schema.ts`                                                                 | column, backfill, unique index, mirror                                                        | Core |
| `src/docker/client.ts`                                                                                                                          | `isValidDisplayName`, `slugify`, keep `RESOURCE_NAME_RE` as the slug rule                     | Core |
| `src/db/queries.ts`                                                                                                                             | `createResource` takes `slug`; `findResourceBySlugInEnv`                                      | Core |
| `src/routes/app.ts`                                                                                                                             | both create handlers: validate display name, derive slug, pass to `autoDomainFor`             | Core |
| `src/jobs/build.ts`, `src/jobs/routes.ts`, `src/jobs/deploy.ts`                                                                                 | `resource.slug` in place of `resource.name`                                                   | Core |
| `src/views/pages/project.eta`, `resource.eta`                                                                                                   | patterns, hint text ("Letters, digits, spaces, ( ) [ ]"), show slug read-only on Settings tab | UI   |
| `CLAUDE.md`, `docs/PHASES.md`, `docs/RUNNING.md`, `.claude/agents/*.md`, `.claude/skills/docker-client/SKILL.md`, `src/build/images.ts` comment | the regex now describes `slug`, not `name`                                                    | Core |
| `docs/DECISIONS.md`                                                                                                                             | D65: display name vs slug                                                                     | Core |

### Acceptance criteria

1. Migration applies to a populated database; every pre-existing row has `slug = name` (test in the `single-user.test.ts` style, `:memory:`).
2. `slugify` unit test: `"My App (v2)"` → `my-app-v2`; `"  --x-- "` → `x`; `"(((" ` → fallback; 40-char input capped at 28 without a trailing dash.
3. Creating `Web (prod)` and `web prod` in one environment yields slugs `web-prod` and `web-prod-2`; creating `Web (prod)` twice is refused with `resource-name-taken`.
4. A git build after migration produces `musdash/<slug>:<id>`; `bun test` for `images`, `run`, `caddy/client` still green.
5. The old regex no longer appears against `name` anywhere in docs or agent files (`grep`).

### Out of scope

Environment display names; renaming (slice 3); changing container names.

---

## 4. Slice 2 — random auto-domains on sslip.io

### Design

- **Base domain** = `MUSDASH_WILDCARD_DOMAIN` when set (operators who did the DNS work keep their scheme), else `<public_ip>.sslip.io` when a public IP is known, else none (today's behavior, with today's hint on the Domains tab).
- **Public IP** is a Settings row `public_ip`, following the `dashboard_host` pattern (`src/settings.ts`): database first, env `MUSDASH_PUBLIC_IP` as seed, empty row means "explicitly none". `scripts/install.sh` writes `MUSDASH_PUBLIC_IP=$(hostname -I | awk '{print $1}')` into `musdash.env` (it already computes that value for its banner) and the Settings page shows the value with an edit field and the hint that it must be the address the internet reaches this box on. No outbound probe: musdash must work on a firewalled host, and D55 already ruled out self-discovery.
- **Label** = `<adjective>-<noun>` from two vendored arrays (≈120 × 120, short, lowercase, unambiguous, no offensive words) in `src/domains/words.ts`; generator in `src/domains/auto.ts` retries on `domainExists(host)` up to 5 times then appends a 4-char `randomToken` suffix. Every generated host is run through `isValidHostname` and refused if equal to the dashboard host (N-3).
- **Generated once, stored, never recomputed.** At resource creation the host is written to `domains` with `is_auto=1` exactly as today. `routeHosts` stops calling `autoDomainFor` and routes only stored rows. The `(auto)` marker stays; the Domains tab gains a **"Generate automatic domain"** button (shown when the resource has no `is_auto` row and a base is configured) posting to `POST /r/:id/domains/auto`, which inserts the row and enqueues `sync_routes`. Deleting the auto row is allowed like any domain.
- Existing installs: rows written under the wildcard scheme keep working unchanged (they are stored). Resources created while no base existed get the new button. `autoDomainFor` is deleted once nothing calls it.
- TLS: unchanged mechanism (automatic HTTPS, host on the route at first deploy, D39 certificate wait covers it). Keep one auto host per resource for its lifetime so redeploys never burn Let's Encrypt duplicate-certificate limits.

### Files

| File                                                       | Change                                                                                                                                                | Role |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `src/domains/words.ts`, `src/domains/auto.ts` (+ test)     | word lists, `generateAutoHost(base)`, `autoDomainBase()`                                                                                              | Core |
| `src/settings.ts`, `src/settings-view.ts`, `src/config.ts` | `public_ip` setting with `MUSDASH_PUBLIC_IP` seed and IPv4/IPv6 validation                                                                            | Core |
| `src/routes/app.ts`                                        | creation uses the generator; new `POST /r/:id/domains/auto`; Settings save for `public_ip` (+ `sync_routes` not needed: existing hosts do not change) | Core |
| `src/jobs/routes.ts`, `src/jobs/deploy.ts`                 | `routeHosts(resourceId)` reads rows only                                                                                                              | Core |
| `src/caddy/client.ts`                                      | remove `autoDomainFor`                                                                                                                                | Core |
| `src/views/pages/resource.eta`, `settings.eta`             | button + hint on Domains tab; Public IP field                                                                                                         | UI   |
| `scripts/install.sh`                                       | seed `MUSDASH_PUBLIC_IP`                                                                                                                              | Core |
| `docs/RUNNING.md`, `docs/DECISIONS.md` (D66)               | document sslip default, the wildcard override, and the rate-limit caveat                                                                              | Core |

### Acceptance criteria

1. With `public_ip=168.235.65.204` and no wildcard, a new resource gets a row like `brave-otter.168.235.65.204.sslip.io`, `is_auto=1`; with the wildcard set, base is the wildcard; with neither, no row and the button is hidden.
2. Generator test: 1,000 draws produce valid hostnames (`isValidHostname`), never the dashboard host, and a forced collision path yields a suffixed host.
3. `routeHosts` returns stored rows minus the dashboard host and nothing derived from names (unit test with a temp database).
4. The D55 test still holds (sslip names are not IP literals).
5. Manual on a real VPS, staging ACME: deploy → `https://<pair>.<ip>.sslip.io` serves the app within the D39 wait; record the outcome and whether Let's Encrypt scoped the rate limit per `<ip>.sslip.io` in DECISIONS.

### Risks to record

- `sslip.io` is a third-party DNS service; if it is down the URL is dead and the first deploy waits the full 30 s for a certificate. Custom domains are unaffected.
- Whether `sslip.io` is on the Public Suffix List could not be confirmed from this environment. If it is not, the 50-certificates-per-week limit is shared by every sslip.io user worldwide. The generated-once rule and the staging default keep exposure low; the Domains tab hint should say "for trying things out — attach a real domain before relying on it", matching RUNNING.md's tone for the bare-IP dashboard.

---

## 5. Slice 3 — full CRUD

### Routes to add

All POST with `csrf` in the body, the 404 → 400 → keyed-refusal → write → redirect order of `POST /p/:id/environments`, and no Docker or Caddy call in a handler.

| Route                  | Body                                         | Effect                                                                 |
| ---------------------- | -------------------------------------------- | ---------------------------------------------------------------------- |
| `POST /p/:id/settings` | `name`, `description`                        | `updateProject`; redirect `/p/:id?tab=settings`                        |
| `POST /p/:id/delete`   | —                                            | enqueue `remove_project {projectId}`; redirect `/projects`             |
| `POST /e/:id/settings` | `name` (slug rule, `env-name-taken`)         | `updateEnvironment`; redirect `/p/:projectId`                          |
| `POST /e/:id/delete`   | —                                            | enqueue `remove_environment {environmentId}`; redirect `/p/:projectId` |
| `POST /r/:id/rename`   | `name` (display rule, `resource-name-taken`) | `updateResource({name})`; redirect `/r/:id?tab=settings`               |

Environment rename under the wildcard scheme changes nothing stored (auto hosts are rows now, slice 2), so no route sync is needed; the old wildcard host keeps working, which is the safe behavior.

### Parent deletion on the queue

New job types `remove_environment` and `remove_project` in `JobType` (plain TEXT column, no migration). The job:

1. Loads the parent; if gone, returns (idempotent, like `runRemove`).
2. For each environment (project case) and each resource: cancel pending deploy jobs for the resource (new `cancelPendingDeploysFor(resourceId)` built on the guarded UPDATE of D59), then call `runRemove({resourceId, deleteRow: true})` — the same function, not a copy — so containers, strays, route, log buffer and files, build cache go in the established order.
3. Deletes the parent row last; cascades remove shared env vars.
4. Publishes nothing new; each `runRemove` already publishes `stopped`.

A crash mid-job leaves identifiable rows and containers; the reconciler's orphan sweep and the next run of the same job (lease recovery) finish it. The handler never deletes a row, so the cascade cannot outrun container teardown (trap 8).

### UI

- `project.eta`: new `settings` tab (name, description, danger card "Delete project" listing what goes: N environments, M resources, their containers, domains, variables, deployment history). Per-environment head gets a small menu: Rename (dialog) and Delete (danger, `data-confirm`). Deleting the last environment is allowed; the project page already renders an empty state.
- `resource.eta` Settings tab: a Rename card at the top (display name field, slug shown read-only beneath: "Used for the image tag; does not change").
- Confirmation: the shared `data-confirm data-confirm-danger` dialog for environments and resources; for projects, a typed-name field in the dialog form (the GitHub-disconnect pattern), because it destroys everything beneath it.
- New error keys added in the three required places: `src/routes/errors.ts`, `src/views/partials/errors.eta`, `scripts/check-error-pages.ts` (which fails on any unexercised key). Reuse `resource-name-taken` and `env-name-taken`; add `project-name-invalid`, `project-confirm`.

### Acceptance criteria

1. Cascade test on `:memory:` with `foreign_keys=ON`: deleting an environment row removes its resources, deployments, env vars, domains, shared vars.
2. Job ordering test with a stub `DockerClient`: for a project with two environments and three resources, container removals and route deletes all happen before the project row disappears, and the job is a no-op on second run.
3. Rename tests: display name uniqueness per environment; slug unchanged after rename; sidebar and breadcrumb show the new name on the next render.
4. `scripts/check-error-pages.ts` passes with the new keys and the new 404/400 rows.
5. Manual: delete a project whose resource is mid-deploy; the deploy fails cleanly, containers are gone, `docker ps` and Caddy routes show no leftovers.

---

## 6. Slice 4 — running-process toast

### Design

- **Source of truth**: a new query `activeDeployments()` in `src/db/queries.ts` — deployments with `status IN ('queued','running')` joined to resource, environment and project names, ordered oldest first; one statement, per request, like `navTree()`.
- **Live feed**: add a `deployment:*` wildcard in `src/events.ts` mirroring `status:*`; publish a `deployment` event with `status: "queued"` at the three enqueue sites in `src/jobs/deploy.ts` so a queued deploy is announced. New endpoint `GET /events` in `src/routes/sse.ts` using `eventStream()`: sends `event: active` with the full snapshot on connect and again on every `deployment:*` event (send the list, not diffs — the client holds no state it could get wrong).
- **Render**: `layout()` adds `active: ActiveDeploymentView[]` for signed-in renders. `layout.eta` renders `<a class="toast" href="/d/<id>">` inside the signed-in branch, hidden when the list is empty, showing the running deployment's resource name and the live `@status` label, plus "+N queued" when more are waiting. Multiple rows: one toast, links to the running one (or the first queued).
- **Client**: one small Alpine component (`processToast`) opens `/events`, replaces `active` from each snapshot, and updates href/label/visibility. It never reloads the page (D40's reload stays on the deployment page component). Not dismissible: dismissal that survives navigation would need client-side state, which CLAUDE.md rules out; the toast is small and links somewhere useful.
- **CSS**: fixed bottom-right, `z-index` above the drawer (20) and scrim, below `.skip` (30) and the `<dialog>` top layer; `prefers-reduced-motion` respected; below 760 px it sits above the safe-area inset and does not overlap the log panel's "Jump to latest" button (which is absolute inside the log, so a 12px bottom margin plus the panel's own padding is enough — verify on a phone).
- **Scope**: deployments only. Prune, sidecar bootstrap and `sync_routes` jobs have no page to link to and are not shown.
- **Stale rows**: a `running` deployment whose worker died reads as running until lease recovery (documented in `src/resource-state.ts`). The toast makes that visible; the fix (calling the existing but unused `failStuckDeployment` from the worker's startup recovery) is a one-line follow-up noted for the spec, not a dependency.

### Files

| File                                                      | Change                                 | Role |
| --------------------------------------------------------- | -------------------------------------- | ---- |
| `src/db/queries.ts`                                       | `activeDeployments()`                  | Core |
| `src/events.ts`, `src/jobs/deploy.ts`                     | `deployment:*` wildcard; queued events | Core |
| `src/routes/sse.ts`                                       | `GET /events` snapshot stream          | Core |
| `src/routes/layout.ts`, `src/views/render.ts`             | `active` in `LayoutData`               | Core |
| `src/views/layout.eta`, `public/app.css`, `public/app.js` | toast markup, styles, `processToast`   | UI   |

### Acceptance criteria

1. `activeDeployments()` excludes `cancelled`, `succeeded`, `failed`; ordered by `created_at`.
2. `GET /events` returns 401 without a session; with one, the first frame is a snapshot; a published `deployment` event yields a new snapshot; the listener is removed on cancel (count `events.listenerCount` before/after).
3. `bun run gate:assets` passes (see §8).
4. Manual: start a deploy, navigate to `/settings` (a page with no other stream) — the toast is there, live, and disappears when the deploy settles without a reload; click goes to `/d/<id>`; two tabs both update.

---

## 7. Slice 5 — sidebar with HugeIcons

### Design

- **Items**: `Home` → `/`, `Projects` → `/projects`, `Settings` → `/settings`. The project grid moves from `/` to `/projects` (the POST stays `/projects`). `/` becomes a small **Home** overview built from data slices 4 and 3 already provide: active deployments (same query), the last ten deployments across all resources (needs one more query), and counts (projects, resources, running). No new capability beyond that; if the human prefers, Home can alias the grid for now and the overview becomes its own slice (§9).
- **Active state**: a `LayoutOptions.active: "home" | "projects" | "settings"` replaces the by-absence rule and the `activeSettings` flag; project and environment pages set `projects` plus the existing tree ids. Exactly one `aria-current="page"` per render.
- **Tree**: the project/environment tree stays, nested under `Projects`; `Settings` stays pinned at the bottom.
- **Icons**: replace the whole Lucide sprite with HugeIcons _stroke rounded_ equivalents (16 existing symbols + `home-01`, `folder-01`/`grid-view`, `settings-01`) so stroke weights match, rather than mixing sets. `.icon` `stroke-width` goes from 2 to 1.5 (HugeIcons is drawn at 1.5). Source: copy path data from the MIT-licensed `@hugeicons/core-free-icons` package (fetched once with `npm pack` into the scratchpad, **not** added to `package.json`), reduced to geometry-only `<symbol viewBox="0 0 24 24">` with no `stroke`/`fill` attributes, per the sprite comment's rules. Update the attribution comment (HugeIcons, MIT) and record the switch in DECISIONS (a new third-party source).
- Icons live in the template, so they cost per-page HTML bytes and binary size, not gated asset bytes. Budget the sprite at ≤ 4 KB total.

### Files

| File                                                | Change                                                              | Role |
| --------------------------------------------------- | ------------------------------------------------------------------- | ---- |
| `src/routes/app.ts`                                 | `GET /` → home, `GET /projects` → grid; `active` option per handler | Core |
| `src/db/queries.ts`                                 | `recentDeployments(limit)` and counts for Home                      | Core |
| `src/routes/layout.ts`, `src/views/render.ts`       | `active` option; register `home` page                               | Core |
| `src/views/pages/home.eta` (new), `projects.eta`    | Home overview; grid unchanged                                       | UI   |
| `src/views/layout.eta`, `public/app.css`            | sprite, three nav items, generalised icon-row rule                  | UI   |
| `docs/PHASES.md` §11 route table, `docs/RUNNING.md` | routes                                                              | Core |

### Acceptance criteria

1. Render test: for `/`, `/projects`, `/p/:id`, `/settings` exactly one nav link carries `aria-current="page"`, and it is the expected one.
2. All existing `<use href="#i-…">` references still resolve (grep symbol ids against uses).
3. `bun run gate:assets` passes; `bun run check` clean.
4. Manual: desktop and < 760 px drawer; dark mode; icons render at the same weight.

---

## 8. Cross-cutting

**Asset budget.** Measured today: `app.css` 30.7 / 32 KB, `app.js` 15.3 / 16 KB. Slice 4 needs roughly 0.5–0.9 KB of JS and ~0.6 KB of CSS; slice 5 ~0.3 KB of CSS. Order of remedies: (1) factor the three near-identical `EventSource` components in `app.js` into one helper, which should free more than the toast costs; (2) if it still does not fit, raise the JS ceiling to 20 KB with a DECISIONS entry — the gate script says the budget moves only with a recorded decision, and this is one. Never bypass the gate.

**RSS.** No new dependency, no new retained data beyond a ≈30 KB word list and one listener per open page (released through `eventStream()`). Run `bun run gate:rss` once after slice 4 and note the number in DECISIONS.

**Tests.** Only where the plan says: migration/backfill, slugify, generator, cascade + job ordering, the wildcard/SSE snapshot, and the layout active-state render. No broad coverage.

**Error keys.** Every new key goes into `errors.ts`, `errors.eta`, and `scripts/check-error-pages.ts` together.

**Docs to touch.** CLAUDE.md (name rule → slug rule), PHASES.md (§7 name comment, §10 auto-subdomain scheme, §11 routes), RUNNING.md (sslip default, public IP, delete/rename), DECISIONS.md (D65 slugs, D66 sslip auto-domains, D67 parent deletion on the queue, D68 HugeIcons sprite, and the JS budget if raised). This plan file can be deleted once the five slices land, the way VPS test reports are.

**Roles per file** (D5): `src/routes/app.ts` handlers that only validate/enqueue/redirect are Core; handlers whose change is which template renders are UI. The spec for each slice names the owner per handler.

---

## 9. Decisions needed before building

Defaults are what the plan assumes; say so if a different answer is wanted.

1. **Home page content.** Default: a real overview at `/` (active + recent deployments, counts) and the grid at `/projects`. Alternative: `Home` and `Projects` both link to `/` for now, with `Home` highlighted.
2. **Environment names** stay `[a-z0-9-]{1,32}` (default), or get the same display/slug treatment as resources (adds a column, a migration and a slice).
3. **Project delete confirmation**: typed project name (default) or the plain confirm dialog.
4. **Image tag label**: slug (default, human-readable `musdash/my-app:…`) or `shortId(resource.id)`.
5. **Public IP source**: installer-seeded Settings value (default). An outbound "what is my IP" probe is rejected by the firewalled-host rule.
6. **JS budget**: trim first, then raise to 20 KB with a decision (default), or hard stop at 16 KB.
7. **Toast scope**: deployments only (default), never dismissible.
8. **Icon set**: replace all Lucide symbols with HugeIcons (default) or add three HugeIcons beside Lucide and accept mixed stroke weights.

---

## 10. Order and estimate

| #   | Slice                      | Depends on     | Size                                                             |
| --- | -------------------------- | -------------- | ---------------------------------------------------------------- |
| 1   | Display names + slug       | —              | S (one migration, two consumers, docs sweep)                     |
| 2   | Random sslip auto-domains  | 1              | M (setting, generator, route-hosts change, installer, VPS check) |
| 3   | Full CRUD                  | 1, 2           | M (five routes, two jobs, three templates, error harness)        |
| 4   | Process toast              | — (3 optional) | S–M (query, wildcard, endpoint, layout; JS budget work)          |
| 5   | Sidebar + HugeIcons + Home | 4              | S–M (sprite swap, three items, Home page)                        |

Each slice ends with `bun run check`, `bun test`, and the manual checks listed, then a commit named for the slice. Slice 2's certificate check and slice 3's mid-deploy delete need a real Linux host with Docker; neither can be verified on macOS or in this container.
