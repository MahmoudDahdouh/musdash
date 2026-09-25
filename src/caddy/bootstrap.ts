import { chmodSync, existsSync, mkdirSync } from "node:fs"
import {
  ADMIN_LISTEN,
  ADMIN_SOCKET_DIR_IN_CONTAINER,
  caddy,
  CaddyError,
  ensureDashboardRoutes,
} from "./client.ts"
import { config, HOST_ALIAS } from "../config.ts"
import {
  type ContainerState,
  DockerError,
  sidecarLabels,
} from "../docker/client.ts"
import { docker } from "../docker/impl.ts"
import { probeDashboardReachable } from "../jobs/dashboard.ts"
import { syncResourceRoutes } from "../jobs/routes.ts"
import { getDashboardHost } from "../settings.ts"
import { logger } from "../log.ts"

/**
 * Brings the reverse proxy up and keeps it up.
 *
 * Every step is idempotent and re-enterable, because this runs on the queue at
 * every boot and again whenever the reconciler notices the proxy has gone. The
 * job it backs has maxAttempts 1: concurrency is exactly 1, and a bootstrap
 * that retries internally while Docker is down would occupy the single worker
 * that user deploys are waiting on. The reconciler re-enqueues it soon enough.
 */

export const CADDY_CONTAINER = "musdash-caddy"
const CADDY_IMAGE = "caddy:2-alpine"

/**
 * The volume names are load-bearing and must never change. `/data` holds the
 * certificate store; a new name means an empty store, re-issuance of every
 * certificate, and a burnt Let's Encrypt rate limit (50 per registered domain
 * per week). These are the same names scripts/install.sh has always used, so an
 * existing install keeps its certificates.
 */
const DATA_VOLUME = "musdash-caddy-data"
const CONFIG_VOLUME = "musdash-caddy-config"

/**
 * The proxy's cap is deliberately NOT config.defaultMemoryMb. That setting is
 * the default for user applications; lowering it to squeeze more apps onto a
 * small box must not also throttle the component every one of those apps is
 * served through.
 */
const CADDY_MEMORY_BYTES = 512 * 1024 * 1024

/**
 * Which generation of the container definition a proxy was created from.
 *
 * A proxy without this label, or with an older value, is REPLACED rather than
 * adopted. Generation 2 moved the admin API off `0.0.0.0:2019` — reachable from
 * every app on the `musdash` network — onto a unix socket (D29), and added the
 * tcp_migrate_req sysctl (D30). Neither can be changed on a running container,
 * and leaving the old one in place would leave every install that upgrades
 * exposed. Bump it only for a change that is worth a proxy restart.
 */
const SPEC_LABEL = "musdash.proxy_spec"
const SPEC_VERSION = "2"

/**
 * Where the proxy keeps its autosaved config, inside the config volume.
 *
 * Not the image's default `/config`: an autosave written by a generation-1
 * proxy there carries `admin.listen: 0.0.0.0:2019`, and `--resume` would put
 * the TCP listener straight back — the config's admin block beats CADDY_ADMIN.
 * A fresh path starts the replacement blank; ensureBaseConfig and
 * syncResourceRoutes rebuild everything musdash owns from the database, and the
 * old file stays on the volume, untouched, for anyone who hand-edited it.
 */
const CONFIG_HOME = "/config/musdash"

/**
 * Lets a closing listener hand its queued connections to its replacement.
 *
 * Every admin-API write is a full config reload, and Caddy rebinds :80/:443 on
 * each one with SO_REUSEPORT, then closes the old socket. Linux resets whatever
 * was still in the closing socket's accept queue — measured on a real VPS as
 * one failed request (a TLS connect error) at every route switch, which is the
 * zero-downtime guarantee failing (D30). With this set, the kernel migrates
 * those connections to the new socket instead. Namespaced to the proxy's own
 * network namespace, so nothing on the host changes.
 */
const MIGRATE_SYSCTL = "net.ipv4.tcp_migrate_req"

/** How long to wait for the admin API after starting the container. */
const READY_TIMEOUT_SEC = 30

/**
 * How long to wait for :80 to actually accept, once the config is installed.
 *
 * Deliberately shorter than READY_TIMEOUT_SEC: by the time this runs the
 * process is provably alive and configured, so a bind either happens promptly
 * or is not going to.
 */
const SERVING_TIMEOUT_SEC = 15

/** A first pull of caddy:2-alpine is ~15MB; ten minutes is generous. */
const PULL_TIMEOUT_MS = 10 * 60 * 1000

export async function ensureCaddy(): Promise<void> {
  await docker.ensureNetwork(config.network)
  await docker.createVolume(DATA_VOLUME)
  await docker.createVolume(CONFIG_VOLUME)
  prepareAdminDir()

  // Discovery is BY NAME, not by label. A container created by an older
  // install.sh carries no musdash labels at all and is invisible to a
  // managed=true filter, so a label-based lookup would conclude nothing is
  // there and try to create a second proxy on the same ports.
  let existing = (await docker.findContainersByName(CADDY_CONTAINER))[0]

  let id: string
  if (existing && existing.labels[SPEC_LABEL] === SPEC_VERSION) {
    // Adopt as-is: no recreate, no relabel. The running proxy is holding live
    // TLS connections and already has the current definition.
    id = existing.id
  } else {
    // Pulled on EVERY create, not only when absent: the tag floats, and a
    // cached copy can predate what this definition needs — the admin socket's
    // `|0222` mode suffix is Caddy 2.8+. Before removing an outdated proxy, so
    // the sites are down for a container start rather than for a download. A
    // failed pull is tolerated when a local copy exists, so a firewalled box
    // with a cached image still comes up.
    const hasLocal = await docker.imageExists(CADDY_IMAGE)
    logger.info({ image: CADDY_IMAGE }, "caddy: pulling the proxy image")
    const pullDeadline = Date.now() + PULL_TIMEOUT_MS
    try {
      await docker.pullImage(CADDY_IMAGE, () => {
        // The Engine streams progress lines, so a pull that has genuinely
        // stalled stops emitting them while a merely slow one keeps going.
        // Throwing from the callback aborts the stream read, which is the only
        // cancellation point pullImage exposes. Concurrency is exactly 1: an
        // indefinite pull here is an indefinite outage for every queued deploy.
        if (Date.now() > pullDeadline) {
          throw new DockerError(
            `pulling ${CADDY_IMAGE} exceeded ${PULL_TIMEOUT_MS / 60_000} minutes`,
          )
        }
      })
    } catch (err) {
      if (!hasLocal) throw err
      logger.warn(
        { image: CADDY_IMAGE, err: (err as Error).message },
        "caddy: pull failed; using the cached image",
      )
    }

    if (existing) {
      // An outdated proxy — including one an older install.sh created, which
      // has no labels at all. D7 said never to recreate an adopted proxy; that
      // held until the proxy itself was the hole. Its admin API answers every
      // app on the musdash network, unauthenticated, so any deployed app could
      // rewrite routing and capture the dashboard login (D29). Certificates
      // live on DATA_VOLUME, which is kept, so nothing is re-issued.
      // There is no fallback once it is gone: :80/:443 cannot be held by two
      // proxies, and recreating the old definition would reinstate the hole.
      // A replacement that then fails to come up is reported by the readiness
      // gates below and re-queued by the reconciler; the dashboard stays
      // reachable over an SSH tunnel to :8000 meanwhile (D31 admits loopback).
      logger.warn(
        { container: CADDY_CONTAINER, id: existing.id },
        "replacing the proxy container: its admin API was reachable from every app on the musdash network. " +
          "Certificates are kept; sites are briefly unavailable while it restarts",
      )
      await docker.removeContainer(existing.id, true)
      existing = undefined
    }

    const migrate = supportsListenerMigration()
    if (!migrate) {
      logger.warn(
        { sysctl: MIGRATE_SYSCTL },
        "this kernel cannot migrate queued connections between listeners (Linux 5.14+ can); " +
          "a route switch may drop a request that arrives at that instant",
      )
    }

    id = await docker.createContainer({
      name: CADDY_CONTAINER,
      image: CADDY_IMAGE,
      env: {
        // A unix socket in a bind-mounted directory only musdash's user can
        // enter — never a TCP port. See ADMIN_LISTEN and D29.
        CADDY_ADMIN: ADMIN_LISTEN,
        XDG_CONFIG_HOME: CONFIG_HOME,
      },
      labels: { ...sidecarLabels("proxy"), [SPEC_LABEL]: SPEC_VERSION },
      hostMounts: [
        {
          hostPath: config.caddyAdminDir,
          mountPath: ADMIN_SOCKET_DIR_IN_CONTAINER,
        },
      ],
      ...(migrate ? { sysctls: { [MIGRATE_SYSCTL]: "1" } } : {}),
      // Lets Caddy dial the dashboard, which binds the host's loopback rather
      // than living on this network (D2).
      extraHosts: [`${HOST_ALIAS}:${config.hostGatewayIp}`],
      networks: [config.network],
      volumes: [
        { name: DATA_VOLUME, mountPath: "/data" },
        { name: CONFIG_VOLUME, mountPath: "/config" },
      ],
      ports: [
        { containerPort: 80, hostPort: 80, protocol: "tcp", hostIp: "0.0.0.0" },
        {
          containerPort: 443,
          hostPort: 443,
          protocol: "tcp",
          hostIp: "0.0.0.0",
        },
        // HTTP/3.
        {
          containerPort: 443,
          hostPort: 443,
          protocol: "udp",
          hostIp: "0.0.0.0",
        },
        // No admin port. It used to be published on 127.0.0.1:2019, which
        // required a TCP listener on every interface INSIDE the container —
        // including the musdash network every user app is attached to (D29).
      ],
      memoryLimitBytes: CADDY_MEMORY_BYTES,
      restartPolicy: "unless-stopped",
      // `--resume` restores the persisted JSON config across restarts, so a
      // reboot comes back with every route intact. No `--config`: on a fresh
      // volume that file does not exist and Caddy exits rather than starting
      // empty, which crash-loops the proxy forever on a new install. With
      // `--resume` alone it starts blank the first time and ensureBaseConfig()
      // below installs srv0 through the admin API; every later start resumes
      // the autosave that the admin API writes.
      command: ["caddy", "run", "--resume"],
    })
  }

  const adopted = existing !== undefined
  await docker.startContainer(id)

  // A container musdash created moments ago has never restarted. Any nonzero
  // count means it started, died, and was restarted by the unless-stopped
  // policy — which for Caddy means a bind failure, and which the readiness
  // poll would otherwise paper over by catching it during an up-phase of the
  // loop. The adopted path deliberately skips this: an operator's proxy that
  // has been up for months across a reboot legitimately has restarts, so there
  // it falls to gate 1 and the serving probe instead.
  if (!adopted) {
    const initial = await docker.inspectContainer(id)
    if (!initial.running || initial.restartCount > 0) {
      throw new CaddyError(exitedMessage(initial))
    }
  }

  await waitForAdmin(id, adopted)
  await caddy.ensureBaseConfig()
  // Only now is there unambiguously an srv0 to be bound. See verifyServing.
  await verifyServing(id)
  // A replaced proxy starts from a blank config, and a reboot can hand a
  // container a new IP: either way the database is the source of truth. New
  // routes go in at the front, so this can run before or after the dashboard's.
  await syncResourceRoutes()
  // Re-appended every boot on purpose: the catch-all has to stay LAST, and any
  // resource route added since would otherwise sit behind it. See D20.
  await ensureDashboardRoutes(getDashboardHost())
  await caddy.ensureTlsAutomation()

  // Warn-only here, unlike in the apply job. This job has maxAttempts 1, and a
  // new hard failure mode in it would turn a working proxy into a failed
  // bootstrap on an unusual-but-valid firewall setup. The result is recorded
  // either way, so the Settings page can say what is wrong.
  await probeDashboardReachable()

  logger.info(
    { container: CADDY_CONTAINER, id, adopted },
    adopted ? "adopted the existing Caddy container" : "started Caddy",
  )
}

/**
 * Creates the directory the proxy puts its admin socket in, private to musdash.
 *
 * This directory IS the access control on the admin API (D29): the socket is
 * mode 0222 so musdash's user can connect, and 0700 here is what stops every
 * other user on the host from reaching it. chmod after mkdir because mkdir's
 * mode is filtered by the umask and ignored entirely when the path exists.
 */
function prepareAdminDir(): void {
  try {
    mkdirSync(config.caddyAdminDir, { recursive: true, mode: 0o700 })
    chmodSync(config.caddyAdminDir, 0o700)
  } catch (err) {
    throw new CaddyError(
      `cannot prepare ${config.caddyAdminDir} for the proxy's admin socket: ${(err as Error).message}. ` +
        "It must be a directory owned by the user musdash runs as.",
    )
  }
}

/**
 * Whether the kernel has tcp_migrate_req (Linux 5.14+).
 *
 * Read from this host's /proc, which assumes the daemon shares this kernel —
 * true for the local socket, which is the only place the proxy runs. The check
 * matters because runc fails the container START, not the create, on a sysctl
 * the kernel does not have: a proxy that never starts is far worse than one
 * that occasionally drops a request during a reload.
 */
function supportsListenerMigration(): boolean {
  return existsSync(`/proc/sys/${MIGRATE_SYSCTL.replaceAll(".", "/")}`)
}

/** Names the one cause an exited proxy almost always has, and how to see it. */
function exitedMessage(state: ContainerState): string {
  return (
    `the ${CADDY_CONTAINER} container is not running (exit code ${state.exitCode}, ` +
    `${state.restartCount} restarts). Caddy exits when it cannot bind :80 or :443 — check whether ` +
    `another process holds them ('ss -ltnp | grep -E ":(80|443) "') and see ` +
    `'docker logs ${CADDY_CONTAINER}'.`
  )
}

/**
 * The readiness timeout, naming which gate failed.
 *
 * The socket lives in a bind-mounted host directory, so the two causes worth
 * naming are that mount not carrying the socket out (a rootless or
 * user-namespaced daemon whose container root cannot write the directory) and
 * a proxy wedged mid-start. Say what to do; do not act — tearing down a live
 * proxy unasked is worse than failing loudly.
 */
function notReadyError(adopted: boolean, lastReason: string): CaddyError {
  const base =
    `${CADDY_CONTAINER} did not become ready within ${READY_TIMEOUT_SEC}s (${lastReason}). ` +
    `Its admin socket should appear at ${config.caddyAdminSocket}; see 'docker logs ${CADDY_CONTAINER}'.`
  if (adopted) {
    return new CaddyError(
      `${base} The container was already running; 'docker rm -f ${CADDY_CONTAINER}' makes musdash start a fresh one.`,
    )
  }
  return new CaddyError(base)
}

/**
 * Waits until the proxy is alive and its admin API answers.
 *
 * Two gates, and both are necessary:
 *
 * 1. THE CONTAINER IS RUNNING. Nothing here previously inspected the container
 *    it had just started. Caddy exits when it cannot bind :80 — another proxy,
 *    a host nginx, a stale Caddy — and with restart-policy unless-stopped the
 *    Engine puts it straight into a restart loop. startContainer reports
 *    success for both: a 204 says "start accepted", not "still alive". The only
 *    way to learn it died is to ask.
 *
 * 2. THE ADMIN API ANSWERS. Necessary, but on its own it is weaker evidence
 *    than it looks: a socket file can outlive the process that made it, and
 *    gate 1 is what ties the answer to the container just started.
 *
 * The third gate — that an HTTP server is actually bound — lives in
 * verifyServing(), after the base config exists. See there for why.
 */
async function waitForAdmin(id: string, adopted: boolean): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_SEC * 1000
  let lastReason = "the admin API did not answer"

  for (;;) {
    // Checked at the top, matching the deploy health gate: checking after the
    // probe means a full probe plus sleep runs past the deadline unnoticed.
    if (Date.now() > deadline) throw notReadyError(adopted, lastReason)

    // Gate 1 — the container musdash started, not whatever holds the host port.
    const state = await docker.inspectContainer(id).catch(() => null)
    if (state && !state.running) {
      // Fail now rather than burning the full 30s: an exited Caddy is not going
      // to start answering, and the exit code is the fact that explains it.
      throw new CaddyError(exitedMessage(state))
    }
    // Running, but with none of its published ports actually mapped. The
    // Engine does this when a host port is already held: it starts the
    // container and leaves the mapping unprogrammed, so Caddy is alive and
    // healthy inside while nothing on the host can reach it. Gate 1 passes and
    // gate 2 can never succeed, which without this reads as "the admin API did
    // not answer" and gets blamed on the admin socket — the wrong fix entirely.
    if (state?.running === true && state.publishedPortCount === 0) {
      throw new CaddyError(
        `the ${CADDY_CONTAINER} container is running but none of its published ports are mapped to the host. ` +
          "The Engine leaves a mapping unprogrammed when the host port is already taken, so the proxy is " +
          "unreachable even though the container is up. Check what holds :80 and :443 " +
          `('ss -ltnp | grep -E ":(80|443) "'), free them, then 'docker rm -f ${CADDY_CONTAINER}'.`,
      )
    }
    if (state && state.restartCount > 0) {
      lastReason = `the container has restarted ${state.restartCount} times`
    }

    // Gate 2 — only meaningful now that gate 1 has vouched for the container.
    if (state?.running === true && (await caddy.ping())) return

    await Bun.sleep(1000)
  }
}

/**
 * Confirms the proxy is actually accepting connections on :80.
 *
 * Runs AFTER ensureBaseConfig() on purpose. Before it, an empty config on a
 * fresh `--resume` volume is legitimate and indistinguishable from a failed
 * bind, so a listener check has no single correct answer. After it, srv0
 * unconditionally exists with listen [":80", ":443"], so it has exactly one.
 *
 * Caddy accepts a config whose listener cannot bind and reports the failure
 * only in its own logs — the admin API keeps answering 200 throughout. Without
 * this the job logs "started Caddy" while nothing is on port 80, which is the
 * false success this whole gate exists to remove.
 */
async function verifyServing(id: string): Promise<void> {
  const deadline = Date.now() + SERVING_TIMEOUT_SEC * 1000
  for (;;) {
    if (await probeHttpPort()) return
    if (Date.now() > deadline) {
      const state = await docker.inspectContainer(id).catch(() => null)
      throw new CaddyError(
        `Caddy's admin API is up but nothing is serving on :80 after ${SERVING_TIMEOUT_SEC}s ` +
          `(running=${state?.running ?? "unknown"}, restarts=${state?.restartCount ?? "unknown"}). ` +
          `Caddy logs a bind failure and keeps its admin API alive, so check ` +
          `'docker logs ${CADDY_CONTAINER}' and whether another process holds :80.`,
      )
    }
    await Bun.sleep(500)
  }
}

/**
 * A real connection to the published HTTP port.
 *
 * Deliberately NOT an admin-API question. The admin API can only report what
 * Caddy was ASKED to do; whether the kernel actually gave it :80 is a different
 * fact, and it is the one that decides whether a user's site loads. A request
 * with no matching route gets a 404 or an empty 200 — either proves a listener
 * accepted the connection, which is all this asks. Only a connection error is a
 * failure.
 *
 * `redirect: "manual"` matters: with automatic HTTPS on, Caddy answers :80 with
 * a 308 to https, and following it into a not-yet-issued certificate would
 * throw and read as a false negative.
 */
async function probeHttpPort(): Promise<boolean> {
  try {
    await fetch("http://127.0.0.1:80/", {
      signal: AbortSignal.timeout(2000),
      redirect: "manual",
    })
    return true
  } catch {
    return false
  }
}
