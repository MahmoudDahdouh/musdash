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
  LABEL_ROLE,
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

/** What a failing request was about, so a 404 can be reported accurately. */
type ErrorSubject = { kind: "image"; ref: string }

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

  private async toError(
    res: Response,
    path: string,
    subject?: ErrorSubject,
  ): Promise<DockerError> {
    let detail = ""
    try {
      const body = (await res.json()) as EngineErrorBody
      detail = body.message ?? ""
    } catch {
      detail = await res.text().catch(() => "")
    }
    if (res.status === 404) {
      // A 404 on an image path is not a missing container, and saying so
      // produced "container /images/create not found" in the user's deploy log.
      // Decide by path, and name the reference the user actually typed. This
      // message is shown to them, so it carries no socket path or API version.
      if (subject?.kind === "image") {
        return new DockerError(
          `image ${subject.ref} not found in any configured registry`,
          404,
        )
      }
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
    if (!res.ok) {
      throw await this.toError(res, "/images/create", {
        kind: "image",
        ref,
      })
    }
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

  /**
   * Streams a docker-format tar into the Engine's image store.
   *
   * The body is passed straight through as a stream — never buffered — because
   * an image tar is routinely hundreds of megabytes and holding one resident
   * would breach the RAM budget on its own.
   *
   * Like /images/create, this reports failure INSIDE a 200 response rather than
   * as a status code, so the NDJSON body has to be read to completion and
   * inspected. Returning on `res.ok` alone would report a failed load as a
   * success and leave the caller deploying an image that does not exist.
   */
  async loadImage(tar: ReadableStream<Uint8Array>): Promise<void> {
    const res = await this.request("/images/load?quiet=0", {
      method: "POST",
      headers: { "content-type": "application/x-tar" },
      body: tar,
      // Required by fetch whenever a stream is the body: without it the request
      // is rejected before it reaches the socket.
      duplex: "half",
    } as RequestInit)
    if (!res.ok) throw await this.toError(res, "/images/load")

    const body = await res.text()
    let loaded: string | null = null
    let lastError: string | null = null
    for (const line of body.split("\n")) {
      if (!line.trim()) continue
      // /images/load reports through a `stream` field, unlike /images/create
      // which uses `status`. parseProgress knows only the latter and returns
      // an empty string here, so this endpoint is parsed on its own terms.
      let parsed: { stream?: unknown; error?: unknown }
      try {
        parsed = JSON.parse(line) as { stream?: unknown; error?: unknown }
      } catch {
        continue
      }
      if (typeof parsed.error === "string") lastError = parsed.error
      if (
        typeof parsed.stream === "string" &&
        parsed.stream.includes("Loaded image")
      ) {
        loaded = parsed.stream.trim()
      }
    }

    if (lastError) throw new DockerError(`image load failed: ${lastError}`)
    if (!loaded) {
      throw new DockerError(
        "image load reported no loaded image; the tar was not in docker format",
      )
    }
    logger.debug({ loaded }, "loaded image from tar")
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
      throw await this.toError(res, "/images/delete", { kind: "image", ref })
    }
    await res.arrayBuffer().catch(() => undefined)
  }

  /**
   * Two passes, because the Engine cannot express "prune everything except
   * these".
   *
   * `POST /images/prune` only accepts `dangling`, `until`, `label` and
   * `label!`; a `reference` filter is rejected outright with
   * `invalid filter 'reference'`, and `label!` is useless here because mosdash
   * does not build (and therefore cannot label) the images it deploys. A blanket
   * `dangling:false` prune would happily delete a rollback target, which is
   * referenced only by a row in the database and is invisible to Docker.
   *
   * So: pass one prunes DANGLING images only — an untagged image can never be a
   * rollback target, since a target is named by a tag. Pass two enumerates
   * tagged images and removes them one at a time, skipping anything protected,
   * young, or in use.
   */
  async pruneImages(
    olderThanHours: number,
    keep: string[],
  ): Promise<{ reclaimedBytes: number; protectedCount: number }> {
    // Filter values are string arrays in the Engine API; the {value: bool} map
    // form is rejected as "invalid filter".
    const filters = encodeURIComponent(
      JSON.stringify({
        until: [`${olderThanHours}h`],
        dangling: ["true"],
      }),
    )
    const pruned = await this.json<{ SpaceReclaimed?: number }>(
      `/images/prune?filters=${filters}`,
      { method: "POST" },
    )
    let reclaimedBytes = pruned.SpaceReclaimed ?? 0

    const keepSet = new Set(keep)
    const images = await this.json<ImageListItem[]>("/images/json")
    const containers = await this.json<ContainerListItem[]>(
      "/containers/json?all=true",
    )
    // A container reports its image as a resolved ID and, separately, as
    // whatever reference it was created from. Collect both: matching on only
    // one would let a live container's image be removed out from under it.
    const inUse = new Set<string>()
    for (const c of containers) {
      if (c.ImageID) inUse.add(c.ImageID)
      if (c.Image) inUse.add(c.Image)
    }

    const cutoffSec = Math.floor(Date.now() / 1000) - olderThanHours * 3600
    let protectedCount = 0

    for (const img of images) {
      const tags = img.RepoTags ?? []
      if (tags.length === 0) continue // dangling; pass one already handled it

      // One image ID can carry several tags, and removing by a single tag only
      // UNTAGS it. So an image is protected if ANY of its tags is protected,
      // and it must be removed by every tag before its bytes come back.
      if (tags.some((t) => keepSet.has(t))) {
        protectedCount++
        continue
      }
      if (img.Created > cutoffSec) continue
      if (inUse.has(img.Id) || tags.some((t) => inUse.has(t))) continue

      // Sequential on purpose: job concurrency is exactly 1, and parallel
      // removals are the memory spike that invariant exists to prevent.
      let removedAll = true
      for (const tag of tags) {
        try {
          await this.removeImage(tag, false)
        } catch (err) {
          // 409 means something still references it. Not an error — skip on.
          if ((err as DockerError).status !== 409) {
            logger.warn(
              { image: tag, err: (err as Error).message },
              "could not remove image",
            )
          }
          removedAll = false
        }
      }
      // Count the image's size once, not once per tag, or the reported figure
      // overstates what was actually freed.
      if (removedAll) reclaimedBytes += img.Size ?? 0
    }

    return { reclaimedBytes, protectedCount }
  }

  // ------------------------------------------------------------- containers

  async createContainer(spec: ContainerSpec): Promise<string> {
    assertValidImageRef(spec.image)
    if (spec.memoryLimitBytes <= 0) {
      throw new DockerError("memoryLimitBytes must be positive")
    }

    // A privileged container is root on the host. The only legitimate caller is
    // mosdash's own build sidecar, which is identified by the role label that
    // sidecarLabels() sets and that no resource-derived spec ever carries. This
    // is enforced here rather than trusted to callers: the check is one line,
    // and the failure it prevents is a user obtaining root on the box.
    if (spec.privileged === true && spec.labels[LABEL_ROLE] === undefined) {
      throw new DockerError(
        "refusing to create a privileged container without a mosdash.role label: " +
          "privileged mode is reserved for mosdash's own infrastructure",
      )
    }

    const primary = spec.networks[0]

    // Publishing a port needs BOTH halves. PortBindings alone is silently
    // ignored unless the port is also declared in ExposedPorts, and the
    // container then comes up with nothing listening on the host.
    const exposedPorts: Record<string, Record<string, never>> = {}
    const portBindings: Record<string, { HostIp: string; HostPort: string }[]> =
      {}
    for (const p of spec.ports ?? []) {
      const key = `${p.containerPort}/${p.protocol}`
      exposedPorts[key] = {}
      // An array, because one container port can be published on several host
      // addresses.
      const bindings = portBindings[key] ?? []
      bindings.push({ HostIp: p.hostIp, HostPort: String(p.hostPort) })
      portBindings[key] = bindings
    }
    const hasPorts = spec.ports !== undefined && spec.ports.length > 0

    const body = {
      Image: spec.image,
      // TTY must stay off: with a TTY the Engine stops framing the log stream
      // and the demultiplexer would receive raw bytes.
      Tty: false,
      Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
      Labels: spec.labels,
      ...(spec.command ? { Cmd: spec.command } : {}),
      ...(hasPorts ? { ExposedPorts: exposedPorts } : {}),
      HostConfig: {
        ...(hasPorts ? { PortBindings: portBindings } : {}),
        Memory: spec.memoryLimitBytes,
        // Matching the memory limit disables swap, so a leaking app cannot
        // escape its cap by swapping.
        MemorySwap: spec.memoryLimitBytes,
        ...(spec.cpuShares ? { CpuShares: spec.cpuShares } : {}),
        ...(spec.privileged === true ? { Privileged: true } : {}),
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

    const res = await this.request(
      `/containers/create?name=${encodeURIComponent(spec.name)}`,
      this.postJson(body),
    )

    // 409 means the name is already taken. For a singleton container that is
    // created once and thereafter adopted, that is the normal outcome of a
    // concurrent or repeated bootstrap, not a failure: resolve the existing
    // container and let the caller carry on with it. Deploy container names
    // embed a deployment id, so this path is unreachable for them.
    if (res.status === 409) {
      // Build the error before consuming the body: toError reads it, and a
      // drained response would strip the Engine's explanation from the message
      // if discovery then comes back empty.
      const conflict = await this.toError(res, "/containers/create")
      const existing = await this.findContainersByName(spec.name)
      const first = existing[0]
      if (!first) throw conflict
      logger.info(
        { container: spec.name, id: first.id },
        "container already exists; using it",
      )
      return first.id
    }
    if (!res.ok) throw await this.toError(res, "/containers/create")

    const created = (await res.json()) as { Id: string; Warnings?: string[] }
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
      // Count only mappings the Engine actually programmed: a port it could not
      // bind is present as a key with a null value, not absent.
      publishedPortCount: Object.values(
        raw.NetworkSettings?.Ports ?? {},
      ).filter((bindings) => bindings !== null && bindings.length > 0).length,
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
    return list.map(toManagedContainer)
  }

  async findContainersByName(name: string): Promise<ManagedContainer[]> {
    const filters = encodeURIComponent(JSON.stringify({ name: [name] }))
    const list = await this.json<ContainerListItem[]>(
      `/containers/json?all=true&filters=${filters}`,
    )
    // The Engine's name filter is a SUBSTRING match, verified against a real
    // daemon: filtering on "caddy" also returns "/mosdash-caddy". Adopting or
    // deleting on that basis would act on the wrong container, so the match is
    // narrowed to an exact name here. A container can carry several names, so
    // every one is checked.
    return list
      .filter((c) => (c.Names ?? []).some((n) => n.replace(/^\//, "") === name))
      .map(toManagedContainer)
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
  NetworkSettings?: {
    Networks: Record<string, { IPAddress: string }>
    /** null for a declared-but-unprogrammed mapping, hence the nullable value. */
    Ports?: Record<string, { HostPort: string }[] | null>
  }
}

interface ContainerListItem {
  Id: string
  Names: string[]
  Image: string
  /** The resolved image ID; `Image` may be a tag or an ID depending on how the
   *  container was created, so both are needed to decide "is this in use". */
  ImageID?: string
  State: string
  Labels?: Record<string, string>
  Created: number
}

function toManagedContainer(c: ContainerListItem): ManagedContainer {
  return {
    id: c.Id,
    name: (c.Names[0] ?? "").replace(/^\//, ""),
    image: c.Image,
    running: c.State === "running",
    labels: c.Labels ?? {},
    createdAt: c.Created,
  }
}

interface ImageListItem {
  Id: string
  /** Absent or empty for a dangling image; several entries for a multi-tagged one. */
  RepoTags?: string[]
  Size?: number
  /** Unix seconds. */
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
