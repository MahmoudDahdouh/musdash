import { caddy } from "./client.ts"
import { config } from "../config.ts"
import { sidecarLabels } from "../docker/client.ts"
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

export const CADDY_CONTAINER = "mosdash-caddy"
const CADDY_IMAGE = "caddy:2-alpine"

/**
 * The volume names are load-bearing and must never change. `/data` holds the
 * certificate store; a new name means an empty store, re-issuance of every
 * certificate, and a burnt Let's Encrypt rate limit (50 per registered domain
 * per week). These are the same names scripts/install.sh has always used, so an
 * existing install keeps its certificates.
 */
const DATA_VOLUME = "mosdash-caddy-data"
const CONFIG_VOLUME = "mosdash-caddy-config"

/**
 * The proxy's cap is deliberately NOT config.defaultMemoryMb. That setting is
 * the default for user applications; lowering it to squeeze more apps onto a
 * small box must not also throttle the component every one of those apps is
 * served through.
 */
const CADDY_MEMORY_BYTES = 512 * 1024 * 1024

/** How long to wait for the admin API after starting the container. */
const READY_TIMEOUT_SEC = 30

export async function ensureCaddy(): Promise<void> {
  await docker.ensureNetwork(config.network)
  await docker.createVolume(DATA_VOLUME)
  await docker.createVolume(CONFIG_VOLUME)

  // Discovery is BY NAME, not by label. A container created by an older
  // install.sh carries no mosdash labels at all and is invisible to a
  // managed=true filter, so a label-based lookup would conclude nothing is
  // there and try to create a second proxy on the same ports.
  const existing = (await docker.findContainersByName(CADDY_CONTAINER))[0]
  const adopted = existing !== undefined

  let id: string
  if (existing) {
    // Adopt as-is: no recreate, no relabel, no remove. The operator's running
    // proxy is holding live TLS connections, and mosdash has no business
    // destroying it just because it did not create it.
    id = existing.id
  } else {
    // The proxy image is almost never already on a fresh box, and
    // createContainer answers a missing image with a bare 404. Pull first, but
    // tolerate a pull failure when the image is already local, so a firewalled
    // server with a cached image still comes up.
    if (!(await docker.imageExists(CADDY_IMAGE))) {
      logger.info({ image: CADDY_IMAGE }, "caddy: pulling the proxy image")
      await docker.pullImage(CADDY_IMAGE, () => {})
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
      // The image's default CMD runs a Caddyfile server with no JSON admin
      // state, so routes would not survive a restart. --resume replays the
      // last config mosdash pushed, which is what makes a reboot come back
      // serving the same sites.
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
  await waitForAdmin(adopted)
  await caddy.ensureBaseConfig()

  logger.info(
    { container: CADDY_CONTAINER, id, adopted },
    adopted ? "adopted the existing Caddy container" : "started Caddy",
  )
}

/**
 * Polls the admin API until it answers, on the same deadline shape as the
 * deploy health gate.
 */
async function waitForAdmin(adopted: boolean): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_SEC * 1000
  for (;;) {
    if (await caddy.ping()) return
    if (Date.now() > deadline) {
      // An adopted container is the one case with a known, specific cause:
      // every container the old install.sh created lacks CADDY_ADMIN, so its
      // admin API is bound inside the container and the loopback mapping
      // reaches nothing. Say so, and say what to do — but do not act. Tearing
      // down an operator's live proxy unasked is worse than failing loudly.
      if (adopted) {
        throw new Error(
          `the existing ${CADDY_CONTAINER} container did not answer on the admin API within ${READY_TIMEOUT_SEC}s. ` +
            "It was most likely created without CADDY_ADMIN=0.0.0.0:2019, which leaves the admin API bound inside " +
            "the container where the loopback port mapping cannot reach it. Recreate it: " +
            `'docker rm -f ${CADDY_CONTAINER}' and mosdash will start a correctly configured one.`,
        )
      }
      throw new Error(`Caddy did not become ready within ${READY_TIMEOUT_SEC}s`)
    }
    await Bun.sleep(1000)
  }
}
