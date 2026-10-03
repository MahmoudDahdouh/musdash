import { EventEmitter } from "node:events"
import type { LogLine } from "./docker/client.ts"
import type { DeploymentStatus } from "./db/schema.ts"
import { appendLine } from "./logs/buffer.ts"
import { appendToFile } from "./logs/file.ts"

/**
 * In-process fan-out for SSE. One EventEmitter, keyed by resource id — no
 * broker, no second process. The worker publishes; open pages subscribe.
 */

export type ResourceState =
  "queued" | "deploying" | "healthy" | "unhealthy" | "stopped" | "failed"

export interface StatusEvent {
  resourceId: string
  state: ResourceState
  health?: string
  containerId?: string | null
}

export interface DeploymentEvent {
  deploymentId: string
  resourceId: string
  status: DeploymentStatus
}

const emitter = new EventEmitter()
// Each open browser tab adds listeners; the default cap of 10 would warn
// spuriously on a dashboard with several panes open.
emitter.setMaxListeners(0)

const logTopic = (resourceId: string) => `log:${resourceId}`
const deployLogTopic = (deploymentId: string) => `dlog:${deploymentId}`
const statusTopic = (resourceId: string) => `status:${resourceId}`

/** Container output: buffered, persisted, then broadcast. */
export function publishLog(resourceId: string, line: LogLine): void {
  appendLine(resourceId, line)
  appendToFile(resourceId, line)
  emitter.emit(logTopic(resourceId), line)
}

export function subscribeLogs(
  resourceId: string,
  fn: (line: LogLine) => void,
): () => void {
  const topic = logTopic(resourceId)
  emitter.on(topic, fn)
  return () => emitter.off(topic, fn)
}

/**
 * Deploy pipeline output. Kept in memory only and tied to the deployment, not
 * the resource, so a page watching one deploy does not see another's.
 *
 * Bounded twice over, because an unbounded map here is RSS that grows by up to
 * 2000 lines per deployment for the life of the process — invisible to the
 * idle RAM gate, which boots fresh, and a slow leak on any box that deploys
 * often. Per entry, the line cap. Across entries, a sweep that runs only when
 * a NEW deployment starts writing: no timer, because entries only accumulate
 * at that moment, so it is the only moment the bound can be exceeded.
 */
interface DeployLog {
  lines: string[]
  /** Epoch ms when the deployment reached a terminal state; null while live. */
  finishedAt: number | null
}

const deployLogs = new Map<string, DeployLog>()
const DEPLOY_LOG_CAP = 2000
/** At most this many deployments' logs are held at once. */
export const DEPLOY_LOG_KEEP = 50
/**
 * How long a finished deployment's log outlives it with nobody watching — long
 * enough for the page someone opens right after a deploy to show the tail.
 */
export const DEPLOY_LOG_FINISHED_TTL_MS = 10 * 60 * 1000

export function publishDeployLog(deploymentId: string, text: string): void {
  let log = deployLogs.get(deploymentId)
  if (!log) {
    sweepDeployLogs(Date.now())
    log = { lines: [], finishedAt: null }
    deployLogs.set(deploymentId, log)
  }
  log.lines.push(text)
  if (log.lines.length > DEPLOY_LOG_CAP)
    log.lines.splice(0, log.lines.length - DEPLOY_LOG_CAP)
  emitter.emit(deployLogTopic(deploymentId), text)
}

/**
 * Records that a deployment reached a terminal state (succeeded, failed,
 * cancelled), which makes its log eligible for the sweep. A no-op when nothing
 * was logged — a cancelled or never-started deploy has no entry, and creating
 * one here would hold memory for an empty log. The first call wins, so a
 * second terminal path (the worker's give-up after runDeploy's own catch) does
 * not push the expiry back.
 */
export function markDeployLogFinished(
  deploymentId: string,
  now = Date.now(),
): void {
  const log = deployLogs.get(deploymentId)
  if (log && log.finishedAt === null) log.finishedAt = now
}

/**
 * Makes room for one more entry. Exported for tests; publishDeployLog is the
 * only production caller.
 *
 * In order: (a) finished past the TTL with no open page — nobody can want
 * these; (b) the oldest finished ones, even if watched, because the bound is
 * the point; (c) the oldest of any kind, which only a deployment that never
 * got marked (a terminal path nobody anticipated) can reach, since the worker
 * runs one deploy at a time. Map iteration is insertion order, so "first" is
 * "oldest", and deleting the current key mid-iteration is well-defined.
 */
export function sweepDeployLogs(now: number): void {
  for (const [id, log] of deployLogs) {
    if (
      log.finishedAt !== null &&
      now - log.finishedAt > DEPLOY_LOG_FINISHED_TTL_MS &&
      emitter.listenerCount(deployLogTopic(id)) === 0
    )
      dropDeployLogs(id)
  }
  for (const [id, log] of deployLogs) {
    if (deployLogs.size < DEPLOY_LOG_KEEP) return
    if (log.finishedAt !== null) dropDeployLogs(id)
  }
  for (const id of deployLogs.keys()) {
    if (deployLogs.size < DEPLOY_LOG_KEEP) return
    dropDeployLogs(id)
  }
}

/** How many deployments' logs are held. For tests. */
export function deployLogCount(): number {
  return deployLogs.size
}

export function deployLogTail(deploymentId: string): string[] {
  return deployLogs.get(deploymentId)?.lines ?? []
}

export function subscribeDeployLogs(
  deploymentId: string,
  fn: (text: string) => void,
): () => void {
  const topic = deployLogTopic(deploymentId)
  emitter.on(topic, fn)
  return () => emitter.off(topic, fn)
}

export function dropDeployLogs(deploymentId: string): void {
  deployLogs.delete(deploymentId)
}

export function publishStatus(event: StatusEvent): void {
  emitter.emit(statusTopic(event.resourceId), event)
  emitter.emit("status:*", event)
}

export function subscribeStatus(
  resourceId: string,
  fn: (e: StatusEvent) => void,
): () => void {
  const topic = statusTopic(resourceId)
  emitter.on(topic, fn)
  return () => emitter.off(topic, fn)
}

export function subscribeAllStatus(fn: (e: StatusEvent) => void): () => void {
  emitter.on("status:*", fn)
  return () => emitter.off("status:*", fn)
}

export function publishDeployment(event: DeploymentEvent): void {
  emitter.emit(`deployment:${event.resourceId}`, event)
}

export function subscribeDeployments(
  resourceId: string,
  fn: (e: DeploymentEvent) => void,
): () => void {
  const topic = `deployment:${resourceId}`
  emitter.on(topic, fn)
  return () => emitter.off(topic, fn)
}
