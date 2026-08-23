import { docker } from "../docker/impl.ts"
import { publishLog } from "../events.ts"
import { logger } from "../log.ts"

/**
 * Keeps one live Docker log stream per running resource, feeding the ring
 * buffer and the SSE fan-out.
 *
 * One stream per resource, not per viewer: ten open tabs must not open ten
 * connections to the daemon. Every stream is tracked so it can be aborted —
 * an un-aborted follow keeps a socket and its buffers alive forever, which is
 * the usual cause of idle RSS drifting upward.
 */

interface Active {
  containerId: string
  controller: AbortController
}

const active = new Map<string, Active>()

export function startLogStream(resourceId: string, containerId: string): void {
  const existing = active.get(resourceId)
  if (existing?.containerId === containerId) return
  if (existing) stopLogStream(resourceId)

  const controller = new AbortController()
  active.set(resourceId, { containerId, controller })

  void (async () => {
    try {
      for await (const line of docker.streamLogs(containerId, {
        follow: true,
        tail: 100,
        signal: controller.signal,
      })) {
        publishLog(resourceId, line)
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        logger.debug(
          { resourceId, err: (err as Error).message },
          "log stream ended",
        )
      }
    } finally {
      // Only clear if this stream is still the current one; a newer deploy may
      // have replaced it while this was unwinding.
      if (active.get(resourceId)?.controller === controller) {
        active.delete(resourceId)
      }
    }
  })()
}

export function stopLogStream(resourceId: string): void {
  const s = active.get(resourceId)
  if (!s) return
  s.controller.abort()
  active.delete(resourceId)
}

export function stopAllLogStreams(): void {
  for (const id of [...active.keys()]) stopLogStream(id)
}

export function activeStreamCount(): number {
  return active.size
}
