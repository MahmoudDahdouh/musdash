import { chmodSync, mkdirSync } from "node:fs"
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
 * The daemon's own cache ceiling, for --oci-worker-gc-keepstorage.
 *
 * Two fields, "Reserved,Maximum", in MB — verified to parse against
 * moby/buildkit:v0.27.0. Reserved is the floor gc will never collect below and
 * Maximum the ceiling it collects down to, both derived from the same knob that
 * bounds the on-disk cache so one number governs the whole build cache.
 *
 * Reserved is a quarter of the cap rather than equal to it: setting them equal
 * leaves gc nothing it is permitted to reclaim, which is how a cap becomes a
 * daemon that never collects.
 *
 * The third field is deliberately omitted. buildkitd's own --help calls the
 * value "Reserved[,Free[,Maximum]]", but upstream assigns the parsed fields in
 * the order GCReservedSpace, GCMaxUsedSpace, GCMinFreeSpace — so position two
 * is the maximum, not a free-space target, and the help text is misleading.
 * Passing three fields on the help text's reading set the ceiling to ~197GB and
 * left the cap inert. Two fields are unambiguous under either reading, and were
 * verified to parse; the daemon accepts contradictory values silently, so this
 * cannot be settled by observing it and is pinned to upstream's assignment
 * order instead.
 *
 * Writing an empty field to skip one is not an option: "2560,,10240" is a parse
 * error and buildkitd exits with `strconv.ParseInt: parsing "": invalid
 * syntax`. Percentages are rejected too — this flag takes MB integers only.
 */
function gcKeepStorageMb(): string {
  const maxMb = config.buildCacheGb * 1024
  const reservedMb = Math.floor(maxMb / 4)
  return `${reservedMb},${maxMb}`
}

/**
 * Where the daemon creates its socket, INSIDE the container. The host directory
 * config.buildkitDir is bind-mounted here, so the socket is
 * config.buildkitSocket on the host — which is where buildctl and railpack dial.
 */
const SOCKET_DIR_IN_CONTAINER = "/run/musdash-buildkit"

/**
 * Which generation of the container definition a daemon was created from.
 *
 * Generation 2 moved the API from `tcp://0.0.0.0:1234` — which answered every
 * app on the `musdash` network, unauthenticated, on a privileged container —
 * to a unix socket (D32). A daemon without this label is replaced; the cache
 * volume is kept, so the only cost is one daemon restart.
 */
const SPEC_LABEL = "musdash.builder_spec"
const SPEC_VERSION = "2"

/**
 * The gid the socket was created for, fixed into the daemon's `--group` at
 * create time. If musdash's gid changes, the daemon is replaced rather than
 * adopted with a socket this process can no longer open.
 */
const GID_LABEL = "musdash.builder_gid"
const GID = String(process.getgid?.() ?? 0)

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

  prepareSocketDir()

  // By name, not by label — the same reasoning as the proxy: a container left
  // by an earlier install carries no musdash labels and is invisible to a
  // managed=true filter, so a label lookup would conclude nothing is there and
  // try to create a second daemon under the same name.
  const found = (await docker.findContainersByName(BUILDKIT_CONTAINER))[0]
  // An outdated daemon is replaced, not adopted: its TCP listener is the hole
  // D32 closes, and a listen address cannot be changed on a running container.
  // Unlike the proxy's replacement this costs nothing a user can see — no
  // traffic flows through a build daemon, the job queue guarantees no build is
  // running right now, and CACHE_VOLUME survives the removal.
  const current =
    found !== undefined &&
    found.labels[SPEC_LABEL] === SPEC_VERSION &&
    found.labels[GID_LABEL] === GID
  if (found && !current) {
    logger.warn(
      { container: BUILDKIT_CONTAINER, id: found.id },
      "replacing the build daemon: its API was reachable from every app on the musdash network. The build cache is kept",
    )
    await docker.removeContainer(found.id, true)
  }
  const existing = current ? found : undefined
  const adopted = existing !== undefined

  let id: string
  if (existing) {
    id = existing.id
    // The cache ceiling is applied when the container is created, and adoption
    // deliberately does not recreate — that would discard the cache volume that
    // makes redeploys fast. So a daemon from before the cap keeps collecting
    // without one, and nothing else would ever say so: the flag is not
    // observable through ManagedContainer, and widening the Docker interface to
    // read a command line for one log line is not worth the surface. Logged at
    // debug rather than warn because it is correct and expected on every boot
    // of an install that predates the cap, and a warning every boot for a
    // condition the operator may have chosen is noise.
    logger.debug(
      { container: BUILDKIT_CONTAINER, capGb: config.buildCacheGb },
      "adopted an existing build daemon; if it predates the cache cap, `docker rm -f musdash-buildkit` recreates it capped",
    )
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
      labels: {
        ...sidecarLabels("builder"),
        [SPEC_LABEL]: SPEC_VERSION,
        [GID_LABEL]: GID,
      },
      networks: [config.network],
      volumes: [{ name: CACHE_VOLUME, mountPath: "/var/lib/buildkit" }],
      // No published port, and no TCP listener at all. BuildKit's API is
      // unauthenticated and runs arbitrary build instructions in a privileged
      // container: a TCP listener inside it answers the musdash network, which
      // every user app is attached to (D32).
      hostMounts: [
        { hostPath: config.buildkitDir, mountPath: SOCKET_DIR_IN_CONTAINER },
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
      // `--group` is musdash's own gid. buildkitd creates the socket 0660 and
      // chowns it to root:<group>, so this process can connect while other
      // host users are kept out by config.buildkitDir's 0700. It leaves the
      // existing parent directory alone (containerd's mkdirAs only creates a
      // missing one), so the 0700 set by prepareSocketDir survives.
      //
      // The daemon keeps its own cache in CACHE_VOLUME, which is where Railpack
      // builds cache — buildCacheDir only ever holds the Dockerfile strategy's
      // exports. Capping one without the other would leave the default build
      // pack unbounded, which is the disk leak this is here to close.
      //
      // A flag rather than buildkitd.toml because the array above is FLAGS
      // ONLY, and a config file would need a bind mount this bootstrap does not
      // otherwise have. Verified against v0.27.0's own --help: the value is
      // "Reserved[,Free[,Maximum]]" in MB, not bytes, and an unrecognised flag
      // makes buildkitd exit rather than warn — so a wrong name here fails
      // loudly at the readiness gate instead of silently doing nothing.
      command: [
        "--addr",
        `unix://${SOCKET_DIR_IN_CONTAINER}/buildkitd.sock`,
        "--group",
        GID,
        "--oci-worker-gc",
        `--oci-worker-gc-keepstorage=${gcKeepStorageMb()}`,
      ],
    })
  }

  try {
    await docker.startContainer(id)

    // A container musdash created moments ago has never restarted. A nonzero
    // count means it started, died, and was restarted by the unless-stopped
    // policy — which the readiness poll would otherwise paper over by catching
    // it during an up-phase. The adopted path skips this: a daemon that has
    // been up for months across a reboot legitimately has restarts.
    if (!adopted) {
      const initial = await docker.inspectContainer(id)
      if (!initial.running || initial.restartCount > 0) {
        throw new DockerError(exitedMessage(initial))
      }
    }

    await waitForDaemon(id, adopted)
  } catch (err) {
    // Removed rather than left for the next bootstrap to adopt: it carries the
    // current labels, so it would be adopted, broken, forever (N-2's lesson).
    // The cache volume is untouched.
    if (!adopted) {
      await docker.removeContainer(id, true).catch((rmErr: unknown) => {
        logger.warn(
          { id, err: (rmErr as Error).message },
          `could not remove the build daemon that failed to start; 'docker rm -f ${id}'`,
        )
      })
    }
    throw err
  }

  logger.info(
    { container: BUILDKIT_CONTAINER, id, adopted },
    adopted ? "adopted the existing BuildKit container" : "started BuildKit",
  )
}

/**
 * Creates the directory the daemon puts its socket in, private to musdash.
 *
 * The same shape as the proxy's (D29): the 0700 here is the access control on
 * an unauthenticated API. chmod after mkdir because mkdir's mode is filtered by
 * the umask and ignored entirely when the path exists.
 */
function prepareSocketDir(): void {
  try {
    mkdirSync(config.buildkitDir, { recursive: true, mode: 0o700 })
    chmodSync(config.buildkitDir, 0o700)
  } catch (err) {
    throw new DockerError(
      `cannot prepare ${config.buildkitDir} for the build daemon's socket: ${(err as Error).message}. ` +
        "It must be a directory owned by the user musdash runs as.",
    )
  }
}

/** Names the cause an exited build daemon usually has, and how to see it. */
function exitedMessage(state: ContainerState): string {
  return (
    `the ${BUILDKIT_CONTAINER} container is not running (exit code ${state.exitCode}, ` +
    `${state.restartCount} restarts). BuildKit exits when it cannot create its socket or when the ` +
    `daemon lacks the privileges to set up its snapshotter — see 'docker logs ${BUILDKIT_CONTAINER}'.`
  )
}

/**
 * Waits until the daemon is alive and answering.
 *
 * Two gates, each earning its place the same way the proxy's do:
 *
 * 1. THE CONTAINER IS RUNNING. startContainer's 204 says "start accepted", not
 *    "still alive". BuildKit exits when it cannot create its socket, and
 *    unless-stopped turns that into a restart loop.
 *
 * 2. THE SOCKET ANSWERS AS A gRPC SERVER. Gate 1 ties the answer to the
 *    container just started — a socket file can outlive the daemon that made
 *    it — and only this says the daemon is actually serving.
 *
 * The published-port gate this used to have is gone with the port (D32).
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
          `. Its socket should appear at ${config.buildkitSocket}; see 'docker logs ${BUILDKIT_CONTAINER}'` +
          (adopted
            ? `. The container was already running; 'docker rm -f ${BUILDKIT_CONTAINER}' makes musdash start a fresh one.`
            : "."),
      )
    }

    const state = await docker.inspectContainer(id).catch(() => null)
    if (state && !state.running) {
      // An exited daemon is not going to start answering, and the exit code is
      // the fact that explains it. Fail now rather than burning the full 30s.
      throw new DockerError(exitedMessage(state))
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
 * A bare connect is worthless here and was tried first: back when the daemon
 * listened on a published TCP port, Docker's userland proxy accepted
 * connections whether or not anything was listening inside the container. On
 * a unix socket the same trap has a different shape — a stale socket file from
 * a dead daemon — and the answer is the same: make the far end speak.
 *
 * BuildKit speaks gRPC, which musdash has no client for and will not add one
 * for. Instead it asks `buildctl` — which ships inside the image, so this costs
 * no host install — to list workers. That round-trips through the real API and
 * fails if the daemon is absent, wedged, or listening somewhere else.
 */
export async function probeDaemon(): Promise<boolean> {
  try {
    let answered = false
    const socket = await Bun.connect({
      unix: config.buildkitSocket,
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
    // No socket yet, or a stale one nothing is listening on.
    return false
  }
}
