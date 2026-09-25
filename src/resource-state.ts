import type { DeploymentStatus } from "./db/schema.ts"
import type { ResourceState } from "./events.ts"

/**
 * What a resource's status reads at first paint, derived from SQLite alone.
 *
 * One function for the sidebar dot, the project card and the resource head,
 * so the three can never disagree. It never touches Docker: a request handler
 * must not wait on it, which is why the live-only states — `unhealthy`, and
 * the reconciler's Deploying while a health check is `starting` — cannot come
 * out of here. SSE corrects the label while a page is open.
 *
 * Known blind spots, all from what is not stored: stopped-then-failed-redeploy
 * reads Stopped (a stop keeps currentDeploymentId); a dead container reads
 * Healthy, and again after a failed redeploy, since containerId is never
 * cleared; a deploy cut off by a fast restart reads Deploying until its row
 * is recovered.
 */
export function resourceState(
  resource: {
    desiredState: "running" | "stopped"
    containerId: string | null
    currentDeploymentId: string | null
  },
  latest: DeploymentStatus | null,
): ResourceState {
  if (latest === "running") return "deploying"
  if (latest === "queued") return "queued"
  // A failed redeploy leaves the old container serving, so running stays healthy.
  if (resource.desiredState === "running") {
    return resource.containerId ? "healthy" : "queued"
  }
  // Never succeeded, and the last attempt failed: nothing is or was serving.
  if (latest === "failed" && resource.currentDeploymentId === null) {
    return "failed"
  }
  return "stopped"
}

/** First wins: an environment's dot shows the first state any resource is in. */
export const STATE_ORDER: readonly ResourceState[] = [
  "failed",
  "unhealthy",
  "deploying",
  "queued",
  "healthy",
  "stopped",
]

export function worstState(
  a: ResourceState | null,
  b: ResourceState,
): ResourceState {
  if (a === null) return b
  return STATE_ORDER.indexOf(a) <= STATE_ORDER.indexOf(b) ? a : b
}
