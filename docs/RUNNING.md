# Running mosdash

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
- Two managed sidecars, started and self-healed by mosdash itself: **Caddy**
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

```bash
curl -fsSL https://bun.sh/install | bash
exec $SHELL -l
bun --version
```

### A4. Get the code onto the Linux filesystem

**Do not run from `/mnt/d/coding/mosdash`.** SQLite over the `9p` mount that
backs `/mnt/*` takes locks that fail intermittently — this cost real debugging
time already. Clone into the WSL filesystem instead:

```bash
git clone <your-remote> ~/mosdash     # or: cp -r /mnt/d/coding/mosdash ~/mosdash
cd ~/mosdash
bun install
```

Edit on Windows in `\\wsl$\Ubuntu-24.04\home\<you>\mosdash` if you like, but
**run** from `~/mosdash`.

### A5. Install the build tools (only for git-repo deploys)

Skip this if you are only deploying pre-built Docker images.

```bash
# buildctl, copied out of the same BuildKit image mosdash runs — this keeps
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
docker network create mosdash
```

### A7. Write `.env`

```bash
cat > ~/mosdash/.env <<'EOF'
MOSDASH_PORT=8000
MOSDASH_DATA_DIR=./data
MOSDASH_DOCKER_SOCKET=/var/run/docker.sock
MOSDASH_NETWORK=mosdash
MOSDASH_CADDY_ADMIN=http://127.0.0.1:2019
MOSDASH_ACME_STAGING=true
MOSDASH_DEFAULT_MEMORY_MB=512
MOSDASH_HEALTH_TIMEOUT_SEC=60
MOSDASH_LOG_LEVEL=debug
EOF
```

Bun loads `.env` automatically. Leave `MOSDASH_WILDCARD_DOMAIN` unset locally —
you have no public DNS, so there is nothing for ACME to validate. Resources will
still deploy and be reachable by container port; they just get no auto-domain.

`NODE_ENV` is deliberately absent: outside production the server binds
`0.0.0.0`, so you can reach it from Windows.

### A8. Run it

```bash
cd ~/mosdash
bun run dev
```

Watch for `mosdash listening` in the log. Then, on startup, mosdash enqueues the
two sidecar bootstraps — first boot pulls `caddy:2-alpine` and
`moby/buildkit:v0.27.0`, which takes a minute or two. Watch it:

```bash
docker ps --filter label=mosdash.role
```

You should end up with `mosdash-caddy` and `mosdash-buildkit` running.

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

The target is a fresh Ubuntu 22.04/24.04 host with root access. 1 GB RAM is
enough for the control plane plus Caddy; give it 2 GB if you intend to build
from source, because BuildKit and image extraction spike.

### B1. Point DNS at the host

Before installing, create two records at your DNS provider:

| Type | Name                | Value          |
| ---- | ------------------- | -------------- |
| A    | `mos.example.com`   | your server IP |
| A    | `*.mos.example.com` | your server IP |

The wildcard is what gives every resource an automatic HTTPS subdomain at
`<resource>-<environment>.mos.example.com`. Wait for it to resolve
(`dig +short foo.mos.example.com`) before turning off ACME staging — a failed
issuance burns rate limit.

### B2. Build the binary

The installer expects `./dist/mosdash`. Build it on a **Linux x86_64** machine —
your WSL distro is fine; a Windows build produces a `.exe` the VPS cannot run.

```bash
cd ~/mosdash
bun run build          # bun build --compile --minify --sourcemap
```

### B3. Copy the repo to the server

The installer reads `./dist/mosdash` relative to where it runs, so copy both the
script and the binary:

```bash
rsync -av --exclude node_modules --exclude data ~/mosdash/ root@<server-ip>:/root/mosdash/
```

### B4. Run the installer

```bash
ssh root@<server-ip>
cd /root/mosdash
sudo ./scripts/install.sh
```

It does all of this, idempotently:

1. Installs Docker if absent.
2. Installs `buildctl` (copied out of `moby/buildkit:v0.27.0`) and
   `railpack v0.37.0`.
3. Creates the `mosdash` system user, adds it to the `docker` group, and creates
   `/opt/mosdash` + `/opt/mosdash/data`.
4. Creates the `mosdash` Docker network.
5. Creates the `mosdash-caddy-data` and `mosdash-caddy-config` volumes. **These
   hold your certificates — never delete them**, or you re-issue everything and
   burn the Let's Encrypt rate limit.
6. Installs the binary to `/opt/mosdash/mosdash`.
7. Writes `/opt/mosdash/mosdash.env` (mode 0600) if it does not exist.
8. Installs and starts the `mosdash` systemd unit.

Caddy and BuildKit containers are **not** created by the installer — mosdash
creates them on first boot, so there is exactly one code path that also
re-creates them if they are ever removed.

### B5. First login

The installer prints the URL. Because no admin account exists yet, mosdash binds
`0.0.0.0` so you are not locked out of the box you just installed:

```
http://<server-ip>:8000
```

Create your admin account. **The moment that account exists, the next restart
binds `127.0.0.1`** and the dashboard is only reachable through Caddy. Do this
step before locking the port down.

### B6. Configure domains and TLS

```bash
sudo nano /opt/mosdash/mosdash.env
```

Set:

```ini
MOSDASH_WILDCARD_DOMAIN=mos.example.com
MOSDASH_ACME_EMAIL=you@example.com
MOSDASH_ACME_STAGING=false      # only once DNS resolves — see B1
```

Then:

```bash
sudo systemctl restart mosdash
sudo journalctl -u mosdash -f
```

### B7. Lock down the firewall

Only 80 and 443 should be public. Caddy holds them; the Caddy admin API (2019)
and BuildKit (1234) are loopback-only by design and must never be exposed —
BuildKit's API is unauthenticated and runs arbitrary build steps.

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

### B8. Upgrading later

```bash
# on your build machine
bun run build
rsync -av dist/mosdash root@<server-ip>:/root/mosdash/dist/

# on the server
cd /root/mosdash && sudo ./scripts/install.sh   # idempotent; reinstalls the binary
```

Migrations run at startup. The env file is not overwritten if it already exists.

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

Private repos need the GitHub App connect flow, which is not built yet.

### Everything else

- **Env vars** — `KEY=value` text, encrypted at rest. Resolution is project →
  environment → resource, most specific winning.
- **Custom domains** — add one and Caddy issues a certificate on demand.
- **Rollback** — one click, back to the previous image. It reuses the existing
  image and never rebuilds.
- **Stop / restart / delete** — delete removes the container, the route, and the
  volumes.
- **Logs** — live over SSE, from an in-memory ring buffer (1000 lines per
  resource) plus rotated files under `data/logs/`. Logs are never written to
  SQLite.

---

## Configuration reference

Read once at startup by [src/config.ts](../src/config.ts) and frozen. Changing
any of these requires a restart.

| Variable                     | Default                 | Notes                                                  |
| ---------------------------- | ----------------------- | ------------------------------------------------------ |
| `MOSDASH_PORT`               | `8000`                  | Binds `127.0.0.1` in production once an admin exists   |
| `MOSDASH_DATA_DIR`           | `./data`                | SQLite, `secret.key` (0600), logs, build cache         |
| `MOSDASH_DOCKER_SOCKET`      | `/var/run/docker.sock`  | Must be a real unix socket                             |
| `MOSDASH_WILDCARD_DOMAIN`    | —                       | e.g. `mos.example.com`; needed for auto-domains        |
| `MOSDASH_ACME_EMAIL`         | —                       | Required for automatic HTTPS                           |
| `MOSDASH_PUBLIC_URL`         | —                       | Only for GitHub App registration; must be public HTTPS |
| `MOSDASH_ACME_STAGING`       | `true`                  | Safe default — set `false` deliberately, on real DNS   |
| `MOSDASH_CADDY_ADMIN`        | `http://127.0.0.1:2019` | Never published beyond loopback                        |
| `MOSDASH_BUILDKIT_ADDR`      | `tcp://127.0.0.1:1234`  | Unauthenticated API — loopback only                    |
| `MOSDASH_BUILD_CACHE_GB`     | `10`                    | Layer cache ceiling                                    |
| `MOSDASH_RAILPACK_BIN`       | `railpack`              | Shelled out to, not linked                             |
| `MOSDASH_BUILDCTL_BIN`       | `buildctl`              | Shelled out to, not linked                             |
| `MOSDASH_NETWORK`            | `mosdash`               | Must be user-defined                                   |
| `MOSDASH_DEFAULT_MEMORY_MB`  | `512`                   | Per-container hard limit; there is no "unlimited"      |
| `MOSDASH_HEALTH_TIMEOUT_SEC` | `60`                    | How long a new container has to pass the gate          |
| `MOSDASH_LOG_LEVEL`          | `info`                  | `trace`…`fatal`                                        |
| `NODE_ENV`                   | —                       | `production` enables the loopback bind                 |

---

## Operating it

```bash
# service
sudo systemctl status mosdash
sudo systemctl restart mosdash
sudo journalctl -u mosdash -f

# what mosdash manages — every managed container carries mosdash.* labels
docker ps --filter label=mosdash.role          # sidecars: caddy, buildkit
docker ps --filter label=mosdash.resource      # your apps

# state
ls -l /opt/mosdash/data/                       # mosdash.db, secret.key, logs/, builds/
docker volume ls | grep mosdash
```

### Back this up

- `/opt/mosdash/data/mosdash.db` — everything: projects, resources, deployments.
- `/opt/mosdash/data/secret.key` — **without it, every encrypted env var is
  unrecoverable.** Mode 0600. Back it up separately from the database.
- `mosdash-caddy-data` volume — your issued certificates.

### Memory you should expect

| Component             | Idle RSS              |
| --------------------- | --------------------- |
| mosdash control plane | ~50–80 MB (gate: 100) |
| Caddy sidecar         | ~50 MB                |
| BuildKit sidecar      | ~11–30 MB             |
| Each app container    | capped at 512 MB      |

Verify the control plane yourself with `bun run gate:rss`.

---

## Troubleshooting

**`fetch` cannot reach the Docker socket / ENOENT `/var/run/docker.sock`**
You are on Docker Desktop's named pipe, or the daemon is not running inside the
distro. Run Docker Engine inside WSL and check `ls -l /var/run/docker.sock`.

**SQLite locking errors, intermittently**
You are running from `/mnt/c` or `/mnt/d`. Move the checkout to the WSL
filesystem (`~/mosdash`).

**Deploys queue but nothing happens**
Job concurrency is exactly 1 by design — deploys spike memory, so serializing
them is what keeps the RAM budget. A stuck job blocks the rest. Check the log
for the job that never finished.

**Caddy will not start, or port 80/443/2019 is in use**
Something else holds the port — often a stale `mosdash-caddy` from a previous
run, or a system nginx. `docker ps -a --filter name=mosdash-caddy` and
`sudo ss -tlnp | grep -E ':(80|443|2019)'`.

**Certificates fail to issue**
Check that `MOSDASH_ACME_STAGING=false`, that the wildcard A record resolves,
that 80 and 443 are open, and that `MOSDASH_ACME_EMAIL` is set. Staging
certificates are untrusted by browsers on purpose — that is the default working
as intended.

**Builds fail with ENOENT on `railpack` or `buildctl`**
Neither is on `PATH`. Install them (step A5), or point
`MOSDASH_RAILPACK_BIN` / `MOSDASH_BUILDCTL_BIN` at their real locations.

**A container disappeared and came back**
That is the reconciler, working. It heals drift within 30 seconds.

**Locked out after creating the admin account**
Expected — production binds `127.0.0.1` once an admin exists. Reach it through
Caddy at your domain, or tunnel: `ssh -L 8000:127.0.0.1:8000 root@<server-ip>`.
