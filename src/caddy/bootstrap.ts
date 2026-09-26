import { chmodSync, mkdirSync, rmSync } from "node:fs"
import {
  ADMIN_LISTEN,
  ADMIN_SOCKET_DIR_IN_CONTAINER,
  caddy,
  CaddyClient,
  CaddyError,
  ensureDashboardRoutes,
} from "./client.ts"
import {
  MIGRATE_LABEL,
  MIGRATE_SYSCTL,
  supportsListenerMigration,
} from "./kernel.ts"
import { proxyMemoryCap } from "./memory.ts"
import { config, HOST_ALIAS } from "../config.ts"
import {
  type ContainerSpec,
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
 * The memory cap, in MiB, the proxy was created with.
 *
 * The cap is sized from the Docker host (src/caddy/memory.ts, D46) and fixed at
 * create time, and adoption never recreates — so without this label a proxy
 * created under the old fixed 512 MiB would be adopted forever, and a host
 * resized later would keep the cap sized for the old one.
 *
 * The cap is deliberately NOT config.defaultMemoryMb. That setting is the
 * default for user applications; lowering it to squeeze more apps onto a small
 * box must not also throttle the component every one of those apps is served
 * through.
 */
const MEMORY_LABEL = "musdash.proxy_memory_mb"

const MIB = 1024 * 1024

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

  // The DAEMON's memory, never this process's /proc: once the daemon is remote
  // they are different machines.
  const { memTotalBytes } = await docker.info()
  const memoryBytes = proxyMemoryCap(memTotalBytes)
  const memoryMb = memoryBytes / MIB
  const hostMemoryMb = Math.floor(memTotalBytes / MIB)

  // A current proxy that lacks the migration sysctl while the kernel now has it
  // — created before a kernel upgrade — is replaced too, through the same
  // preflight. Otherwise it would be adopted forever and every route switch
  // would keep the hole D30 closes. So is one whose cap no longer matches the
  // host: a cap larger than the host contains nothing (L-1).
  const canMigrate = supportsListenerMigration()
  const current =
    existing !== undefined &&
    existing.labels[SPEC_LABEL] === SPEC_VERSION &&
    (existing.labels[MIGRATE_LABEL] === "1" || !canMigrate) &&
    existing.labels[MEMORY_LABEL] === String(memoryMb)

  let id: string
  if (existing && current) {
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

    const migrate = canMigrate
    if (!migrate) {
      logger.warn(
        { sysctl: MIGRATE_SYSCTL },
        "this kernel cannot migrate queued connections between listeners (Linux 5.14+ can); " +
          "a route switch may drop a request that arrives at that instant",
      )
    }
    const spec = proxySpec(migrate, memoryBytes)

    if (existing) {
      // An outdated proxy — including one an older install.sh created, which
      // has no labels at all. D7 said never to recreate an adopted proxy; that
      // held until the proxy itself was the hole. Its admin API answers every
      // app on the musdash network, unauthenticated, so any deployed app could
      // rewrite routing and capture the dashboard login (D29). Certificates
      // live on DATA_VOLUME, which is kept, so nothing is re-issued.
      //
      // There is no fallback once it is gone: :80/:443 cannot be held by two
      // proxies, and recreating the old definition would reinstate the hole.
      // So the replacement is proven BEFORE the old proxy is touched: a
      // throwaway copy of the new definition, minus the ports and volumes, has
      // to be created, started, and answer on its admin socket. That exercises
      // everything the Engine or the kernel could reject — the image, the
      // sysctl, the bind mount, the socket's permissions — while the old proxy
      // keeps serving. A failure leaves it in place and says why (N-2).
      await preflight(spec)
      const oldMemory = existing.labels[MEMORY_LABEL]
      logger.warn(
        {
          container: CADDY_CONTAINER,
          id: existing.id,
          oldMemoryMb: oldMemory === undefined ? null : Number(oldMemory),
          newMemoryMb: memoryMb,
          hostMemoryMb,
        },
        `replacing the proxy container: ${staleReason(existing.labels, canMigrate)}. ` +
          "Certificates are kept; sites are briefly unavailable while it restarts",
      )
      await docker.removeContainer(existing.id, true)
      existing = undefined
    }

    // A socket file left by a proxy that died without cleaning up. Caddy
    // unlinks one before binding, but that is its behaviour to change, and the
    // directory is ours — so it is removed here too.
    rmSync(config.caddyAdminSocket, { force: true })
    id = await docker.createContainer(spec)
  }

  const adopted = existing !== undefined
  // Scoped to "never came up at all": start, the restart check, and the admin
  // socket. A failure after that — ensureBaseConfig, or verifyServing's probe
  // of :80, which can fail for reasons outside the proxy — leaves a live proxy
  // that the next bootstrap adopts and re-checks. Removing it there would turn
  // one false negative into an outage.
  try {
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
    if (adopted) {
      await waitForAdminOrRestart(id)
    } else {
      await waitForAdmin(id, adopted)
    }
  } catch (err) {
    // A container created in this run that never came up is removed rather
    // than left behind. It carries the current SPEC_LABEL, so the next
    // bootstrap would otherwise ADOPT the broken container forever instead of
    // creating a fresh one (N-2).
    if (!adopted)
      await removeQuietly(id, "the proxy container that failed to start")
    throw err
  }
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
    { container: CADDY_CONTAINER, id, adopted, memoryMb, hostMemoryMb },
    adopted ? "adopted the existing Caddy container" : "started Caddy",
  )
}

/**
 * Why a proxy that failed the adopt check is being replaced, for the one
 * warning an operator sees. First match wins, in the order the checks were
 * added; called only when at least one of them failed.
 */
function staleReason(
  labels: Record<string, string>,
  canMigrate: boolean,
): string {
  if (labels[SPEC_LABEL] !== SPEC_VERSION) {
    return "its admin API was reachable from every app on the musdash network"
  }
  if (canMigrate && labels[MIGRATE_LABEL] !== "1") {
    return "it was created without tcp_migrate_req, which this kernel now supports"
  }
  return "its memory cap was not sized for this host's memory"
}

/** The proxy's container definition. See SPEC_VERSION before changing it. */
function proxySpec(migrate: boolean, memoryBytes: number): ContainerSpec {
  return {
    name: CADDY_CONTAINER,
    image: CADDY_IMAGE,
    env: {
      // A unix socket in a bind-mounted directory only musdash's user can
      // enter — never a TCP port. See ADMIN_LISTEN and D29.
      CADDY_ADMIN: ADMIN_LISTEN,
      XDG_CONFIG_HOME: CONFIG_HOME,
    },
    labels: {
      ...sidecarLabels("proxy"),
      [SPEC_LABEL]: SPEC_VERSION,
      [MIGRATE_LABEL]: migrate ? "1" : "0",
      [MEMORY_LABEL]: String(memoryBytes / MIB),
    },
    hostMounts: [
      {
        hostPath: config.caddyAdminDir,
        mountPath: ADMIN_SOCKET_DIR_IN_CONTAINER,
      },
    ],
    ...(migrate ? { sysctls: { [MIGRATE_SYSCTL]: "1" } } : {}),
    // Lets Caddy dial the dashboard, which runs on the host rather than on
    // this network and binds every interface (D2, D23).
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
    memoryLimitBytes: memoryBytes,
    restartPolicy: "unless-stopped",
    // `--resume` restores the persisted JSON config across restarts, so a
    // reboot comes back with every route intact. No `--config`: on a fresh
    // volume that file does not exist and Caddy exits rather than starting
    // empty, which crash-loops the proxy forever on a new install. With
    // `--resume` alone it starts blank the first time and ensureBaseConfig()
    // installs srv0 through the admin API; every later start resumes the
    // autosave that the admin API writes.
    command: ["caddy", "run", "--resume"],
  }
}

const PREFLIGHT_CONTAINER = `${CADDY_CONTAINER}-preflight`

/** Bounded well under READY_TIMEOUT_SEC: a blank Caddy is up in about a second. */
const PREFLIGHT_TIMEOUT_SEC = 20

/**
 * Proves a proxy definition boots, without disturbing the running proxy.
 *
 * Creates a throwaway container from `spec` with everything that would clash
 * with the live proxy stripped — no published ports, no named volumes (two
 * Caddys must never share a certificate store), not on the musdash network, and
 * its own socket directory — then requires it to run and answer on its admin
 * socket. What remains is exactly what can reject a new definition: the image,
 * the sysctl, the bind mount and the socket's permissions. The only thing it
 * cannot prove is the :80/:443 bind, which the live proxy holds by definition.
 *
 * Always removes the throwaway container, pass or fail.
 */
async function preflight(spec: ContainerSpec): Promise<void> {
  const dir = `${config.caddyAdminDir}-preflight`

  let id: string | null = null
  try {
    prepareDir(dir)
    // Every preflight is force-removed, so its socket is always left behind.
    rmSync(`${dir}/admin.sock`, { force: true })
    for (const stale of await docker.findContainersByName(
      PREFLIGHT_CONTAINER,
    )) {
      await docker.removeContainer(stale.id, true)
    }
    id = await docker.createContainer({
      ...spec,
      name: PREFLIGHT_CONTAINER,
      labels: sidecarLabels("proxy-preflight"),
      hostMounts: [{ hostPath: dir, mountPath: ADMIN_SOCKET_DIR_IN_CONTAINER }],
      networks: [],
      volumes: [],
      ports: [],
      extraHosts: [],
      restartPolicy: "no",
      // Resumes nothing: the blank config is all a boot test needs.
      command: ["caddy", "run"],
    })
    await docker.startContainer(id)

    const probe = new CaddyClient(`${dir}/admin.sock`)
    const deadline = Date.now() + PREFLIGHT_TIMEOUT_SEC * 1000
    for (;;) {
      const state = await docker.inspectContainer(id)
      if (!state.running) {
        throw new CaddyError(`it exited with code ${state.exitCode}`)
      }
      if (await probe.ping()) return
      if (Date.now() > deadline) {
        throw new CaddyError(
          `its admin socket did not answer within ${PREFLIGHT_TIMEOUT_SEC}s`,
        )
      }
      await Bun.sleep(500)
    }
  } catch (err) {
    // The container is about to be removed, and its logs with it — and they
    // are the only record of WHY it failed. Keep the tail in the error.
    const tail = id ? await logTail(id) : ""
    throw new CaddyError(
      `the replacement proxy failed a preflight, so the current proxy was left in place and is still serving: ` +
        `${(err as Error).message}${tail ? `. Its last log lines: ${tail}` : ""}`,
    )
  } finally {
    if (id) await removeQuietly(id, PREFLIGHT_CONTAINER)
  }
}

/**
 * Removes a container on a cleanup path, where a second failure must not mask
 * the first — but is still logged, never swallowed: a preflight left running
 * is a container nobody else will ever remove.
 */
async function removeQuietly(id: string, what: string): Promise<void> {
  try {
    await docker.removeContainer(id, true)
  } catch (err) {
    logger.warn(
      { id, err: (err as Error).message },
      `could not remove ${what}; remove it by hand with 'docker rm -f ${id}'`,
    )
  }
}

/** The last few log lines of a container, joined, or "" if unreadable. */
async function logTail(id: string): Promise<string> {
  const lines: string[] = []
  try {
    for await (const line of docker.streamLogs(id, {
      follow: false,
      tail: 5,
    })) {
      lines.push(line.text.trim())
    }
  } catch {
    // Diagnostics only: a failure to read them must not mask the real error.
  }
  return lines.filter((l) => l !== "").join(" | ")
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
  prepareDir(config.caddyAdminDir)
}

function prepareDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
  } catch (err) {
    throw new CaddyError(
      `cannot prepare ${dir} for the proxy's admin socket: ${(err as Error).message}. ` +
        "It must be a directory owned by the user musdash runs as.",
    )
  }
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
 * waitForAdmin for an adopted proxy, restarting it once if it is wedged.
 *
 * Wedged means running, with its ports mapped, and still not answering on its
 * admin socket after READY_TIMEOUT_SEC. On the 512MB host a proxy looping
 * requests into itself sat at its memory cap for over 16 minutes: Caddy sets
 * GOMEMLIMIT just under the cap, so it collected garbage without end instead
 * of being OOM-killed, and every bootstrap the reconciler queued timed out on
 * the admin socket and changed nothing (L-7). Nothing else ever restarts a
 * proxy that is running. An admin API that has not answered for that long
 * cannot take a route change anyway, so a restart costs little that is not
 * already lost — and the reconciler's bucket bounds it to one per bootstrap.
 *
 * An exited proxy, or one whose ports the Engine could not map, gets
 * waitForAdmin's own precise error instead: restarting does not fix either.
 */
async function waitForAdminOrRestart(id: string): Promise<void> {
  try {
    await waitForAdmin(id, true)
    return
  } catch (err) {
    const state = await docker.inspectContainer(id).catch(() => null)
    const wedged = state?.running === true && state.publishedPortCount > 0
    if (!wedged) throw err
  }
  logger.warn(
    { container: CADDY_CONTAINER, id, waitedS: READY_TIMEOUT_SEC },
    "the proxy is running but its admin API has not answered; restarting it. Sites are briefly unavailable",
  )
  await docker.stopContainer(id, 10)
  await docker.startContainer(id)
  await waitForAdmin(id, true)
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
