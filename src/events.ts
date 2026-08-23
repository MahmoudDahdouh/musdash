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
 */
const deployLogs = new Map<string, string[]>()
const DEPLOY_LOG_CAP = 2000

export function publishDeployLog(deploymentId: string, text: string): void {
  let lines = deployLogs.get(deploymentId)
  if (!lines) {
    lines = []
    deployLogs.set(deploymentId, lines)
  }
  lines.push(text)
  if (lines.length > DEPLOY_LOG_CAP)
    lines.splice(0, lines.length - DEPLOY_LOG_CAP)
  emitter.emit(deployLogTopic(deploymentId), text)
}

export function deployLogTail(deploymentId: string): string[] {
  return deployLogs.get(deploymentId) ?? []
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
