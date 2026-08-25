import { caddy, CaddyError } from "./client.ts"
import { config } from "../config.ts"
import {
  type ContainerState,
  DockerError,
  sidecarLabels,
} from "../docker/client.ts"
import { docker } from "../docker/impl.ts"
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

  // Discovery is BY NAME, not by label. A container created by an older
  // install.sh carries no musdash labels at all and is invisible to a
  // managed=true filter, so a label-based lookup would conclude nothing is
  // there and try to create a second proxy on the same ports.
  const existing = (await docker.findContainersByName(CADDY_CONTAINER))[0]
  const adopted = existing !== undefined

  let id: string
  if (existing) {
    // Adopt as-is: no recreate, no relabel, no remove. The operator's running
    // proxy is holding live TLS connections, and musdash has no business
    // destroying it just because it did not create it.
    id = existing.id
  } else {
    // The proxy image is almost never already on a fresh box, and
    // createContainer answers a missing image with a bare 404. Pull first, but
    // tolerate a pull failure when the image is already local, so a firewalled
    // server with a cached image still comes up.
    if (!(await docker.imageExists(CADDY_IMAGE))) {
      logger.info({ image: CADDY_IMAGE }, "caddy: pulling the proxy image")
      const pullDeadline = Date.now() + PULL_TIMEOUT_MS
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
    }

    id = await docker.createContainer({
      name: CADDY_CONTAINER,
      image: CADDY_IMAGE,
      env: {
        // Without this Caddy binds its admin API to localhost INSIDE the
        // container, and the loopback port mapping below forwards to a
        // listener that refuses it. Verified against a real daemon: connection
        // refused without it, 200 with it (DECISIONS D2 amendment).
        CADDY_ADMIN: "0.0.0.0:2019",
      },
      labels: sidecarLabels("proxy"),
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
        // The admin API can replace the entire configuration, unauthenticated.
        // It binds loopback on the Docker host and is never published further.
        {
          containerPort: 2019,
          hostPort: 2019,
          protocol: "tcp",
          hostIp: "127.0.0.1",
        },
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

  logger.info(
    { container: CADDY_CONTAINER, id, adopted },
    adopted ? "adopted the existing Caddy container" : "started Caddy",
  )
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
 * The adopted case keeps its specific guidance — every container the old
 * install.sh created lacks CADDY_ADMIN, so its admin API is bound inside the
 * container and the loopback mapping reaches nothing — but it is now one cause
 * among several rather than the only one asserted. Say what to do; do not act.
 * Tearing down an operator's live proxy unasked is worse than failing loudly.
 */
function notReadyError(adopted: boolean, lastReason: string): CaddyError {
  const base = `${CADDY_CONTAINER} did not become ready within ${READY_TIMEOUT_SEC}s (${lastReason}).`
  if (adopted) {
    return new CaddyError(
      `${base} The container was adopted, not created by musdash. The most common cause is that it was ` +
        "created without CADDY_ADMIN=0.0.0.0:2019, which leaves the admin API bound inside the container " +
        "where the loopback port mapping cannot reach it. Recreate it: " +
        `'docker rm -f ${CADDY_CONTAINER}' and musdash will start a correctly configured one.`,
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
 * 2. THE ADMIN API ANSWERS. Necessary, but on its own it is not evidence about
 *    THIS container: 127.0.0.1:2019 is a host port, and a stale Caddy or a
 *    host-installed caddy service answers 200 there while the container just
 *    started is dead. Gate 1 is what makes gate 2 mean anything.
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
    // not answer" and gets blamed on CADDY_ADMIN — the wrong fix entirely.
    if (state?.running === true && state.publishedPortCount === 0) {
      throw new CaddyError(
        `the ${CADDY_CONTAINER} container is running but none of its published ports are mapped to the host. ` +
          "The Engine leaves a mapping unprogrammed when the host port is already taken, so the proxy is " +
          "unreachable even though the container is up. Check what holds :80, :443 and :2019 " +
          `('ss -ltnp | grep -E ":(80|443|2019) "'), free them, then 'docker rm -f ${CADDY_CONTAINER}'.`,
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
