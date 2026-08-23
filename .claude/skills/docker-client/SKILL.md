---
name: docker-client
description: >
  Building or changing anything in src/docker/ — the DockerClient interface, log
  stream demultiplexing, container specs, labels, or memory limits. Load before
  writing the demultiplexer, which is the single most bug-prone code in mosdash.
  Triggers on "docker client", "streamLogs", "demux", "container spec",
  "mosdash labels", "attach to logs", "pull image".
---

# The Docker client

## The interface is the boundary

All Docker access goes through `DockerClient` in `src/docker/client.ts`. Nothing
else imports a Docker library or fetches the socket. Read-only `inspect` for
rendering status is the only call a route handler may make; every mutation is a
queued job.

**Keep the interface free of local-socket assumptions.** Remote servers are later
added as another implementation behind it, tunnelling the socket over SSH, and
nothing above the interface changes. That is the entire reason it exists.

## Implementation: prefer raw `fetch`

Bun supports `fetch(url, { unix: "/var/run/docker.sock" })` natively. A spike
decides `dockerode` vs raw fetch, and **if both work, prefer raw fetch** — the
Engine API is plain HTTP + JSON, the client is ~200 lines, and it drops a
dependency plus a Bun-compatibility risk for the life of the project.

The real test in that spike is attaching to a log stream: `dockerode` relies on
Node stream internals Bun may not fully implement. Record the outcome in
`docs/DECISIONS.md` under "Docker access".

## Log demultiplexing — the trap

With TTY disabled (which it must be), Docker frames each chunk:

```
byte 0     : stream type — 0 stdin, 1 stdout, 2 stderr
bytes 1-3  : zero padding
bytes 4-7  : payload length, big-endian uint32
bytes 8..n : payload
```

**Frames split across network chunks.** This is named in `DECISIONS.md` as the
single most common bug in this layer, and it costs a day when missed.

The rule: keep a persistent buffer across chunks. On each chunk, append, then
loop — while the buffer holds at least 8 bytes, read the declared length; if the
buffer does not yet hold `8 + length`, **stop and wait for more data**; otherwise
slice one frame, emit it, and continue. Never assume one chunk is one frame, and
never assume a header arrives intact — an 8-byte header can itself be split.

Write the comment explaining this. `CLAUDE.md` names the demultiplexer as one of
two places that warrant a real one.

### Test it properly

This is one of only four things in mosdash with `bun test` coverage. The cases
that matter are the ones that break naive implementations: a split mid-header, a
split mid-payload, multiple frames in one chunk, a zero-length payload, and a
payload containing bytes that look like a header.

## Container specs

Two fields are non-negotiable on every container mosdash creates.

**A hard memory limit** — `HostConfig.Memory`, default 512MB. A leaking user app
must never take down the box or the dashboard. There is no "unlimited" option in
the UI.

**The labels** — the reconciler identifies live containers and orphans by them:

```
mosdash.managed        = "true"
mosdash.resource_id    = <resource id>
mosdash.deployment_id  = <deployment id>
mosdash.project_id     = <project id>
```

Containers are named `mosdash-<resourceId>-<short deploymentId>` and join the
user-defined `mosdash` network — **container-name DNS does not work on the
default bridge**, and Caddy resolves upstreams by name.

## Security

The Docker socket is root-equivalent on the host. Any path that can influence a
container spec is a privilege boundary.

- Validate image references against a registry-reference regex before use. An
  unvalidated image string is a command injection vector if it reaches a shell.
- Resource names must match `^[a-z0-9-]{1,32}$` — they become container names and
  DNS labels.
- When shelling out, **pass argument arrays to `Bun.spawn`, never an interpolated
  string.** Structural immunity beats regex-dependence.
