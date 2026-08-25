import { config } from "../config.ts"
import {
  type ContainerState,
  DockerError,
  sidecarLabels,
} from "../docker/client.ts"
import { docker } from "../docker/impl.ts"
import { logger } from "../log.ts"

/**
 * Brings the build daemon up and keeps it up.
 *
 * Structurally this is the Caddy bootstrap (src/caddy/bootstrap.ts), gate for
 * gate, and deliberately so: that module's shape is the product of a slice
 * spent discovering what a readiness poll has to ask to avoid reporting false
 * success. The lessons transfer exactly, because the failure modes are the same
 * — a container that starts and immediately dies, a host port already held, an
 * API that answers from something other than the container just started.
 *
 * Idempotent and re-enterable: it runs on the queue at every boot and again
 * whenever the reconciler notices the daemon has gone. maxAttempts is 1 for the
 * same reason Caddy's is — concurrency is exactly 1, and a bootstrap retrying
 * internally while Docker is down occupies the single worker that user deploys
 * are queued behind.
 */

export const BUILDKIT_CONTAINER = "musdash-buildkit"

/**
 * Pinned to a major tag rather than `latest`. A build daemon that silently
 * changes version underneath a working install is a support case nobody can
 * reproduce.
 */
const BUILDKIT_IMAGE = "moby/buildkit:v0.27.0"

/**
 * Holds the build cache, and the name is load-bearing exactly as Caddy's is: a
 * new name means an empty cache, and the cache is the difference between a
 * 20-second and a 3-minute redeploy.
 */
const CACHE_VOLUME = "musdash-buildkit-cache"

/**
 * Deliberately not config.defaultMemoryMb, for the same reason Caddy's is not:
 * that setting caps user applications, and lowering it to fit more apps on a
 * small box must not also throttle the component every one of those apps is
 * built by. Image assembly is memory-hungry in bursts.
 */
const BUILDKIT_MEMORY_BYTES = 1024 * 1024 * 1024

/**
 * Extracts the port from a `tcp://host:port` address.
 *
 * musdash publishes the daemon itself, so it has to know the port as a number
 * rather than passing the address through opaquely. A malformed value is a
 * configuration error worth failing loudly on at import: the alternative is a
 * container published on a port nobody intended.
 */
function parseBuildkitPort(addr: string): number {
  const match = /^tcp:\/\/[^:]+:(\d{1,5})$/.exec(addr)
  const port = match ? Number(match[1]) : Number.NaN
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DockerError(
      `MUSDASH_BUILDKIT_ADDR must look like tcp://127.0.0.1:1234, got ${JSON.stringify(addr)}`,
    )
  }
  return port
}

/** The port the daemon listens on, parsed from the configured address. */
const BUILDKIT_PORT = parseBuildkitPort(config.buildkitAddr)

/** How long to wait for the daemon to answer after starting the container. */
const READY_TIMEOUT_SEC = 30

/** Per-attempt bound on the readiness probe, so one hung socket cannot stall
 *  the poll past its deadline — the lesson from the Caddy readiness slice. */
const PROBE_TIMEOUT_MS = 2000

/** The image is ~200MB compressed; ten minutes is generous but not unbounded. */
const PULL_TIMEOUT_MS = 10 * 60 * 1000

export async function ensureBuildkit(): Promise<void> {
  await docker.ensureNetwork(config.network)
  await docker.createVolume(CACHE_VOLUME)

  // By name, not by label — the same reasoning as the proxy: a container left
  // by an earlier install carries no musdash labels and is invisible to a
  // managed=true filter, so a label lookup would conclude nothing is there and
  // try to bind an already-held port.
  const existing = (await docker.findContainersByName(BUILDKIT_CONTAINER))[0]
  const adopted = existing !== undefined

  let id: string
  if (existing) {
    id = existing.id
  } else {
    if (!(await docker.imageExists(BUILDKIT_IMAGE))) {
      logger.info({ image: BUILDKIT_IMAGE }, "buildkit: pulling the build image")
      const pullDeadline = Date.now() + PULL_TIMEOUT_MS
      await docker.pullImage(BUILDKIT_IMAGE, () => {
        // Throwing from the progress callback is the only cancellation point
        // pullImage exposes. A stalled pull stops emitting lines while a merely
        // slow one keeps going, so the deadline is checked on each one.
        if (Date.now() > pullDeadline) {
          throw new DockerError(
            `pulling ${BUILDKIT_IMAGE} exceeded ${PULL_TIMEOUT_MS / 60_000} minutes`,
          )
        }
      })
    }

    id = await docker.createContainer({
      name: BUILDKIT_CONTAINER,
      image: BUILDKIT_IMAGE,
      env: {},
      // The role label is what makes the privileged flag below legal:
      // createContainer refuses privileged mode on any spec without one.
      labels: sidecarLabels("builder"),
      networks: [config.network],
      volumes: [{ name: CACHE_VOLUME, mountPath: "/var/lib/buildkit" }],
      ports: [
        // Loopback only. BuildKit's API is unauthenticated and runs arbitrary
        // build instructions, so publishing it beyond the host would be handing
        // out remote code execution.
        {
          containerPort: BUILDKIT_PORT,
          hostPort: BUILDKIT_PORT,
          protocol: "tcp",
          hostIp: "127.0.0.1",
        },
      ],
      memoryLimitBytes: BUILDKIT_MEMORY_BYTES,
      restartPolicy: "unless-stopped",
      // BuildKit needs mount and namespace operations to assemble images.
      // Rootless would avoid this, but it needs a different image, different
      // security options and a different state path; the privileged variant was
      // verified working under WSL2 and on a standard Engine, and the flag is
      // gated to sidecar specs in createContainer.
      privileged: true,
      // FLAGS ONLY. The image's entrypoint is already `buildkitd`, so naming
      // the binary here again produces `buildkitd buildkitd --addr ...`, where
      // the stray argument is ignored and the daemon silently falls back to its
      // default unix socket. Verified against a real daemon: it starts, logs a
      // healthy worker, and is unreachable over TCP.
      //
      // Listening on all interfaces INSIDE the container is what makes the
      // loopback port mapping above reach it — the same lesson as Caddy's
      // CADDY_ADMIN=0.0.0.0:2019. The container is not on the host network, so
      // binding 127.0.0.1 here would bind the container's own loopback and the
      // mapping would forward to a listener that refuses it.
      command: ["--addr", `tcp://0.0.0.0:${BUILDKIT_PORT}`],
    })
  }

  await docker.startContainer(id)

  // A container musdash created moments ago has never restarted. A nonzero
  // count means it started, died, and was restarted by the unless-stopped
  // policy — which the readiness poll would otherwise paper over by catching it
  // during an up-phase. The adopted path skips this: a daemon that has been up
  // for months across a reboot legitimately has restarts.
  if (!adopted) {
    const initial = await docker.inspectContainer(id)
    if (!initial.running || initial.restartCount > 0) {
      throw new DockerError(exitedMessage(initial))
    }
  }

  await waitForDaemon(id, adopted)

  logger.info(
    { container: BUILDKIT_CONTAINER, id, adopted },
    adopted ? "adopted the existing BuildKit container" : "started BuildKit",
  )
}

/** Names the cause an exited build daemon usually has, and how to see it. */
function exitedMessage(state: ContainerState): string {
  return (
    `the ${BUILDKIT_CONTAINER} container is not running (exit code ${state.exitCode}, ` +
    `${state.restartCount} restarts). BuildKit exits when it cannot bind its port or when the ` +
    `daemon lacks the privileges to set up its snapshotter — check ` +
    `'ss -ltnp | grep ":${BUILDKIT_PORT} "' and 'docker logs ${BUILDKIT_CONTAINER}'.`
  )
}

/**
 * Waits until the daemon is alive and answering.
 *
 * Three gates, each earning its place the same way the proxy's do:
 *
 * 1. THE CONTAINER IS RUNNING. startContainer's 204 says "start accepted", not
 *    "still alive". BuildKit exits when it cannot bind, and unless-stopped
 *    turns that into a restart loop.
 *
 * 2. ITS PUBLISHED PORT IS ACTUALLY MAPPED. When a host port is already held
 *    the Engine starts the container anyway and leaves the mapping
 *    unprogrammed, so the daemon is healthy inside while nothing on the host
 *    can reach it. Without this gate that reads as "the daemon did not answer"
 *    and gets blamed on the wrong thing — the lesson from the Caddy slice.
 *
 * 3. THE PORT ACCEPTS A CONNECTION. Gates 1 and 2 say it should be reachable;
 *    only this says it is.
 */
async function waitForDaemon(id: string, adopted: boolean): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_SEC * 1000
  let lastReason = "the daemon did not answer"

  for (;;) {
    // Checked at the top: checking after the probe lets a full probe plus sleep
    // run past the deadline unnoticed.
    if (Date.now() > deadline) {
      throw new DockerError(
        `${BUILDKIT_CONTAINER} did not become ready within ${READY_TIMEOUT_SEC}s (${lastReason})` +
          (adopted
            ? `. The container was adopted, not created by musdash — if it was created without ` +
              `'--addr tcp://0.0.0.0:${BUILDKIT_PORT}' its API is bound inside the container where the ` +
              `port mapping cannot reach it. Recreate it: 'docker rm -f ${BUILDKIT_CONTAINER}'.`
            : "."),
      )
    }

    const state = await docker.inspectContainer(id).catch(() => null)
    if (state && !state.running) {
      // An exited daemon is not going to start answering, and the exit code is
      // the fact that explains it. Fail now rather than burning the full 30s.
      throw new DockerError(exitedMessage(state))
    }
    if (state?.running === true && state.publishedPortCount === 0) {
      throw new DockerError(
        `the ${BUILDKIT_CONTAINER} container is running but its published port is not mapped to the host. ` +
          "The Engine leaves a mapping unprogrammed when the host port is already taken, so the build " +
          `daemon is unreachable even though the container is up. Check what holds :${BUILDKIT_PORT} ` +
          `('ss -ltnp | grep ":${BUILDKIT_PORT} "'), free it, then 'docker rm -f ${BUILDKIT_CONTAINER}'.`,
      )
    }
    if (state && state.restartCount > 0) {
      lastReason = `the container has restarted ${state.restartCount} times`
    }

    if (state?.running === true && (await probeDaemon())) return

    await Bun.sleep(1000)
  }
}

/**
 * Whether the build daemon itself answers — not merely whether something
 * accepts a connection on its port.
 *
 * A bare TCP connect is worthless here and was tried first: when a port is
 * published, Docker's userland proxy binds the host side and accepts
 * connections whether or not anything is listening inside the container. A
 * connect-only probe therefore passed against a daemon that had silently fallen
 * back to its unix socket, which is exactly the false success the Caddy slice
 * was spent eliminating.
 *
 * BuildKit speaks gRPC, which musdash has no client for and will not add one
 * for. Instead it asks `buildctl` — which ships inside the image, so this costs
 * no host install — to list workers. That round-trips through the real API and
 * fails if the daemon is absent, wedged, or listening somewhere else.
 */
async function probeDaemon(): Promise<boolean> {
  try {
    let answered = false
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port: BUILDKIT_PORT,
      socket: {
        data: () => {
          answered = true
        },
        error: () => {},
      },
    })
    // The HTTP/2 client connection preface. A gRPC server must answer it with a
    // SETTINGS frame before anything else can happen, so a single inbound byte
    // is proof that a real HTTP/2 server — not a port forwarder — is on the far
    // end. `fetch` cannot stand in here: Bun's client is HTTP/1.1 and BuildKit
    // rejects it, so a fetch-based probe reports failure against a HEALTHY
    // daemon. Verified both ways against a real one.
    socket.write("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n")
    const deadline = Date.now() + PROBE_TIMEOUT_MS
    while (!answered && Date.now() < deadline) await Bun.sleep(50)
    socket.end()
    return answered
  } catch {
    // Connect refused: nothing is published, or the mapping is unprogrammed.
    return false
  }
}
