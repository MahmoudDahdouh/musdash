# musdash

A self-hosted PaaS for a single VPS. Point it at your server and it deploys your
apps in Docker containers, each reachable at an HTTPS URL.

> **Your $5 VPS runs your apps, not your dashboard.**

## The number

|                           | Idle RSS        |
| ------------------------- | --------------- |
| **musdash control plane** | **50.7 MB**     |
| Coolify control plane     | 750 MB – 1.2 GB |

Measured on Ubuntu 24.04 (kernel 5.15, x86_64) with Bun 1.4.0: compiled with
`bun build --compile --minify`, booted, idled 60 seconds, RSS read from
`/proc`. Reproduce it yourself with `bun run gate:rss` — the build fails if the
number exceeds 100 MB.

**Sidecars are extra and reported honestly**, because you will actually be
running them: Caddy adds roughly 50 MB. Every app container you deploy has its
own hard memory limit (512 MB by default) and is counted separately. No number
here excludes something you will be running.

musdash is one process holding a SQLite file. There is no PostgreSQL, no Redis,
no queue worker daemon, and no WebSocket server, because each of those is a
process that costs memory before it does anything useful.

## What it does today

- **Projects → environments → resources.** A project gets a `production`
  environment automatically.
- **Deploy any public Docker image** — `nginx:alpine`, `ghcr.io/you/app:v1.2`.
- **Environment variables encrypted at rest** (AES-256-GCM). Decrypted values
  never reach a log line, including on error paths.
- **Zero-downtime deploys.** The old container keeps serving until the new one
  passes its health gate _and_ the route has switched. Verified by a request
  loop across a redeploy showing zero failures.
- **One-click rollback** to the previous image.
- **Live logs over SSE**, with auto-scroll that pauses when you scroll up.
- **Automatic HTTPS** at `<resource>-<environment>.<your-wildcard-domain>`,
  plus custom domains.
- **A reconciler** that restarts anything that disappears, so a reboot or a
  stray `docker rm -f` heals itself within 30 seconds.
- **Automatic image pruning**, because disk fills before RAM does.

## Install

On a fresh Ubuntu host:

```bash
bun run build
sudo ./scripts/install.sh
```

Then open `http://<server-ip>:8000` and create your admin account. Once an admin
exists, musdash binds to `127.0.0.1` and is reached through Caddy.

To get automatic HTTPS subdomains, point a wildcard A record
(`*.mus.example.com`) at the host and set `MUSDASH_WILDCARD_DOMAIN` and
`MUSDASH_ACME_EMAIL` in `/opt/musdash/musdash.env`.

## Configuration

| Variable                     | Default                 | Notes                                        |
| ---------------------------- | ----------------------- | -------------------------------------------- |
| `MUSDASH_PORT`               | `8000`                  | Binds `127.0.0.1` once an admin exists       |
| `MUSDASH_DATA_DIR`           | `./data`                | SQLite, logs, secret key                     |
| `MUSDASH_DOCKER_SOCKET`      | `/var/run/docker.sock`  |                                              |
| `MUSDASH_WILDCARD_DOMAIN`    | —                       | e.g. `mus.example.com`                       |
| `MUSDASH_ACME_EMAIL`         | —                       | Required for automatic HTTPS                 |
| `MUSDASH_ACME_STAGING`       | `true`                  | Safe default; set `false` in production      |
| `MUSDASH_CADDY_ADMIN`        | `http://127.0.0.1:2019` | Never exposed beyond loopback                |
| `MUSDASH_NETWORK`            | `musdash`               | Must be a user-defined network               |
| `MUSDASH_DEFAULT_MEMORY_MB`  | `512`                   | Per-container limit; there is no "unlimited" |
| `MUSDASH_HEALTH_TIMEOUT_SEC` | `60`                    |                                              |
| `MUSDASH_LOG_LEVEL`          | `info`                  |                                              |

## Development

```bash
bun install
bun run dev        # watch mode on port 8000
bun test           # the four things worth testing
bun run check      # format, lint, typecheck
bun run gate:rss   # build, boot, idle 60s, fail above 100MB
```

Docker access needs a real unix socket, so development happens on Linux — a
WSL2 Ubuntu distro with Docker Engine installed inside it works well. Docker
Desktop on Windows exposes a named pipe, which Bun's `fetch({ unix })` cannot
reach.

## Stack

Bun · Elysia · `bun:sqlite` + Drizzle · Eta · Alpine.js (vendored) · handwritten
CSS · Caddy. No build step for the frontend, no CDN, no native modules.

Docker is reached over the unix socket with plain `fetch` — no client library.
See [docs/DECISIONS.md](docs/DECISIONS.md) for why, and for every other
architectural decision.

## Scope

Phase 1 covers deploying public Docker images. GitHub builds, Docker Compose,
one-click templates, managed databases, and multi-server support are planned —
see [docs/PHASES.md](docs/PHASES.md).

Permanently out of scope: Kubernetes, a plugin system, multi-tenancy, SSO, and a
third-party REST API. Self-hosted software has one user.
