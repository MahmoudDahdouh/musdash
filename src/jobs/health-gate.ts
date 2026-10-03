import { CERT_WAIT_MS, waitForCertificate } from "../caddy/tls-probe.ts"
import { config } from "../config.ts"
import type { ContainerState } from "../docker/client.ts"
import { docker } from "../docker/impl.ts"
import { logger } from "../log.ts"

/**
 * The health gate and the certificate wait, shared by the image/git deploy
 * (deploy.ts) and the stack deploy (deploy-compose.ts). Moved here unchanged
 * so there is one copy of each: the gate is half of the zero-downtime
 * guarantee, and a second copy would be a second place for it to rot.
 */

/**
 * Waits, under one shared deadline, for the proxy to present a certificate for
 * each of `hosts`, and says per host in the deploy log whether it did.
 *
 * Must never throw. It runs after the route switch, and the outer catch in
 * runDeploy treats any throw past routeSwitchAttempted as a FAILED switch: it
 * would mark a deploy failed whose traffic already moved to a healthy
 * container, and leave the resource row pointing at the old one. So the whole
 * body is caught here and logged, and the deploy carries on.
 *
 * Socket and TLS error text goes to pino only; the deploy log gets the fixed
 * sentences below, through emit, like every other line.
 */
export async function awaitCertificates(
  resourceId: string,
  hosts: string[],
  emit: (s: string) => void,
): Promise<void> {
  try {
    emit(`Waiting for a certificate for ${hosts.join(", ")}...`)
    const deadline = Date.now() + CERT_WAIT_MS
    await Promise.all(
      hosts.map((host) =>
        waitForCertificate(host, deadline).then((result) => {
          if (result.ready) {
            emit(
              `Certificate ready for ${host} (${Math.ceil(result.elapsedMs / 1000)}s)`,
            )
            return
          }
          const { reason, detail } = result.last.ok
            ? { reason: undefined, detail: undefined }
            : result.last
          logger.warn(
            { resourceId, host, reason, detail },
            "no certificate for a new host before the deadline",
          )
          emit(
            `No certificate for ${host} after ${CERT_WAIT_MS / 1000}s. Caddy keeps retrying; ` +
              `check that ${host} points at this server and ports 80 and 443 are open.`,
          )
        }),
      ),
    )
  } catch (err) {
    // The name only: this path skips the deploy's redaction, so no message.
    logger.warn(
      { resourceId, errorName: err instanceof Error ? err.name : typeof err },
      "certificate wait failed; continuing the deploy",
    )
  }
}

/**
 * Waits for the new container to be usable, in the precedence §9 defines.
 *
 * musdash runs on the host, so it dials the container's IP rather than its name
 * — Docker's embedded DNS only resolves from inside the network (DECISIONS D2).
 *
 * `deadline` defaults to healthTimeoutSec from now; a stack passes the one
 * deadline all its services share. `restartBaseline` is the restart count
 * the container already had before this deploy — 0 for a container the deploy
 * created, which is every image and git deploy; a stack service Compose left
 * running unchanged keeps the count from its earlier life.
 */
export async function healthGate(
  containerId: string,
  containerPort: number | null,
  healthPath: string | null,
  emit: (s: string) => void,
  deadline: number = Date.now() + config.healthTimeoutSec * 1000,
  restartBaseline = 0,
): Promise<void> {
  // (a) explicit HTTP check
  if (healthPath && containerPort) {
    emit(`Polling http://<container>:${containerPort}${healthPath}`)
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error(
          `health check did not pass within ${config.healthTimeoutSec}s`,
        )
      }
      const state = await docker.inspectContainer(containerId)
      assertNotRestarted(state, restartBaseline)
      if (!state.running) {
        throw new Error(
          `container exited during the health check (code ${state.exitCode})`,
        )
      }
      if (state.ipAddress) {
        try {
          const res = await fetch(
            `http://${state.ipAddress}:${containerPort}${healthPath}`,
            { signal: AbortSignal.timeout(5000) },
          )
          if (res.ok) return
          emit(`Health check returned ${res.status}, retrying...`)
        } catch {
          // Not up yet; keep polling until the deadline.
        }
      }
      await Bun.sleep(1000)
    }
  }

  // (b) the image declares its own HEALTHCHECK
  const initial = await docker.inspectContainer(containerId)
  if (initial.health !== "none") {
    emit("Image declares a HEALTHCHECK, polling docker health...")
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error(
          `container did not report healthy within ${config.healthTimeoutSec}s`,
        )
      }
      const state = await docker.inspectContainer(containerId)
      assertNotRestarted(state, restartBaseline)
      if (state.health === "healthy") return
      if (state.health === "unhealthy") {
        throw new Error("container reported unhealthy")
      }
      if (!state.running) {
        throw new Error(`container exited (code ${state.exitCode})`)
      }
      await Bun.sleep(1000)
    }
  }

  // (c) fallback: still running after 5 seconds
  emit("No health check configured; requiring 5s of uptime")
  await Bun.sleep(5000)
  const state = await docker.inspectContainer(containerId)
  assertNotRestarted(state, restartBaseline)
  if (!state.running) {
    throw new Error(
      `container exited within 5s (code ${state.exitCode}) — check the logs above`,
    )
  }
}

/**
 * Fails the gate for a container Docker has restarted since the deploy began.
 *
 * A container this deploy created has a baseline of 0, so any restart means it
 * crashed. `running` alone cannot see that: the Engine reports State.Running as
 * true while it restarts a container under `unless-stopped`, so a crash loop
 * read as up and "succeeded" — and the reconciler, whose container list does
 * report the restarting state, then redeployed it every 30 seconds (L-2).
 */
export function assertNotRestarted(state: ContainerState, baseline = 0): void {
  const restarts = state.restartCount - baseline
  if (restarts > 0) {
    throw new Error(
      `container crashed and Docker restarted it (${restarts} ${
        restarts === 1 ? "restart" : "restarts"
      }) — check the logs above`,
    )
  }
}
