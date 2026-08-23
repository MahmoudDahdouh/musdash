import { config } from "../config.ts"
import { logger } from "../log.ts"
import {
  assertValidImageRef,
  ContainerNotFoundError,
  type ContainerSpec,
  type ContainerState,
  DockerError,
  type DockerClient,
  type HealthState,
  LABEL_MANAGED,
  type LogLine,
  type LogOpts,
  type ManagedContainer,
} from "./client.ts"
import { createDemuxer, createLineAssembler } from "./demux.ts"

/**
 * Docker Engine client over the unix socket, using Bun's native
 * `fetch(url, { unix })`. Chosen by the spike (see docs/DECISIONS.md): both
 * dockerode and raw fetch worked, and raw fetch avoids 72 transitive packages
 * and a postinstall that wants a Node binary.
 *
 * The API version is pinned in the path. The daemon happily serves an older
 * versioned path than it reports, and an unversioned URL would silently change
 * behaviour under a daemon upgrade.
 */
const API_VERSION = "v1.44"

type UnixInit = RequestInit & { unix: string }

interface EngineErrorBody {
  message?: string
}

export class DockerHttpClient implements DockerClient {
  constructor(private readonly socketPath: string = config.dockerSocket) {}

  private url(path: string): string {
    return `http://localhost/${API_VERSION}${path}`
  }

  private async request(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    try {
      return await fetch(this.url(path), {
        ...init,
        unix: this.socketPath,
      } as UnixInit)
    } catch (cause) {
      throw new DockerError(
        `cannot reach the Docker daemon at ${this.socketPath}: ${(cause as Error).message}`,
      )
    }
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.request(path, init)
    if (!res.ok) throw await this.toError(res, path)
    return (await res.json()) as T
  }

  private async expectOk(path: string, init: RequestInit): Promise<void> {
    const res = await this.request(path, init)
    if (!res.ok) throw await this.toError(res, path)
    await res.arrayBuffer() // drain, so the socket is released
  }

  private async toError(res: Response, path: string): Promise<DockerError> {
    let detail = ""
    try {
      const body = (await res.json()) as EngineErrorBody
      detail = body.message ?? ""
    } catch {
      detail = await res.text().catch(() => "")
    }
    if (res.status === 404) {
      return new ContainerNotFoundError(path)
    }
    return new DockerError(
      `docker ${path} failed: ${res.status} ${detail}`.trim(),
      res.status,
    )
  }

  private postJson(body: unknown): RequestInit {
    return {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }
  }

  // ----------------------------------------------------------------- basics

  async ping(): Promise<boolean> {
    try {
      const res = await this.request("/_ping")
      return res.ok
    } catch {
      return false
    }
  }

  async version(): Promise<{ version: string; apiVersion: string }> {
    const v = await this.json<{ Version: string; ApiVersion: string }>(
      "/version",
    )
    return { version: v.Version, apiVersion: v.ApiVersion }
  }

  // ----------------------------------------------------------------- images

  /**
   * Streams the pull, forwarding progress. The body is NDJSON whose lines split
   * across chunks exactly as log frames do, so it needs the same
   * buffer-until-complete discipline.
   */
  async pullImage(
    ref: string,
    onProgress: (line: string) => void,
  ): Promise<void> {
    assertValidImageRef(ref)
    const { name, tag } = splitRef(ref)
    const res = await this.request(
      `/images/create?fromImage=${encodeURIComponent(name)}&tag=${encodeURIComponent(tag)}`,
      { method: "POST" },
    )
    if (!res.ok) throw await this.toError(res, "/images/create")
    if (!res.body) throw new DockerError("pull returned no body")

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let partial = ""
    let lastError: string | null = null

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      partial += decoder.decode(value, { stream: true })
      const lines = partial.split("\n")
      partial = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.trim()) continue
        const parsed = parseProgress(line)
        if (parsed.error) lastError = parsed.error
        if (parsed.text) onProgress(parsed.text)
      }
    }

    // The Engine reports pull failures inside the 200 stream, not as a status.
    if (lastError) throw new DockerError(`pull failed: ${lastError}`)
  }

  async imageExists(ref: string): Promise<boolean> {
    assertValidImageRef(ref)
    const res = await this.request(`/images/${encodeURIComponent(ref)}/json`)
    await res.arrayBuffer().catch(() => undefined)
    return res.ok
  }

  async removeImage(ref: string, force = false): Promise<void> {
    assertValidImageRef(ref)
    const res = await this.request(
      `/images/${encodeURIComponent(ref)}?force=${force}`,
      { method: "DELETE" },
    )
    if (!res.ok && res.status !== 404) {
      throw await this.toError(res, "/images/delete")
    }
    await res.arrayBuffer().catch(() => undefined)
  }

  async pruneImages(
    olderThanHours: number,
  ): Promise<{ reclaimedBytes: number }> {
    // Filter values are string arrays in the Engine API; the {value: bool} map
    // form is rejected as "invalid filter".
    // "until" prunes by age; dangling=false widens it to unreferenced images.
    const filters = encodeURIComponent(
      JSON.stringify({
        until: [`${olderThanHours}h`],
        dangling: ["false"],
      }),
    )
    const res = await this.json<{ SpaceReclaimed?: number }>(
      `/images/prune?filters=${filters}`,
      { method: "POST" },
    )
    return { reclaimedBytes: res.SpaceReclaimed ?? 0 }
  }

  // ------------------------------------------------------------- containers

  async createContainer(spec: ContainerSpec): Promise<string> {
    assertValidImageRef(spec.image)
    if (spec.memoryLimitBytes <= 0) {
      throw new DockerError("memoryLimitBytes must be positive")
    }

    const primary = spec.networks[0]
    const body = {
      Image: spec.image,
      // TTY must stay off: with a TTY the Engine stops framing the log stream
      // and the demultiplexer would receive raw bytes.
      Tty: false,
      Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
      Labels: spec.labels,
      HostConfig: {
        Memory: spec.memoryLimitBytes,
        // Matching the memory limit disables swap, so a leaking app cannot
        // escape its cap by swapping.
        MemorySwap: spec.memoryLimitBytes,
        ...(spec.cpuShares ? { CpuShares: spec.cpuShares } : {}),
        RestartPolicy: { Name: spec.restartPolicy },
        Binds: spec.volumes.map((v) => `${v.name}:${v.mountPath}`),
        LogConfig: {
          Type: "json-file",
          // Bound the per-container log file: disk is the other budget.
          Config: { "max-size": "10m", "max-file": "2" },
        },
      },
      ...(primary
        ? { NetworkingConfig: { EndpointsConfig: { [primary]: {} } } }
        : {}),
      ...(spec.healthcheck
        ? {
            Healthcheck: {
              Test: spec.healthcheck.test,
              Interval: spec.healthcheck.intervalSec * 1_000_000_000,
              Timeout: spec.healthcheck.timeoutSec * 1_000_000_000,
              Retries: spec.healthcheck.retries,
              StartPeriod: spec.healthcheck.startPeriodSec * 1_000_000_000,
            },
          }
        : {}),
    }

    const created = await this.json<{ Id: string; Warnings?: string[] }>(
      `/containers/create?name=${encodeURIComponent(spec.name)}`,
      this.postJson(body),
    )
    if (created.Warnings?.length) {
      logger.warn(
        { container: spec.name, warnings: created.Warnings },
        "docker create warnings",
      )
    }

    // Attach any additional networks beyond the first.
    for (const net of spec.networks.slice(1)) {
      await this.expectOk(
        `/networks/${encodeURIComponent(net)}/connect`,
        this.postJson({ Container: created.Id }),
      )
    }
    return created.Id
  }

  async startContainer(id: string): Promise<void> {
    const res = await this.request(
      `/containers/${encodeURIComponent(id)}/start`,
      { method: "POST" },
    )
    // 304 means already started, which is success for our purposes.
    if (!res.ok && res.status !== 304) {
      throw await this.toError(res, "/containers/start")
    }
    await res.arrayBuffer().catch(() => undefined)
  }

  async stopContainer(id: string, timeoutSec = 10): Promise<void> {
    const res = await this.request(
      `/containers/${encodeURIComponent(id)}/stop?t=${timeoutSec}`,
      { method: "POST" },
    )
    if (!res.ok && res.status !== 304 && res.status !== 404) {
      throw await this.toError(res, "/containers/stop")
    }
    await res.arrayBuffer().catch(() => undefined)
  }

  async removeContainer(id: string, force = false): Promise<void> {
    const res = await this.request(
      `/containers/${encodeURIComponent(id)}?force=${force}&v=true`,
      { method: "DELETE" },
    )
    if (!res.ok && res.status !== 404) {
      throw await this.toError(res, "/containers/remove")
    }
    await res.arrayBuffer().catch(() => undefined)
  }

  async inspectContainer(id: string): Promise<ContainerState> {
    const raw = await this.json<InspectResponse>(
      `/containers/${encodeURIComponent(id)}/json`,
    )
    const health = (raw.State.Health?.Status ?? "none") as HealthState
    const networks = raw.NetworkSettings?.Networks ?? {}
    const ip =
      networks[config.network]?.IPAddress ||
      Object.values(networks).find((n) => n.IPAddress)?.IPAddress ||
      null

    return {
      id: raw.Id,
      running: raw.State.Running,
      health: ["healthy", "unhealthy", "starting"].includes(health)
        ? health
        : "none",
      exitCode: raw.State.Running ? null : raw.State.ExitCode,
      startedAt: raw.State.StartedAt ?? null,
      restartCount: raw.RestartCount ?? 0,
      ipAddress: ip,
    }
  }

  async listManagedContainers(): Promise<ManagedContainer[]> {
    // Filter server-side: the reconciler calls this every 30 seconds and should
    // not pull every container on the host across the socket.
    const filters = encodeURIComponent(
      JSON.stringify({ label: [`${LABEL_MANAGED}=true`] }),
    )
    const list = await this.json<ContainerListItem[]>(
      `/containers/json?all=true&filters=${filters}`,
    )
    return list.map((c) => ({
      id: c.Id,
      name: (c.Names[0] ?? "").replace(/^\//, ""),
      image: c.Image,
      running: c.State === "running",
      labels: c.Labels ?? {},
      createdAt: c.Created,
    }))
  }

  // ------------------------------------------------------------------- logs

  /**
   * Follows a container's logs as an async iterable.
   *
   * The caller breaking out of the loop must actually close the socket, or
   * every closed browser tab leaks a connection and its buffers. The spike
   * confirmed AbortController does release it, so the generator aborts in its
   * `finally` — which runs on `break` as well as on normal completion.
   */
  async *streamLogs(id: string, opts: LogOpts): AsyncIterable<LogLine> {
    const params = new URLSearchParams({
      stdout: "1",
      stderr: "1",
      timestamps: "1",
      follow: opts.follow ? "1" : "0",
      tail: String(opts.tail),
    })
    if (opts.since !== undefined) params.set("since", String(opts.since))

    const controller = new AbortController()
    const onExternalAbort = () => controller.abort()
    opts.signal?.addEventListener("abort", onExternalAbort, { once: true })

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const res = await this.request(
        `/containers/${encodeURIComponent(id)}/logs?${params}`,
        { signal: controller.signal },
      )
      if (!res.ok) throw await this.toError(res, "/containers/logs")
      if (!res.body) return

      reader = res.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
      const demux = createDemuxer()
      const lines = createLineAssembler()

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        for (const frame of demux.push(value)) {
          for (const line of lines.push(frame)) {
            yield splitTimestamp(line.stream, line.text)
          }
        }
      }
      for (const line of lines.flush()) {
        yield splitTimestamp(line.stream, line.text)
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") throw err
    } finally {
      opts.signal?.removeEventListener("abort", onExternalAbort)
      controller.abort()
      await reader?.cancel().catch(() => undefined)
    }
  }

  // --------------------------------------------------------- networks/volumes

  async ensureNetwork(name: string): Promise<void> {
    const res = await this.request(`/networks/${encodeURIComponent(name)}`)
    await res.arrayBuffer().catch(() => undefined)
    if (res.ok) return

    const create = await this.request(
      "/networks/create",
      this.postJson({ Name: name, Driver: "bridge", CheckDuplicate: true }),
    )
    // 409 means another caller created it first, which is fine.
    if (!create.ok && create.status !== 409) {
      throw await this.toError(create, "/networks/create")
    }
    await create.arrayBuffer().catch(() => undefined)
  }

  async createVolume(name: string): Promise<void> {
    await this.expectOk("/volumes/create", this.postJson({ Name: name }))
  }

  async removeVolume(name: string): Promise<void> {
    const res = await this.request(
      `/volumes/${encodeURIComponent(name)}?force=true`,
      { method: "DELETE" },
    )
    if (!res.ok && res.status !== 404) {
      throw await this.toError(res, "/volumes/remove")
    }
    await res.arrayBuffer().catch(() => undefined)
  }
}

// ------------------------------------------------------------------ helpers

interface InspectResponse {
  Id: string
  RestartCount?: number
  State: {
    Running: boolean
    ExitCode: number
    StartedAt?: string
    Health?: { Status: string }
  }
  NetworkSettings?: { Networks: Record<string, { IPAddress: string }> }
}

interface ContainerListItem {
  Id: string
  Names: string[]
  Image: string
  State: string
  Labels?: Record<string, string>
  Created: number
}

function splitRef(ref: string): { name: string; tag: string } {
  if (ref.includes("@")) {
    const [name = ref, digest = ""] = ref.split("@")
    return { name, tag: digest }
  }
  const slash = ref.lastIndexOf("/")
  const colon = ref.lastIndexOf(":")
  if (colon > slash) {
    return { name: ref.slice(0, colon), tag: ref.slice(colon + 1) }
  }
  return { name: ref, tag: "latest" }
}

interface ProgressLine {
  status?: string
  id?: string
  progress?: string
  error?: string
}

function parseProgress(line: string): { text: string; error: string | null } {
  try {
    const p = JSON.parse(line) as ProgressLine
    if (p.error) return { text: `error: ${p.error}`, error: p.error }
    const parts = [p.status, p.id, p.progress].filter(Boolean)
    return { text: parts.join(" "), error: null }
  } catch {
    return { text: line, error: null }
  }
}

/** Docker prefixes each line with an RFC3339 timestamp when timestamps=1. */
function splitTimestamp(stream: "stdout" | "stderr", raw: string): LogLine {
  const space = raw.indexOf(" ")
  if (space > 0) {
    const maybeTs = raw.slice(0, space)
    if (/^\d{4}-\d{2}-\d{2}T/.test(maybeTs)) {
      return { stream, timestamp: maybeTs, text: raw.slice(space + 1) }
    }
  }
  return { stream, timestamp: new Date().toISOString(), text: raw }
}

export const docker: DockerClient = new DockerHttpClient()
