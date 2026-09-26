# Running musdash

How to run the code on your local machine (Windows + WSL2) and on a VPS, step by
step, and what you can actually do with it once it is up.

This describes the code as it stands at commit `1ec05d0` (Phase 2, checkpoint
4a). Anything not listed under **What works today** is not built yet.

---

## Contents

- [What works today](#what-works-today)
- [Prerequisites](#prerequisites)
- [Part A — Local machine (Windows + WSL2)](#part-a--local-machine-windows--wsl2)
- [Part B — VPS (fresh Ubuntu)](#part-b--vps-fresh-ubuntu)
- [Using the dashboard](#using-the-dashboard)
- [Configuration reference](#configuration-reference)
- [Operating it](#operating-it)
- [Troubleshooting](#troubleshooting)

---

## What works today

**Deploy targets**

| Source                        | Status                                               |
| ----------------------------- | ---------------------------------------------------- |
| Public Docker image           | Works — `nginx:alpine`, `ghcr.io/you/app:v1.2`       |
| Locally-built image           | Works — an image already in the daemon deploys as-is |
| Public git repo (Dockerfile)  | Works — repo URL typed in by hand                    |
| Public git repo (zero-config) | Works — Railpack detects the language and builds     |
| Private git repo              | Client exists, **no UI to connect GitHub yet**       |
| Docker Compose / templates    | Not built (Phase 3)                                  |
| Managed databases / backups   | Not built (Phase 4)                                  |

**Platform features**

- Projects → environments → resources. A new project gets a `production`
  environment automatically.
- Environment variables encrypted at rest (AES-256-GCM); decrypted values never
  reach a log line, including on error paths and in build logs.
- Zero-downtime deploys — the old container keeps serving until the new one
  passes its health gate _and_ the Caddy route has switched.
- One-click rollback to the previous image (rollback never rebuilds).
- Live deploy and container logs over SSE.
- Automatic HTTPS at `<resource>-<environment>.<wildcard-domain>`, plus custom
  domains.
- A reconciler that restarts anything that disappears — a reboot or a stray
  `docker rm -f` heals within 30 seconds.
- Two managed sidecars, started and self-healed by musdash itself: **Caddy**
  (`caddy:2-alpine`) and **BuildKit** (`moby/buildkit:v0.27.0`).
- Daily image prune, because disk fills before RAM does.
- Hard memory limit on every container it creates (512 MB by default).

**The GitHub gap.** `src/github/` has a working client — App JWT minting,
installation-token caching, repo listing, tarball fetch — and it is covered by
tests. What does not exist yet is the route and page that register the App and
run the install callback, so there is no way to connect GitHub through the UI.
Private repositories are therefore not deployable yet. Public repos work: the
git-resource form takes the repo URL as free text.

---

## Prerequisites

### Both environments

- **Docker Engine with a real unix socket** at `/var/run/docker.sock`.
- **Bun** ≥ 1.4.
- `buildctl` and `railpack` on `PATH` — only needed to build from a git repo.
  The VPS installer places both for you.

### Why Linux is not optional

Docker is reached with `fetch({ unix: "/var/run/docker.sock" })` — no client
library (see [DECISIONS.md](DECISIONS.md#docker-access)). Docker Desktop on
Windows exposes a **named pipe**, which Bun's `fetch` cannot reach. So on
Windows, everything runs inside WSL2 with Docker Engine installed **inside the
distro** — not Docker Desktop's WSL integration.

---

## Part A — Local machine (Windows + WSL2)

### A1. Install WSL2 Ubuntu

In PowerShell, as Administrator:

```powershell
wsl --install -d Ubuntu-24.04
```

Reboot if prompted, then open the Ubuntu shell. Everything from here runs
**inside WSL**, not in PowerShell.

### A2. Install Docker Engine inside the distro

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
```

Close and reopen the Ubuntu shell so the group takes effect, then verify:

```bash
docker version          # both Client and Server must report
ls -l /var/run/docker.sock
```

If the Server section is missing, start it: `sudo service docker start`. On a
WSL distro without systemd this is needed after every Windows reboot.

### A3. Install Bun

Install the version in `.bun-version` (1.4.2) — the one CI tests and the RAM
gate measures (D41):

```bash
curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.2"
exec $SHELL -l
bun --version
```

### A4. Get the code onto the Linux filesystem

**Do not run from `/mnt/d/coding/musdash`.** SQLite over the `9p` mount that
backs `/mnt/*` takes locks that fail intermittently — this cost real debugging
time already. Clone into the WSL filesystem instead:

```bash
git clone <your-remote> ~/musdash     # or: cp -r /mnt/d/coding/musdash ~/musdash
cd ~/musdash
bun install
```

Edit on Windows in `\\wsl$\Ubuntu-24.04\home\<you>\musdash` if you like, but
**run** from `~/musdash`.

### A5. Install the build tools (only for git-repo deploys)

Skip this if you are only deploying pre-built Docker images.

```bash
# buildctl, copied out of the same BuildKit image musdash runs — this keeps
# client and daemon versions matched by construction.
docker pull moby/buildkit:v0.27.0
cid=$(docker create moby/buildkit:v0.27.0)
sudo docker cp "$cid:/usr/bin/buildctl" /usr/local/bin/buildctl
docker rm "$cid"
sudo chmod 755 /usr/local/bin/buildctl

# railpack
curl -fsSL -o /tmp/rp.tar.gz \
  https://github.com/railwayapp/railpack/releases/download/v0.37.0/railpack-v0.37.0-x86_64-unknown-linux-musl.tar.gz
tar -xzf /tmp/rp.tar.gz -C /tmp
sudo install -m 755 /tmp/railpack /usr/local/bin/railpack

buildctl --version && railpack --version
```

### A6. Create the Docker network

Must be user-defined — the default bridge gives no name resolution, and Caddy
dials app containers by name.

```bash
docker network create musdash
```

### A7. Write `.env`

```bash
cat > ~/musdash/.env <<'EOF'
MUSDASH_PORT=8000
MUSDASH_DATA_DIR=./data
MUSDASH_DOCKER_SOCKET=/var/run/docker.sock
MUSDASH_NETWORK=musdash
MUSDASH_ACME_STAGING=true
MUSDASH_DEFAULT_MEMORY_MB=512
MUSDASH_HEALTH_TIMEOUT_SEC=60
MUSDASH_LOG_LEVEL=debug
EOF
```

Bun loads `.env` automatically. Leave `MUSDASH_WILDCARD_DOMAIN` unset locally —
you have no public DNS, so there is nothing for ACME to validate. Resources will
still deploy and be reachable by container port; they just get no auto-domain.

`NODE_ENV` is deliberately absent: outside production the server binds
`0.0.0.0`, so you can reach it from Windows.

### A8. Run it

```bash
cd ~/musdash
bun run dev
```

Watch for `musdash listening` in the log. Then, on startup, musdash enqueues the
two sidecar bootstraps — first boot pulls `caddy:2-alpine` and
`moby/buildkit:v0.27.0`, which takes a minute or two. Watch it:

```bash
docker ps --filter label=musdash.role
```

You should end up with `musdash-caddy` and `musdash-buildkit` running.

### A9. Open it

From Windows, `http://localhost:8000` normally works via WSL's port forwarding.
If it does not, find the distro IP and use that:

```bash
hostname -I | awk '{print $1}'      # e.g. 172.x.x.x → http://172.x.x.x:8000
```

The first page is **setup** — create your admin account. There is no default
password and no second user; self-hosted software has one user.

### A10. Verify the toolchain

```bash
bun test          # the four things worth testing: demux, crypto, queue, env parse
bun run check     # prettier + biome (warnings are errors) + tsc --noEmit
bun run gate:rss  # compile, boot, idle 60s, fail above 100 MB
```

`bun run check` is what the pre-commit hook runs. `gate:rss` is the hard product
gate — it must stay under 100 MB.

---

## Part B — VPS (fresh Ubuntu)

A fresh Ubuntu 22.04/24.04 host with root SSH. **No build machine and no DNS are
required.**

**Host size.** 1 GB of RAM is the supported minimum: it runs the control plane,
Caddy, BuildKit and a few small apps, and survives a reboot unattended. Use
**2 GB** if you will build from GitHub, because BuildKit and image extraction
spike during a build. A 512 MB host is not supported: without swap it thrashed
and never came back from a reboot (C-3), and it has not been re-tested with
swap. Tested on: RamNode KVM, 1 GB, Ubuntu 24.04.1, kernel 6.8, cgroup v2.

**Swap.** On a host under 2 GB with no swap, the installer creates a 1 GiB
swapfile at `/musdash.swap` and adds it to `/etc/fstab`, so apt, dockerd and
the compile have somewhere to page out instead of stalling the host (D38).
Containers cannot use it: musdash sets every container's swap limit equal to
its memory limit, so a leaking app is still killed at its cap. It is skipped,
with a line saying why, when swap already exists, on a cgroup v1 host, inside
an OpenVZ/LXC container, on a root filesystem other than ext4 or XFS, or with
less than 3 GiB free on `/`. `MUSDASH_SWAP=0` skips it. To remove it later:
`swapoff /musdash.swap`, delete its line from `/etc/fstab`, then
`rm /musdash.swap`.

### B1. Run one command

```bash
ssh root@<server-ip>
curl -fsSL https://raw.githubusercontent.com/MahmoudDahdouh/musdash/main/scripts/install.sh | bash
```

That installs Docker, `buildctl`, `railpack`, `git`, and Bun; clones the source;
**compiles the binary on the host** (~60s); creates the `musdash` user, network,
and Caddy volumes; and starts the systemd unit.

> **While the repository is private**, the one-liner cannot clone it. Copy the
> checkout up and run the script from inside it — it builds from the current
> directory when it finds a `package.json` and a `src/`:
>
> ```bash
> rsync -av --exclude node_modules --exclude data --exclude dist ./ root@<ip>:/root/musdash/
> ssh root@<ip> 'cd /root/musdash && ./scripts/install.sh'
> ```

### B2. Open the IP and create your account

```
http://<server-ip>
```

Caddy serves the dashboard on port 80 as a catch-all route, so the bare IP works
with no DNS at all. Create your admin account and start adding projects.

**This is plain HTTP.** No certificate authority issues certificates for an IP
address, so until you attach a domain the admin session cookie travels in
plaintext, and **GitHub cannot be connected** — its App requires a public HTTPS
URL. Treat an IP-only install as fine for trying musdash out, and attach a domain
before you rely on it.

### B3. Deploy an app on your main domain

Point your domain's A record at the server:

| Type | Name              | Value          |
| ---- | ----------------- | -------------- |
| A    | `example.com`     | your server IP |
| A    | `www.example.com` | your server IP |

Then in the dashboard: create a project, add a resource, deploy it, and open its
**Domains** tab. Add `example.com`. Caddy obtains a certificate automatically and
routes the domain to that container. Resource routes carry a host matcher and are
evaluated before the dashboard's catch-all, so your app wins its own domain.

### B4. Move the dashboard onto a domain (recommended)

Add an A record for `mus.example.com` pointing at this server, then open
**Settings -> Dashboard address** in the dashboard, enter the hostname and save.

That is the whole procedure. No SSH, no env file, no restart: the value is
stored in SQLite, a job pushes the route to Caddy within a second, and Caddy
obtains a certificate for the name automatically. The server's bare address
keeps working over plain HTTP as a fallback, so a DNS or certificate problem
cannot lock you out.

The page tells you if the name does not resolve to this server, and if the proxy
cannot reach the dashboard — see the firewall note below, which is the usual
cause.

`MUSDASH_DASHBOARD_HOST` still exists for an unattended install:

```bash
MUSDASH_DASHBOARD_HOST=mus.example.com ./scripts/install.sh
```

Once you save a hostname on the Settings page it wins, and that env line is
ignored. The GitHub App's callback and webhook URLs are derived from it, so
there is nothing else to set before connecting GitHub.

One thing still lives in `musdash.env` and still needs an edit plus a restart —
and the Settings page has a **Restart musdash** button for exactly that:

```ini
MUSDASH_ACME_EMAIL=you@example.com
```

Optionally add `*.mus.example.com` and set `MUSDASH_WILDCARD_DOMAIN` to give
every resource a free auto-subdomain alongside its real domain.

### B5. Firewall

```bash
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp
ufw allow in on docker0 to any port 8000 proto tcp
ufw deny 8000/tcp
ufw enable
```

`install.sh` writes those last two rules for you when ufw is present, but it does
not enable ufw — many provider images ship it installed and inactive. The
dashboard binds `0.0.0.0:8000` because Caddy runs in a container and reaches the
host through its bridge address — a socket on `127.0.0.1` cannot accept that
connection (D23). musdash therefore refuses, with a 403, any request on port 8000
whose TCP peer is a public address (D31): loopback, private and CGNAT ranges get
through, the internet does not. The firewall is the second layer. Get the bridge
rule wrong and the proxy times out reaching its own upstream.

Only 22, 80 and 443 should be reachable from outside. Neither sidecar API has a
TCP port at all: Caddy's admin API is a unix socket at
`$MUSDASH_DATA_DIR/caddy/admin.sock` (D29) and BuildKit's is
`$MUSDASH_DATA_DIR/buildkit/buildkitd.sock` (D32), each in a directory only the
`musdash` user can enter. Both APIs are unauthenticated — a TCP listener inside
either container would answer every app on the `musdash` network.

Verify the proxy's path to the dashboard after any firewall change — this is the
exact dial Caddy performs:

```bash
docker exec musdash-caddy wget -qO- --timeout=3 http://musdash-host:8000/health
```

### B6. Upgrading

```bash
ssh root@<server-ip>
cd /opt/musdash-src && ./scripts/install.sh
```

It pulls the latest source, rebuilds, stops the service, replaces the binary, and
restarts. Migrations run at startup and `musdash.env` is never overwritten.

**Never delete** the `musdash-caddy-data` or `musdash-caddy-config` volumes —
they hold your certificates, and losing them means re-issuing everything and
burning the Let's Encrypt rate limit (50 per domain per week).

The first start after upgrading from a release before D33 replaces the build
daemon once, with a warning saying why: its memory cap is now sized from the
host. The build cache is kept (`musdash-buildkit-cache` survives), and the new
daemon carries the build-cache cap too, so nothing needs removing by hand. The
same one-off replacement happens after you resize the VPS or change
`MUSDASH_BUILDKIT_MEMORY_MB`.

---

## Using the dashboard

### Deploy a public Docker image

1. **New project** → it gets a `production` environment automatically.
2. **Add resource** → choose the image source, enter a name matching
   `^[a-z0-9-]{1,32}$` (it becomes a container name and a DNS label) and an
   image reference like `nginx:alpine`.
3. Set the container port and an optional health path.
4. **Deploy.** The route handler enqueues a job and redirects immediately — the
   UI never waits on Docker. Watch the deploy log stream live.
5. If a wildcard domain is configured, the resource is reachable at
   `<resource>-<environment>.<wildcard-domain>` with a certificate issued
   automatically.

### Deploy from a public git repo

Use the git-resource form. Fields: repo URL, branch (defaults to `main`), and
either `railpack` (zero-config detection) or `dockerfile` with an optional
Dockerfile path and build context.

The source is fetched as a **tarball**, not a `git clone` — it is one HTTP
request and no `.git` directory on disk. BuildKit builds it, the image is loaded
into the daemon, and the normal deploy pipeline takes over from there.

Private repos work through the GitHub App connect flow under **Settings**.

### Everything else

- **Env vars** — `KEY=value` text, encrypted at rest. Resolution is project →
  environment → resource, most specific winning. Project and environment
  variables are edited on the project page's **env** tab; resource variables on
  the resource's own.

  Each variable is delivered to the **runtime** (the container), the **build**
  (as a build arg), or **both** — three separate boxes on each form. A build
  variable is baked into the image, so put a token there only if the build
  genuinely needs it.

  A value may reference another with `${OTHER}`, resolved after all three
  levels merge, so a resource variable can reference a project one. References
  expand once and do not recurse; an undefined reference fails the deploy
  rather than silently becoming empty. Write `$$` for a literal `$` — note it
  collapses unconditionally, so a value containing `$$` must be written `$$$$`.

  > **Upgrading from before this existed:** every variable defaulted to
  > runtime-only. If a resource previously relied on one reaching its build,
  > re-save it in the **build** or **both** box. Until then it is delivered to
  > the container only — which also means runtime secrets are no longer baked
  > into image history.

- **Custom domains** — add one and Caddy starts obtaining its certificate as
  soon as the resource's route carries the name, which takes seconds to a
  minute. A deploy that puts a new name on the route waits up to 30s for its
  certificate before it reports success, and says in the deploy log if none
  arrived (D39).
- **Rollback** — one click, back to the previous image. It reuses the existing
  image and never rebuilds.
- **Stop / restart / delete** — delete removes the container, the route, and the
  volumes.
- **Logs** — live over SSE, from an in-memory ring buffer (1000 lines per
  resource) plus rotated files under `data/logs/`. Logs are never written to
  SQLite.
- **Request size limits** (D35) — every form submission is capped at 256 KB and
  anything musdash receives at 1 MB. That caps the body, not the memory: musdash
  may hold a body a few times over while reading and checking it, so one
  request costs at most a few MB instead of the hundreds it could before.
  - A form over 256 KB gets a page saying so. The realistic way to hit it is a
    single huge env value, such as a full CA bundle (Mozilla's is ~220 KB of
    PEM, larger once the form encodes it). Split variables across the project,
    environment and resource levels, or bake the file into the image instead.
  - A GitHub push whose webhook payload is over 1 MB is refused before musdash
    sees it, so that push does not auto-deploy and musdash logs nothing; GitHub
    shows it as a failed delivery in the App's **Recent Deliveries**. The
    realistic causes are the first push of a long-lived branch (GitHub includes
    up to 2048 commits) or one commit touching thousands of files. Press
    **Deploy** to deploy it by hand.

---

## Configuration reference

Read once at startup by [src/config.ts](../src/config.ts) and frozen. Changing
any of these requires a restart.

| Variable                     | Default                | Notes                                                                 |
| ---------------------------- | ---------------------- | --------------------------------------------------------------------- |
| `MUSDASH_PORT`               | `8000`                 | Binds `0.0.0.0`; public peers get a 403 (D31), the firewall is extra  |
| `MUSDASH_DATA_DIR`           | `./data`               | SQLite, `secret.key` (0600), logs, build cache                        |
| `MUSDASH_DOCKER_SOCKET`      | `/var/run/docker.sock` | Must be a real unix socket                                            |
| `MUSDASH_DASHBOARD_HOST`     | —                      | Fallback only — the Settings page wins once a hostname is saved there |
| `MUSDASH_WILDCARD_DOMAIN`    | —                      | e.g. `mus.example.com`; needed for auto-domains                       |
| `MUSDASH_ACME_EMAIL`         | —                      | Required for automatic HTTPS                                          |
| `MUSDASH_PUBLIC_URL`         | derived from the host  | Fallback only; for a tunnel or private-network LB fronting musdash    |
| `MUSDASH_ACME_STAGING`       | `true`                 | Safe default — set `false` deliberately, on real DNS                  |
| `MUSDASH_BUILD_CACHE_GB`     | `10`                   | Layer cache ceiling, on disk and in the build daemon                  |
| `MUSDASH_BUILDKIT_MEMORY_MB` | sized from host memory | BuildKit memory cap; ≥ 192, below the host's memory (D33)             |
| `MUSDASH_RAILPACK_BIN`       | `railpack`             | Shelled out to, not linked                                            |
| `MUSDASH_BUILDCTL_BIN`       | `buildctl`             | Shelled out to, not linked                                            |
| `MUSDASH_NETWORK`            | `musdash`              | Must be user-defined                                                  |
| `MUSDASH_DEFAULT_MEMORY_MB`  | `512`                  | Per-container hard limit; there is no "unlimited"                     |
| `MUSDASH_HEALTH_TIMEOUT_SEC` | `60`                   | How long a new container has to pass the gate                         |
| `MUSDASH_LOG_LEVEL`          | `info`                 | `trace`…`fatal`                                                       |
| `NODE_ENV`                   | —                      | `production` enables the loopback bind                                |

---

## Operating it

```bash
# service
sudo systemctl status musdash
sudo systemctl restart musdash
sudo journalctl -u musdash -f

# what musdash manages — every managed container carries musdash.* labels
docker ps --filter label=musdash.role          # sidecars: caddy, buildkit
docker ps --filter label=musdash.resource      # your apps

# state
ls -l /opt/musdash/data/                       # musdash.db, secret.key, logs/, builds/
docker volume ls | grep musdash
```

### Back this up

- `/opt/musdash/data/musdash.db` — everything: projects, resources, deployments.
- `/opt/musdash/data/secret.key` — **without it, every encrypted env var is
  unrecoverable.** Mode 0600. Back it up separately from the database.
- `musdash-caddy-data` volume — your issued certificates.

### Disk you should expect

The layer cache is what makes a redeploy fast rather than cold, and it is the
component most likely to fill a small box. It lives in two places, both bounded
by `MUSDASH_BUILD_CACHE_GB`:

- `data/build-cache/<resource>/` — one directory per resource, written by
  Dockerfile builds.
- The `musdash-buildkit-cache` volume — the build daemon's own cache, which is
  where zero-config (Railpack) builds cache.

Once a day musdash removes any cache whose resource no longer exists. If the
total is then over the cap it evicts least-recently-built first until it is at
80% of the cap; under the cap it evicts nothing. Stopping at exactly the cap
would trip again on the very next build, so each pass leaves headroom. Deleting
a resource takes its cache with it immediately, not on the next sweep.

```bash
du -sh /opt/musdash/data/build-cache/*            # per-resource cache
docker system df -v | grep musdash-buildkit-cache # the daemon's own cache
sudo journalctl -u musdash | grep "pruned the build cache"
```

Setting the cap below what a single application's cache needs makes **every**
deploy for it build cold. That case is logged rather than left to be
reverse-engineered:

```
one build cache exceeds the whole cap; every deploy for it will build cold
```

Build directories (`data/builds/`) are separate and short-lived: each is deleted
when its build ends, with a daily sweep for anything a crash left behind.

### Memory you should expect

| Component             | Idle RSS              |
| --------------------- | --------------------- |
| musdash control plane | ~50–80 MB (gate: 100) |
| Caddy sidecar         | ~50–70 MB             |
| BuildKit sidecar      | ~66 MB                |
| Each app container    | capped at 512 MB      |

BuildKit idles at ~66 MB and may grow during a build up to a cap sized from the
host's memory — 384 MiB on a 1GB host, about 1 GiB on 2GB, at most 8 GiB (D33).
A build step that exceeds it is killed inside BuildKit's container instead of
starving the host; `MUSDASH_BUILDKIT_MEMORY_MB` overrides it.

Caddy's cap is sized the same way: a quarter of the host's memory, at least
128 MiB and at most 512 MiB (D46) — 128 MiB on a 512MB host, 224 MiB on 1GB.
If the proxy ever outgrows it, the kernel kills Caddy inside its own
container and Docker restarts it, rather than letting it starve the whole host.

On the 1 GB test host the whole idle stack — the OS, dockerd and containerd
(~216 MB), musdash 63, Caddy 67, BuildKit 66 and two small apps — left about
520 MB available. On a host with swap, read musdash's `VmSwap` next to its RSS
(`grep -E 'VmRSS|VmSwap' /proc/$(pidof musdash)/status`): pages the kernel has
swapped out do not count as RSS, so RSS alone can read lower than the process
really is.

Verify the control plane yourself with `bun run gate:rss`. It boots a separate
copy on its own port and temporary data directory, with no Docker socket, so
it is safe beside the live service; it reads about 10 MB below the live
figure above (52.9 MB on the same host), because the live process also talks
to Docker and has served sign-ins and deploys. `--with-docker` is for CI and
refuses to run where musdash containers exist.

---

## Troubleshooting

**`fetch` cannot reach the Docker socket / ENOENT `/var/run/docker.sock`**
You are on Docker Desktop's named pipe, or the daemon is not running inside the
distro. Run Docker Engine inside WSL and check `ls -l /var/run/docker.sock`.

**SQLite locking errors, intermittently**
You are running from `/mnt/c` or `/mnt/d`. Move the checkout to the WSL
filesystem (`~/musdash`).

**Deploys queue but nothing happens**
Job concurrency is exactly 1 by design — deploys spike memory, so serializing
them is what keeps the RAM budget. A stuck job blocks the rest. Check the log
for the job that never finished.

**Caddy will not start, or port 80/443 is in use**
Something else holds the port — often a stale `musdash-caddy` from a previous
run, or a system nginx. `docker ps -a --filter name=musdash-caddy` and
`sudo ss -tlnp | grep -E ':(80|443)'`.

**Caddy was recreated after an upgrade**
Expected, once. A proxy created before D29 had its admin API on a TCP port that
every app container could reach, and it cannot be fixed in place, so musdash
replaces it: certificates are kept on their volume, routes are rebuilt from the
database, and sites are down for a few seconds. The old config file stays on
the `musdash-caddy-config` volume under `caddy/autosave.json`.

The replacement is tried first as a throwaway `musdash-caddy-preflight`
container. If that fails, the old proxy is left serving and the bootstrap's
error says why, including the preflight's last log lines. The build daemon is
also replaced once after an upgrade (D32), keeping its cache volume, but with no
preflight: no traffic flows through it, so nothing is down while it restarts.

The proxy is also replaced, the same way, when its memory cap no longer
matches the host's memory: once on the upgrade that introduced the sized cap
(D46), and again after the host is resized. The warning names which check
failed.

**Caddy logs "admin endpoint on open interface; host checking disabled"**
Expected on every start, and not a hole. Caddy prints it for any admin endpoint
that is not a loopback TCP address, and a unix socket is not one: host checking
only means something for TCP. The line names the socket
(`unix//run/musdash-caddy/admin.sock|0222`). To confirm nothing listens on TCP,
`sudo ss -tlnp | grep -E ':(2019|1234)'` should print nothing.

**A deploy log says the kernel is older than Linux 5.14**
The zero-downtime switch relies on `net.ipv4.tcp_migrate_req` (D30), which
arrived in Linux 5.14. Older kernels (Ubuntu 20.04's GA kernel, Debian 11) run
the proxy without it, and a request that arrives at the instant of a route
switch can fail. Upgrade the kernel (Ubuntu's HWE kernel is enough), then
`docker rm -f musdash-caddy` so musdash recreates the proxy with the setting.

**Certificates fail to issue**
Check that `MUSDASH_ACME_STAGING=false`, that the A record resolves, and that 80
and 443 are open. Staging certificates are untrusted by browsers on purpose —
that is the default working as intended.

The issuer Caddy actually uses is persisted on its config volume and was written
on the first boot ever, so a box bootstrapped on staging kept using it no matter
what the env said. Saving the dashboard address now reconciles that (D28). To
check which one is in force:

```bash
sudo curl -s --unix-socket /opt/musdash/data/caddy/admin.sock http://127.0.0.1/config/apps/tls | grep -o "acme-staging[^\"]*"
```

**Builds fail with ENOENT on `railpack` or `buildctl`**
Neither is on `PATH`. Install them (step A5), or point
`MUSDASH_RAILPACK_BIN` / `MUSDASH_BUILDCTL_BIN` at their real locations.

**A container disappeared and came back**
That is the reconciler, working. It heals drift within 30 seconds.

**The dashboard is unreachable through Caddy, but works on port 8000**
The proxy cannot reach the host. Almost always the firewall dropping traffic
from the Docker bridge — see B5. Confirm with
`docker exec musdash-caddy wget -qO- --timeout=3 http://musdash-host:8000/health`:
a hang means DROP (firewall), "connection refused" means nothing is listening.
The Settings page reports this too, after any save.
