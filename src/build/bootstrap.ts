import { chmodSync, mkdirSync } from "node:fs"
import { config } from "../config.ts"
import {
  type ContainerState,
  DockerError,
  sidecarLabels,
} from "../docker/client.ts"
import { docker } from "../docker/impl.ts"
import { logger } from "../log.ts"
import { buildkitMemoryCap } from "./memory.ts"

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

const MIB = 1024 * 1024

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
 *
 * Generation 3 sized the memory cap from the Docker host instead of fixing it
 * at 1 GiB, which on a 1GB host limited nothing (D33).
 */
const SPEC_LABEL = "musdash.builder_spec"
const SPEC_VERSION = "3"
/** The generation before D33: correct in every respect but its memory cap. */
const PREVIOUS_SPEC_VERSION = "2"

/**
 * The gid the socket was created for, fixed into the daemon's `--group` at
 * create time. If musdash's gid changes, the daemon is replaced rather than
 * adopted with a socket this process can no longer open.
 */
const GID_LABEL = "musdash.builder_gid"
const GID = String(process.getgid?.() ?? 0)

/**
 * The memory cap, in MiB, the daemon was created with.
 *
 * The generation bump alone would size the cap once and never again, and
 * RUNNING.md's remedy for builds that do not fit is a bigger host: a 1GB box
 * resized to 2GB would keep its 384 MiB daemon forever and the remedy would do
 * nothing. Comparing the cap itself also makes an override change, or its
 * removal, take effect on the next boot. The limit is fixed at create time and
 * adoption never recreates, so this label is the only way to notice.
 */
const MEMORY_LABEL = "musdash.builder_memory_mb"

/** How long to wait for the daemon to answer after starting the container. */
const READY_TIMEOUT_SEC = 30

/** Per-attempt bound on the readiness probe, so one hung socket cannot stall
 *  the poll past its deadline — the lesson from the Caddy readiness slice. */
const PROBE_TIMEOUT_MS = 2000

/** The image is ~200MB compressed; ten minutes is generous but not unbounded. */
const PULL_TIMEOUT_MS = 10 * 60 * 1000

export async function ensureBuildkit(): Promise<void> {
  // First, before anything is looked up or removed: the cap decides whether the
  // existing daemon is current, and a rejected override or an unreachable
  // /info must fail this job with the running daemon left exactly as it was.
  const memory = await resolveMemoryCap()

  await docker.ensureNetwork(config.network)
  await docker.createVolume(CACHE_VOLUME)

  prepareSocketDir()

  // By name, not by label — the same reasoning as the proxy: a container left
  // by an earlier install carries no musdash labels and is invisible to a
  // managed=true filter, so a label lookup would conclude nothing is there and
  // try to create a second daemon under the same name.
  const found = (await docker.findContainersByName(BUILDKIT_CONTAINER))[0]
  // An outdated daemon is replaced, not adopted: a listen address, a --group
  // and a memory limit are all fixed when a container is created. Unlike the
  // proxy's replacement this costs nothing a user can see — no traffic flows
  // through a build daemon, the job queue guarantees no build is running right
  // now, and CACHE_VOLUME survives the removal.
  const current =
    found !== undefined &&
    found.labels[SPEC_LABEL] === SPEC_VERSION &&
    found.labels[GID_LABEL] === GID &&
    found.labels[MEMORY_LABEL] === String(memory.mb)
  if (found && !current) {
    const stale = staleReason(found.labels, memory.mb)
    const oldMemory = found.labels[MEMORY_LABEL]
    logger.warn(
      {
        container: BUILDKIT_CONTAINER,
        id: found.id,
        reason: stale.reason,
        oldMemoryMb: oldMemory === undefined ? null : Number(oldMemory),
        newMemoryMb: memory.mb,
      },
      `replacing the build daemon: ${stale.message}. The build cache is kept`,
    )
    await docker.removeContainer(found.id, true)
  }
  const existing = current ? found : undefined
  const adopted = existing !== undefined

  // On every bootstrap, adopting or creating — unlike the floor warning. The
  // label only records what the daemon was created with, so an override that
  // was reasonable on a larger host is adopted unchanged after the host
  // shrinks, and this is then the only line that says the cap is now too big.
  if (memory.fromOverride && memory.mb > memory.computedMb) {
    logger.warn(
      {
        hostMemoryMb: memory.hostMb,
        memoryMb: memory.mb,
        computedMemoryMb: memory.computedMb,
      },
      `MUSDASH_BUILDKIT_MEMORY_MB=${memory.mb} is above the ${memory.computedMb} MiB sized from this host; ` +
        "builds may now exhaust the host's memory and take the dashboard and apps with it",
    )
  }

  let id: string
  if (existing) {
    id = existing.id
    // Every daemon that passes the check above was created by this generation,
    // so it has a cache ceiling — but the ceiling from MUSDASH_BUILD_CACHE_GB
    // as it was THEN. Unlike the memory cap it carries no label: the flag is
    // not observable through ManagedContainer, and replacing the daemon for a
    // disk setting is not this check's job. Logged at debug because it is
    // correct and expected on every boot.
    logger.debug(
      { container: BUILDKIT_CONTAINER, capGb: config.buildCacheGb },
      "adopted an existing build daemon with the cache ceiling it was created with; after changing MUSDASH_BUILD_CACHE_GB, `docker rm -f musdash-buildkit` recreates it",
    )
  } else {
    // Only on create, not on every adopting boot: the warning is about the
    // daemon about to exist, and the info line below carries the numbers on
    // every boot regardless.
    if (memory.floored) {
      logger.warn(
        { hostMemoryMb: memory.hostMb, memoryMb: memory.mb },
        `the Docker host has ${memory.hostMb} MiB of memory, too little for the build daemon's sizing; ` +
          `its cap is the ${memory.mb} MiB floor, and builds may still exhaust the host`,
      )
    }

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
        [MEMORY_LABEL]: String(memory.mb),
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
      memoryLimitBytes: memory.bytes,
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
        throw new DockerError(exitedMessage(initial, memory.fromOverride))
      }
    }

    await waitForDaemon(id, adopted, memory.fromOverride)
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
    {
      container: BUILDKIT_CONTAINER,
      id,
      adopted,
      memoryMb: memory.mb,
      hostMemoryMb: memory.hostMb,
    },
    adopted ? "adopted the existing BuildKit container" : "started BuildKit",
  )
}

interface ResolvedMemoryCap {
  /** The cap the daemon is (to be) created with. A whole number of MiB. */
  bytes: number
  mb: number
  /** What the formula gives for this host, whether or not it is in use. */
  computedMb: number
  /** MemTotal as the daemon reports it, rounded down to whole MiB. */
  hostMb: number
  /** The formula hit its floor. Never true for an override. */
  floored: boolean
  fromOverride: boolean
}

/**
 * The build daemon's memory cap: from the Docker host's memory (D33), or from
 * MUSDASH_BUILDKIT_MEMORY_MB when the operator set one.
 *
 * Deliberately not config.defaultMemoryMb, for the same reason Caddy's is not:
 * that setting caps user applications, and lowering it to fit more apps on a
 * small box must not also throttle the component every one of those apps is
 * built by. Image assembly is memory-hungry in bursts.
 *
 * The host is the DAEMON's, asked through DockerClient.info(), never this
 * process's /proc: once the daemon is remote they are different machines.
 */
async function resolveMemoryCap(): Promise<ResolvedMemoryCap> {
  const { memTotalBytes } = await docker.info()
  const hostMb = Math.floor(memTotalBytes / MIB)
  const computed = buildkitMemoryCap(memTotalBytes)
  const computedMb = computed.bytes / MIB
  const override = config.buildkitMemoryMb

  if (override === undefined) {
    return {
      bytes: computed.bytes,
      mb: computedMb,
      computedMb,
      hostMb,
      floored: computed.floored,
      fromOverride: false,
    }
  }

  // An explicit setting is never silently replaced by the computed value, so a
  // degenerate one fails loudly instead of being clamped. This only rejects
  // the cap that cannot limit anything; one just below the host's memory is
  // allowed and brings V-1 back in practice, which is why the create path
  // warns about any override above the computed cap.
  const bytes = override * MIB
  if (bytes >= memTotalBytes) {
    throw new DockerError(
      `MUSDASH_BUILDKIT_MEMORY_MB is ${override} MiB, at or above the Docker host's ${hostMb} MiB of memory; ` +
        `a cap that large limits nothing. Set it below ${hostMb}, or remove it to size the cap from the host (${computedMb} MiB).`,
    )
  }
  return {
    bytes,
    mb: override,
    computedMb,
    hostMb,
    floored: false,
    fromOverride: true,
  }
}

type StaleReason = "d32" | "gen2" | "gid" | "memory" | "gid+memory"

/**
 * Why a daemon that failed the adopt check is being replaced, so the one
 * warning an operator sees names the actual cause. First match wins; called
 * only when at least one of the three labels differs.
 */
function staleReason(
  labels: Record<string, string>,
  capMb: number,
): { reason: StaleReason; message: string } {
  const spec = labels[SPEC_LABEL]
  // No label means generation 1, which listened on TCP. A value NEWER than
  // this build's — seen after a downgrade — lands here too; the wording is
  // then imprecise, but replacing a definition this build does not know is
  // still right.
  if (spec !== PREVIOUS_SPEC_VERSION && spec !== SPEC_VERSION) {
    return {
      reason: "d32",
      message: "its API was reachable from every app on the musdash network",
    }
  }
  if (spec === PREVIOUS_SPEC_VERSION) {
    return {
      reason: "gen2",
      message:
        "it was created before the memory cap was sized from the host (D33)",
    }
  }

  const oldMemory = labels[MEMORY_LABEL]
  const memoryChange =
    oldMemory === undefined
      ? `memory cap was unset, now ${capMb} MiB`
      : `memory cap changed from ${oldMemory} MiB to ${capMb} MiB`
  const memoryDiffers = labels[MEMORY_LABEL] !== String(capMb)
  const oldGid = labels[GID_LABEL] ?? "unset"
  if (oldGid !== GID) {
    const gidChange = `its socket was created for gid ${oldGid} and musdash now runs as gid ${GID}`
    return memoryDiffers
      ? {
          reason: "gid+memory",
          message: `${gidChange}; and its ${memoryChange}`,
        }
      : { reason: "gid", message: gidChange }
  }
  return { reason: "memory", message: `its ${memoryChange}` }
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
function exitedMessage(
  state: ContainerState,
  memoryFromOverride: boolean,
): string {
  return (
    `the ${BUILDKIT_CONTAINER} container is not running (exit code ${state.exitCode}, ` +
    `${state.restartCount} restarts). BuildKit exits when it cannot create its socket or when the ` +
    `daemon lacks the privileges to set up its snapshotter — see 'docker logs ${BUILDKIT_CONTAINER}'.` +
    // The formula never goes below the floor buildkitd idles within; an
    // override can sit just above it and still be too small in practice, and
    // an operator who set one should be pointed at it first.
    (memoryFromOverride
      ? " Its memory cap came from MUSDASH_BUILDKIT_MEMORY_MB, which may be too low."
      : "")
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
async function waitForDaemon(
  id: string,
  adopted: boolean,
  memoryFromOverride: boolean,
): Promise<void> {
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
      // Only a daemon created in this run can blame the override: an adopted
      // one was running before, under whatever it was created with.
      throw new DockerError(
        exitedMessage(state, memoryFromOverride && !adopted),
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
