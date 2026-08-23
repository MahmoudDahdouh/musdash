import { Elysia } from "elysia"
import { resolveSession, SESSION_COOKIE } from "../auth.ts"
import { getDeployment, getResource } from "../db/queries.ts"
import {
  deployLogTail,
  subscribeDeployLogs,
  subscribeDeployments,
  subscribeLogs,
  subscribeStatus,
  type DeploymentEvent,
  type StatusEvent,
} from "../events.ts"
import type { LogLine } from "../docker/client.ts"
import { tail } from "../logs/buffer.ts"

/**
 * Server-sent events.
 *
 * Every stream must release its subscription when the client goes away. A
 * browser tab closing has to unwind all the way to the Docker log stream, or
 * each closed tab leaks a listener and a socket — the usual cause of idle RSS
 * drifting upward.
 *
 * A comment heartbeat every 30s keeps proxies from treating an idle stream as
 * dead.
 */

const HEARTBEAT_MS = 30_000

function sseHeaders(): Record<string, string> {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // Nginx and friends buffer event streams into uselessness without this.
    "x-accel-buffering": "no",
  }
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/**
 * Bridges callback-style subscriptions into a ReadableStream, guaranteeing that
 * `cancel` (fired when the client disconnects) tears every one of them down.
 */
function eventStream(
  setup: (send: (chunk: string) => void) => () => void,
): Response {
  let cleanup: (() => void) | null = null
  let heartbeat: Timer | null = null

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      let closed = false
      const send = (chunk: string) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          closed = true
        }
      }
      cleanup = setup(send)
      heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS)
    },
    cancel() {
      cleanup?.()
      if (heartbeat) clearInterval(heartbeat)
    },
  })

  return new Response(stream, { headers: sseHeaders() })
}

export const sseRoutes = new Elysia()
  .derive(({ cookie }) => {
    const raw = cookie[SESSION_COOKIE]?.value
    return {
      session: resolveSession(typeof raw === "string" ? raw : undefined),
    }
  })
  .onBeforeHandle(({ session }) => {
    if (!session) return new Response("unauthorized", { status: 401 })
  })

  /** Live container logs for a resource. */
  .get("/r/:resourceId/logs", ({ params, status }) => {
    const resource = getResource(params.resourceId)
    if (!resource) return status(404, "resource not found")

    return eventStream((send) => {
      // The page already rendered the buffered tail server-side, so only new
      // lines are sent here.
      const unsubscribe = subscribeLogs(resource.id, (line: LogLine) => {
        send(frame("log", line))
      })
      return unsubscribe
    })
  })

  /** Status and deployment transitions for a resource. */
  .get("/r/:resourceId/events", ({ params, status }) => {
    const resource = getResource(params.resourceId)
    if (!resource) return status(404, "resource not found")

    return eventStream((send) => {
      const offStatus = subscribeStatus(resource.id, (e: StatusEvent) => {
        send(frame("status", e))
      })
      const offDeploy = subscribeDeployments(
        resource.id,
        (e: DeploymentEvent) => {
          send(frame("deployment", e))
        },
      )
      return () => {
        offStatus()
        offDeploy()
      }
    })
  })

  /** Build/deploy log for one deployment. */
  .get("/d/:deploymentId/logs", ({ params, status }) => {
    const deployment = getDeployment(params.deploymentId)
    if (!deployment) return status(404, "deployment not found")

    return eventStream((send) => {
      // Replay what already happened, then follow — a page opened mid-deploy
      // must not start from a blank panel.
      for (const line of deployLogTail(deployment.id)) {
        send(frame("line", { text: line }))
      }
      return subscribeDeployLogs(deployment.id, (text: string) => {
        send(frame("line", { text }))
      })
    })
  })

  .get("/d/:deploymentId/events", ({ params, status }) => {
    const deployment = getDeployment(params.deploymentId)
    if (!deployment) return status(404, "deployment not found")

    return eventStream((send) => {
      send(
        frame("deployment", {
          deploymentId: deployment.id,
          resourceId: deployment.resourceId,
          status: deployment.status,
        }),
      )
      return subscribeDeployments(
        deployment.resourceId,
        (e: DeploymentEvent) => {
          if (e.deploymentId === deployment.id) send(frame("deployment", e))
        },
      )
    })
  })

export { tail }
