/**
 * The one interface every Docker operation goes through. Nothing else in the
 * codebase imports a Docker library or fetches the socket.
 *
 * It is deliberately free of local-socket assumptions: a later phase adds a
 * remote implementation that tunnels over SSH, and nothing above this line
 * should change when it does.
 */

/**
 * A published port.
 *
 * `hostIp` is required and has no default on purpose. The proxy publishes
 * 80/443 on every interface but its admin API on loopback only, and a defaulted
 * binding address is exactly how that distinction gets silently lost. Making it
 * explicit forces the caller to state which one it means.
 *
 * It is the binding address on whatever host the daemon runs on — not
 * necessarily this machine. A remote implementation binds on the remote host,
 * so nothing here may read it as "localhost".
 */
export interface PortBinding {
  containerPort: number
  hostPort: number
  protocol: "tcp" | "udp"
  hostIp: string
}

export interface ContainerSpec {
  name: string
  image: string
  env: Record<string, string>
  /** Must include the mosdash.* labels; the reconciler identifies containers by them. */
  labels: Record<string, string>
  networks: string[]
  volumes: { name: string; mountPath: string }[]
  /** Required. There is no unlimited option, not even internally. */
  memoryLimitBytes: number
  cpuShares?: number
  restartPolicy: "unless-stopped" | "no"
  /** Published ports. Absent means the container is reachable only on its network. */
  ports?: PortBinding[]
  /** Overrides the image's CMD. */
  command?: string[]
  healthcheck?: {
    test: string[]
    intervalSec: number
    timeoutSec: number
    retries: number
    startPeriodSec: number
  }
}

export type HealthState = "healthy" | "unhealthy" | "starting" | "none"

export interface ContainerState {
  id: string
  running: boolean
  health: HealthState
  exitCode: number | null
  startedAt: string | null
  restartCount: number
  /** Container IP on the mosdash network. mosdash runs on the host and cannot
   *  use Docker's embedded DNS, so the health gate dials this (DECISIONS D2). */
  ipAddress: string | null
}

export interface ManagedContainer {
  id: string
  name: string
  image: string
  running: boolean
  labels: Record<string, string>
  createdAt: number
}

export interface LogLine {
  stream: "stdout" | "stderr"
  timestamp: string
  text: string
}

export interface LogOpts {
  follow: boolean
  tail: number
  since?: number
  signal?: AbortSignal
}

export interface DockerClient {
  ping(): Promise<boolean>
  version(): Promise<{ version: string; apiVersion: string }>

  pullImage(ref: string, onProgress: (line: string) => void): Promise<void>
  imageExists(ref: string): Promise<boolean>
  removeImage(ref: string, force?: boolean): Promise<void>

  createContainer(spec: ContainerSpec): Promise<string>
  startContainer(id: string): Promise<void>
  stopContainer(id: string, timeoutSec?: number): Promise<void>
  removeContainer(id: string, force?: boolean): Promise<void>
  inspectContainer(id: string): Promise<ContainerState>
  listManagedContainers(): Promise<ManagedContainer[]>
  /**
   * Containers whose name is exactly `name`, running or not.
   *
   * Distinct from `listManagedContainers` because a container created by an
   * earlier installer carries no mosdash labels and is therefore invisible to a
   * label filter — bootstrap has to find it by name in order to adopt it rather
   * than collide with it.
   */
  findContainersByName(name: string): Promise<ManagedContainer[]>

  streamLogs(id: string, opts: LogOpts): AsyncIterable<LogLine>

  ensureNetwork(name: string): Promise<void>
  createVolume(name: string): Promise<void>
  removeVolume(name: string): Promise<void>
  /**
   * Reclaims image disk. `keep` lists references that must survive — rollback
   * targets, which the Engine cannot be asked to exempt (its prune filters
   * reject `reference`), so the implementation removes selectively instead.
   */
  pruneImages(
    olderThanHours: number,
    keep: string[],
  ): Promise<{ reclaimedBytes: number; protectedCount: number }>
}

export class DockerError extends Error {
  override readonly name = "DockerError"
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

export class ContainerNotFoundError extends DockerError {
  constructor(id: string) {
    super(`container ${id} not found`, 404)
  }
}

/**
 * A registry reference, validated before it can reach the Engine or a shell.
 * Accepts optional host[:port]/, path segments, and one of :tag or @digest.
 */
const IMAGE_RE =
  /^(?:(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*(?::\d{1,5})?)\/)?[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*)*(?::[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/

export function isValidImageRef(ref: string): boolean {
  if (ref.length === 0 || ref.length > 512) return false
  return IMAGE_RE.test(ref)
}

export function assertValidImageRef(ref: string): void {
  if (!isValidImageRef(ref)) {
    throw new DockerError(`invalid image reference: ${JSON.stringify(ref)}`)
  }
}

/** Resource names become container names and DNS labels. */
export const RESOURCE_NAME_RE = /^[a-z0-9-]{1,32}$/

export function isValidResourceName(name: string): boolean {
  return RESOURCE_NAME_RE.test(name)
}

export const LABEL_MANAGED = "mosdash.managed"
export const LABEL_RESOURCE = "mosdash.resource_id"
export const LABEL_DEPLOYMENT = "mosdash.deployment_id"
export const LABEL_PROJECT = "mosdash.project_id"
/** Marks infrastructure mosdash runs for itself (the proxy), not a user resource. */
export const LABEL_ROLE = "mosdash.role"

export function managedLabels(args: {
  resourceId: string
  deploymentId: string
  projectId: string
}): Record<string, string> {
  return {
    [LABEL_MANAGED]: "true",
    [LABEL_RESOURCE]: args.resourceId,
    [LABEL_DEPLOYMENT]: args.deploymentId,
    [LABEL_PROJECT]: args.projectId,
  }
}

/**
 * Labels for a container mosdash runs for itself.
 *
 * Deliberately carries NO resource id, not even a synthetic one: a resource id
 * is a foreign key into the resources table, and inventing a value that resolves
 * to no row is precisely what the orphan sweep is built to delete. The role
 * label is what marks it as not-a-resource, and both sweeps skip on it.
 */
export function sidecarLabels(role: string): Record<string, string> {
  return {
    [LABEL_MANAGED]: "true",
    [LABEL_ROLE]: role,
  }
}
