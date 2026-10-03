import { docker } from "../docker/impl.ts"
import { publishLog } from "../events.ts"
import { logger } from "../log.ts"

/**
 * Keeps one live Docker log stream per running container musdash follows,
 * feeding the ring buffer and the SSE fan-out.
 *
 * One stream per container, not per viewer: ten open tabs must not open ten
 * connections to the daemon. Every stream is tracked so it can be aborted —
 * an un-aborted follow keeps a socket and its buffers alive forever, which is
 * the usual cause of idle RSS drifting upward.
 *
 * Keys: an image or git resource's one container is keyed by the resource id.
 * A stack runs one stream per service, keyed `<resourceId>:<service>`, and
 * every one publishes into the RESOURCE's buffer and file with a `[service] `
 * prefix — so the logs-RAM bound stays one ring per resource, not per service
 * (§3.9). A ULID has no colon, so the two kinds of key cannot collide.
 */

interface Active {
  containerId: string
  controller: AbortController
}

const active = new Map<string, Active>()

function serviceKey(resourceId: string, service: string): string {
  return `${resourceId}:${service}`
}

function follow(
  key: string,
  resourceId: string,
  containerId: string,
  prefix: string,
): void {
  const existing = active.get(key)
  if (existing?.containerId === containerId) return
  if (existing) stopKey(key)

  const controller = new AbortController()
  active.set(key, { containerId, controller })

  void (async () => {
    try {
      for await (const line of docker.streamLogs(containerId, {
        follow: true,
        tail: 100,
        signal: controller.signal,
      })) {
        publishLog(
          resourceId,
          prefix === "" ? line : { ...line, text: `${prefix}${line.text}` },
        )
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
      if (active.get(key)?.controller === controller) {
        active.delete(key)
      }
    }
  })()
}

function stopKey(key: string): void {
  const s = active.get(key)
  if (!s) return
  s.controller.abort()
  active.delete(key)
}

export function startLogStream(resourceId: string, containerId: string): void {
  follow(resourceId, resourceId, containerId, "")
}

/**
 * Follows exactly these services of a stack: each service's container is
 * followed (a no-op when it already is), and every other stream of the
 * resource — a service the stack no longer has, a stopped one — is stopped.
 */
export function syncStackLogStreams(
  resourceId: string,
  services: ReadonlyMap<string, string>,
): void {
  const wanted = new Set<string>()
  for (const [service, containerId] of services) {
    const key = serviceKey(resourceId, service)
    wanted.add(key)
    follow(key, resourceId, containerId, `[${service}] `)
  }
  for (const key of [...active.keys()]) {
    if (!wanted.has(key) && isKeyOf(key, resourceId)) stopKey(key)
  }
}

function isKeyOf(key: string, resourceId: string): boolean {
  return key === resourceId || key.startsWith(`${resourceId}:`)
}

/** Stops every stream of a resource: its container's, or all its services'. */
export function stopLogStream(resourceId: string): void {
  for (const key of [...active.keys()]) {
    if (isKeyOf(key, resourceId)) stopKey(key)
  }
}

export function stopAllLogStreams(): void {
  for (const key of [...active.keys()]) stopKey(key)
}

export function activeStreamCount(): number {
  return active.size
}
