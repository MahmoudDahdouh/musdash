import { isValidImageRef } from "../docker/client.ts"
import type { Refusal, RefusalCode } from "./types.ts"

/**
 * Stage D of the Compose pipeline (docs/PHASE-3-PLAN.md §3.2, §3.3): the
 * authoritative check, run on `docker compose config --format json` output
 * rather than on the user's YAML.
 *
 * Compose has already resolved anchors, `extends`, short syntax, interpolation
 * and profiles by the time this runs (D65 item 1), so every rule below is a
 * field comparison on one shape. Checking the raw YAML instead would mean
 * recognising every spelling of a bind mount, and one missed spelling is a
 * host path inside a container — in a process that holds the Docker socket.
 *
 * Refuse, never strip (DECISIONS: Compose): a file that asks for something
 * dangerous is rejected whole with a line per rule, so what runs is always
 * exactly what the user wrote.
 *
 * Pure: no Docker, database, logger or config. The input is untrusted, so it
 * is `unknown` and every field is narrowed before it is read; this never
 * throws. A Refusal names keys and indexes only, never a value — values can
 * be secrets, and refusals reach the page and the deploy log.
 */

export interface ValidateContext {
  /** The Compose project name, `musdash-<resourceId lowercased>`. */
  project: string
  /** Services that will get a domain, and so join the shared network. */
  routedServices: readonly string[]
}

/**
 * A service name that can carry a domain. Compose accepts `[a-zA-Z0-9._-]`,
 * but a routed service's name becomes part of a hostname — Caddy dials
 * `musdash-<resource>-<service>-1` by name on the shared network (D48) — and
 * `_`, `.` and capitals do not survive as a DNS label (D66). The 26 cap
 * keeps that name inside one 63-byte label: 8 + a 26-char id + 1 + 26 + 2.
 */
export const ROUTABLE_SERVICE_RE = /^[a-z0-9-]{1,26}$/

export function isRoutableServiceName(name: string): boolean {
  return ROUTABLE_SERVICE_RE.test(name)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Present in the model: Compose writes `null` for some unset keys. */
export function present(value: unknown): boolean {
  return value !== undefined && value !== null
}

/** Asks for something: a non-empty list, map or string, or any other value. */
export function nonEmpty(value: unknown): boolean {
  if (!present(value)) return false
  if (Array.isArray(value)) return value.length > 0
  if (isRecord(value)) return Object.keys(value).length > 0
  if (typeof value === "string") return value.length > 0
  return true
}

/** An integer from Compose's output: a number, or a string of digits. */
export function parseInteger(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? value : null
  }
  if (typeof value === "string" && /^-?\d{1,16}$/.test(value)) {
    return Number(value)
  }
  return null
}

function lower(value: unknown): string | null {
  return typeof value === "string" ? value.toLowerCase() : null
}

const DOCKER_SOCKETS = new Set(["/var/run/docker.sock", "/run/docker.sock"])

/**
 * Whether a mount path is the Docker socket. Doubled and trailing slashes are
 * folded first, since the kernel resolves `/var/run//docker.sock/` to the
 * same socket.
 */
export function isDockerSocketPath(path: unknown): boolean {
  if (typeof path !== "string") return false
  const folded = path.replace(/\/{2,}/g, "/").replace(/(.)\/$/, "$1")
  return DOCKER_SOCKETS.has(folded)
}

/**
 * `network_mode` values that stay inside the stack: none, or another service
 * of this same file. Everything else — host, bridge, `container:<name>`, a
 * network name — reaches outside it.
 */
export function networkModeAllowed(
  mode: unknown,
  services: ReadonlySet<string>,
): boolean {
  if (!present(mode)) return true
  if (mode === "none") return true
  if (typeof mode !== "string" || !mode.startsWith("service:")) return false
  return services.has(mode.slice("service:".length))
}

function compareNullable(a: string | null, b: string | null): number {
  if (a === b) return 0
  if (a === null) return -1
  if (b === null) return 1
  return a < b ? -1 : 1
}

/**
 * Deduplicated and ordered by service (file-level first), then field, then
 * code, so the same file always yields the same lines in the same order.
 */
export function sortRefusals(refusals: readonly Refusal[]): Refusal[] {
  const seen = new Set<string>()
  const out: Refusal[] = []
  for (const r of refusals) {
    const key = JSON.stringify([r.code, r.service, r.field])
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  return out.sort(
    (a, b) =>
      compareNullable(a.service, b.service) ||
      compareNullable(a.field, b.field) ||
      compareNullable(a.code, b.code),
  )
}

type Add = (code: RefusalCode, field: string | null) => void

// ---------------------------------------------------------------------------
// Key allowlists
// ---------------------------------------------------------------------------

/**
 * Every key the file may use, level by level. An allowlist, not a denylist,
 * because `docker compose config` runs as root and some keys make it READ A
 * HOST FILE: `env_file`, `include`, `extends.file`, file-backed configs and
 * secrets — and `label_file`, which on the VPS put `/root/x.env` into the
 * output as labels and leaked fragments of `/etc/shadow` into Compose's
 * warnings. Each Compose release can add another; a key nobody has reviewed
 * is refused until someone has.
 *
 * Dangerous keys that are KNOWN stay on the list so the user gets their own
 * sentence (`privileged` → "privileged", not "unsupported key"); the rules
 * further down refuse them. The same lists run on the raw YAML (prescan,
 * before `config` can read anything) and on the normalised model.
 */
const TOP_LEVEL_KEYS = new Set([
  "services",
  "volumes",
  "networks",
  "configs",
  "secrets",
  "name",
  "version",
])

/** Top-level keys that have a sentence of their own. */
const TOP_LEVEL_CODES = new Map<string, RefusalCode>([["include", "include"]])

const SERVICE_KEYS = new Set([
  "annotations",
  "attach",
  "cap_add",
  "cap_drop",
  "cgroup",
  "cgroup_parent",
  "command",
  "configs",
  "container_name",
  "cpu_count",
  "cpu_percent",
  "cpu_period",
  "cpu_quota",
  "cpu_rt_period",
  "cpu_rt_runtime",
  "cpu_shares",
  "cpus",
  "cpuset",
  "depends_on",
  "deploy",
  "device_cgroup_rules",
  "devices",
  "dns",
  "dns_opt",
  "dns_search",
  "domainname",
  "entrypoint",
  "environment",
  "expose",
  "extends",
  "external_links",
  "extra_hosts",
  "gpus",
  "group_add",
  "healthcheck",
  "hostname",
  "image",
  "init",
  "ipc",
  "labels",
  "links",
  "logging",
  "mac_address",
  "mem_limit",
  "mem_reservation",
  "mem_swappiness",
  "memswap_limit",
  "network_mode",
  "networks",
  "oom_kill_disable",
  "oom_score_adj",
  "pid",
  "pids_limit",
  "platform",
  "ports",
  "post_start",
  "pre_stop",
  "privileged",
  "profiles",
  "pull_policy",
  "read_only",
  "restart",
  "runtime",
  "scale",
  "secrets",
  "security_opt",
  "shm_size",
  "stdin_open",
  "stop_grace_period",
  "stop_signal",
  "sysctls",
  "tmpfs",
  "tty",
  "ulimits",
  "user",
  "userns_mode",
  "uts",
  "volumes",
  "volumes_from",
  "working_dir",
])

/** Service keys refused with a sentence of their own. */
const SERVICE_CODES = new Map<string, RefusalCode>([
  ["env_file", "env-file"],
  ["build", "build"],
])

const EXTENDS_KEYS = new Set(["service"])

/** `file` and `external` are allowed here and refused by their own rules. */
const CONFIG_SECRET_KEYS = new Set([
  "content",
  "environment",
  "name",
  "labels",
  "template_driver",
  "external",
  "file",
])

const NESTED_KEYS: readonly [section: string, keys: ReadonlySet<string>][] = [
  ["configs", CONFIG_SECRET_KEYS],
  ["secrets", CONFIG_SECRET_KEYS],
  ["volumes", new Set(["driver", "driver_opts", "labels", "name", "external"])],
  [
    "networks",
    new Set([
      "driver",
      "driver_opts",
      "labels",
      "name",
      "external",
      "internal",
      "attachable",
      "enable_ipv6",
      "enable_ipv4",
      "ipam",
    ]),
  ],
]

function isExtension(key: string): boolean {
  return key.startsWith("x-")
}

/** Top-level keys, and the keys of each declared config, secret, volume and network. */
export function checkTopLevelKeys(
  doc: Record<string, unknown>,
  add: (code: RefusalCode, field: string) => void,
): void {
  for (const key of Object.keys(doc)) {
    if (isExtension(key) || TOP_LEVEL_KEYS.has(key)) continue
    add(TOP_LEVEL_CODES.get(key) ?? "unsupported-key", key)
  }
  for (const [section, allowed] of NESTED_KEYS) {
    const entries = doc[section]
    if (!isRecord(entries)) continue
    for (const [name, value] of Object.entries(entries)) {
      if (!isRecord(value)) continue
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
          add("unsupported-key", `${section}.${name}.${key}`)
        }
      }
    }
  }
}

/** A service's keys, and those of an `extends` mapping. */
export function checkServiceKeys(svc: Record<string, unknown>, add: Add): void {
  for (const key of Object.keys(svc)) {
    if (isExtension(key) || SERVICE_KEYS.has(key)) continue
    add(SERVICE_CODES.get(key) ?? "unsupported-key", key)
  }
  const ext = svc.extends
  if (!isRecord(ext)) return
  for (const key of Object.keys(ext)) {
    if (EXTENDS_KEYS.has(key)) continue
    add(key === "file" ? "extends-file" : "unsupported-key", `extends.${key}`)
  }
}

// ---------------------------------------------------------------------------
// Service rules
// ---------------------------------------------------------------------------

const NAMESPACE_KEYS = ["pid", "ipc", "uts", "userns_mode", "cgroup"] as const

function checkNamespaces(svc: Record<string, unknown>, add: Add): void {
  for (const key of NAMESPACE_KEYS) {
    const value = lower(svc[key])
    if (value === null) continue
    const joinsOther =
      (key === "pid" || key === "ipc") && value.startsWith("container:")
    if (value === "host" || joinsOther) add("namespace-host", key)
  }
}

/**
 * Mount types that cannot name a host path. `volume` is checked further
 * against the file's own volumes; anything not listed — bind, npipe, cluster,
 * or a type a later Compose adds — is refused as a host mount, because an
 * unknown type is exactly the spelling a denylist would miss.
 */
const SAFE_MOUNT_TYPES = new Set(["volume", "tmpfs", "image"])

function checkVolumes(
  svc: Record<string, unknown>,
  declared: ReadonlySet<string>,
  add: Add,
): void {
  const volumes = svc.volumes
  if (!present(volumes)) return
  if (!Array.isArray(volumes)) {
    add("bind-mount", "volumes")
    return
  }
  volumes.forEach((entry: unknown, i) => {
    const field = `volumes[${i}]`
    if (!isRecord(entry)) {
      add("bind-mount", field)
      return
    }
    // Checked first so the log names the real danger rather than "a bind
    // mount": the socket is root on the host whatever the mount type.
    if (isDockerSocketPath(entry.source) || isDockerSocketPath(entry.target)) {
      add("docker-socket", field)
      return
    }
    const type = entry.type
    if (typeof type !== "string" || !SAFE_MOUNT_TYPES.has(type)) {
      add("bind-mount", field)
      return
    }
    // An image mount pulls its source like `image:` does, so it meets the
    // same reference rule before anything can hand it to the Engine.
    if (
      type === "image" &&
      !(typeof entry.source === "string" && isValidImageRef(entry.source))
    ) {
      add("image-invalid", field)
      return
    }
    // A named volume must be one this file declares, which the top-level
    // checks below confine to this project. No source is an anonymous volume.
    if (
      type === "volume" &&
      present(entry.source) &&
      entry.source !== "" &&
      !(typeof entry.source === "string" && declared.has(entry.source))
    ) {
      add("volume-name", field)
    }
  })
}

/**
 * Memory must be limited (the invariant has no "unlimited") and swap must be
 * off (D38), which Docker expresses as memswap equal to the limit. Compose
 * writes both limits as strings of bytes (D65 item 1). A value that is not a
 * number of bytes cannot be shown to be a limit, so it is refused the same
 * way as `-1`.
 */
function checkMemory(svc: Record<string, unknown>, add: Add): void {
  const deploy = isRecord(svc.deploy) ? svc.deploy : {}
  const resources = isRecord(deploy.resources) ? deploy.resources : {}
  const limits = isRecord(resources.limits) ? resources.limits : {}

  let effective: number | null = null
  const sources: [unknown, string][] = [
    [svc.mem_limit, "mem_limit"],
    [limits.memory, "deploy.resources.limits.memory"],
  ]
  for (const [value, field] of sources) {
    if (!present(value)) continue
    const bytes = parseInteger(value)
    if (bytes === null || bytes <= 0) {
      add("memory-unlimited", field)
    } else {
      effective ??= bytes
    }
  }

  // With no limit set, the transform picks the default and overwrites this;
  // a memswap the user set without a limit never meant "equal to 512 MiB".
  if (present(svc.memswap_limit)) {
    const swap = parseInteger(svc.memswap_limit)
    if (effective === null || swap !== effective)
      add("memswap", "memswap_limit")
  }
}

/**
 * Only switches that tighten confinement, or name an LSM profile already
 * loaded on the host, pass. `unconfined` and `disable` turn seccomp, AppArmor
 * or SELinux off; `seccomp=<file>` loads a profile from a host path, which
 * can allow every syscall and so is unconfined by another name. An SELinux
 * `label` option running as `spc_t` (the super-privileged container type) is
 * unconfined too.
 */
function securityOptRefused(entry: unknown): boolean {
  const value = lower(entry)
  if (value === null) return true
  return (
    value.includes("unconfined") ||
    value.includes("=disable") ||
    value.includes(":disable") ||
    value.startsWith("seccomp") ||
    (value.startsWith("label") &&
      (value.includes("spc_t") || value.includes("disable")))
  )
}

const RESERVED_LABEL_PREFIXES = ["musdash.", "com.docker.compose."]

function labelKeys(labels: unknown): string[] {
  if (isRecord(labels)) return Object.keys(labels)
  if (Array.isArray(labels)) {
    return labels
      .filter((l): l is string => typeof l === "string")
      .map((l) => l.split("=")[0] ?? "")
  }
  return []
}

/** Label keys musdash and Compose own; `prefix` is the field they sit under. */
function checkLabels(labels: unknown, prefix: string, add: Add): void {
  for (const key of labelKeys(labels)) {
    const k = key.toLowerCase()
    if (RESERVED_LABEL_PREFIXES.some((p) => k.startsWith(p))) {
      add("reserved-label", `${prefix}.${key}`)
    }
  }
}

function checkService(
  svc: Record<string, unknown>,
  names: ReadonlySet<string>,
  declaredVolumes: ReadonlySet<string>,
  add: Add,
): void {
  checkServiceKeys(svc, add)
  if (svc.privileged === true) add("privileged", "privileged")
  // Lifecycle hooks run inside the container, and may ask to run privileged.
  for (const hook of ["post_start", "pre_stop"]) {
    const entries = svc[hook]
    if (!Array.isArray(entries)) continue
    entries.forEach((h: unknown, i) => {
      if (isRecord(h) && h.privileged === true) {
        add("privileged", `${hook}[${i}]`)
      }
    })
  }

  if (!networkModeAllowed(svc.network_mode, names)) {
    add("network-mode", "network_mode")
  }
  checkNamespaces(svc, add)
  checkVolumes(svc, declaredVolumes, add)

  if (nonEmpty(svc.cap_add)) add("cap-add", "cap_add")
  if (nonEmpty(svc.devices)) add("devices", "devices")
  if (nonEmpty(svc.device_cgroup_rules)) add("devices", "device_cgroup_rules")
  if (present(svc.gpus)) add("gpus", "gpus")
  if (present(svc.runtime)) add("runtime", "runtime")
  if (present(svc.cgroup_parent)) add("cgroup-parent", "cgroup_parent")

  const deploy = isRecord(svc.deploy) ? svc.deploy : {}
  const resources = isRecord(deploy.resources) ? deploy.resources : {}
  const reservations = isRecord(resources.reservations)
    ? resources.reservations
    : {}
  // `deploy.resources.reservations.devices` is how Compose hands out GPUs
  // and other devices without the `devices` key.
  if (nonEmpty(reservations.devices)) {
    add("devices", "deploy.resources.reservations.devices")
  }

  const securityOpt = svc.security_opt
  if (Array.isArray(securityOpt)) {
    securityOpt.forEach((entry: unknown, i) => {
      if (securityOptRefused(entry)) add("security-opt", `security_opt[${i}]`)
    })
  } else if (present(securityOpt)) {
    add("security-opt", "security_opt")
  }

  if (svc.oom_kill_disable === true) add("oom", "oom_kill_disable")
  if (present(svc.oom_score_adj)) {
    const adj = parseInteger(svc.oom_score_adj)
    if (adj === null || adj < 0) add("oom", "oom_score_adj")
  }
  checkMemory(svc, add)

  if (nonEmpty(svc.ports)) add("ports", "ports")
  if (present(svc.container_name)) add("container-name", "container_name")
  const replicas = parseInteger(deploy.replicas)
  if (replicas !== null && replicas > 1) add("replicas", "deploy.replicas")
  const scale = parseInteger(svc.scale)
  if (scale !== null && scale > 1) add("replicas", "scale")

  const volumesFrom = svc.volumes_from
  if (Array.isArray(volumesFrom)) {
    volumesFrom.forEach((entry: unknown, i) => {
      if (typeof entry !== "string" || entry.startsWith("container:")) {
        add("volumes-from-container", `volumes_from[${i}]`)
      }
    })
  }
  if (nonEmpty(svc.external_links)) add("external-links", "external_links")
  checkLabels(svc.labels, "labels", add)

  const logging = isRecord(svc.logging) ? svc.logging : {}
  if (present(logging.driver) && logging.driver !== "json-file") {
    add("logging-driver", "logging.driver")
  }

  // The prescan refuses a service with no image, but `extends` can still
  // leave one without, and this check is the authority.
  if (!present(svc.image)) {
    add("no-image", "image")
  } else if (typeof svc.image !== "string" || !isValidImageRef(svc.image)) {
    add("image-invalid", "image")
  }
  // `build` and `env_file` are refused by checkServiceKeys with their codes.
}

/**
 * Top-level volumes and networks. Compose names them `<project>_<key>`; any
 * other name, or `external`, attaches something outside this stack — another
 * stack's data, or a sidecar's such as `musdash-caddy-data`. Driver options
 * are refused because the `local` driver's options can bind a host path.
 */
function checkTopLevel(
  model: Record<string, unknown>,
  project: string,
  push: (r: Refusal) => void,
): void {
  const add = (code: RefusalCode, field: string | null): void =>
    push({ code, service: null, field })
  checkTopLevelKeys(model, add)

  const volumes = isRecord(model.volumes) ? model.volumes : {}
  for (const [key, v] of Object.entries(volumes)) {
    const field = `volumes.${key}`
    const vol = isRecord(v) ? v : {}
    // The reconciler and the kept-volumes list find volumes by these labels.
    checkLabels(vol.labels, `${field}.labels`, add)
    if (vol.external === true || vol.external === "true") {
      add("volume-external", field)
    }
    if (vol.name !== `${project}_${key}`) add("volume-name", field)
    if (
      (present(vol.driver) && vol.driver !== "local") ||
      present(vol.driver_opts)
    ) {
      add("volume-driver", field)
    }
  }

  const networks = isRecord(model.networks) ? model.networks : {}
  for (const [key, n] of Object.entries(networks)) {
    const field = `networks.${key}`
    const net = isRecord(n) ? n : {}
    checkLabels(net.labels, `${field}.labels`, add)
    // A chosen subnet, gateway or IPAM driver can overlap the host's own
    // networks or the musdash network; Docker's pools pick safely. Compose
    // writes `ipam: {}` for every network it normalises.
    if (
      present(net.ipam) &&
      !(isRecord(net.ipam) && Object.keys(net.ipam).length === 0)
    ) {
      add("network-ipam", `${field}.ipam`)
    }
    // The transform adds a `musdash` key itself for routed services; a user
    // key of that name, or a network of that name, would be that one.
    if (key === "musdash" || net.name === "musdash") {
      add("network-reserved", field)
    }
    if (net.external === true || net.external === "true") {
      add("network-external", field)
    }
    if (net.name !== `${project}_${key}`) add("network-name", field)
    if (
      (present(net.driver) && net.driver !== "bridge") ||
      present(net.driver_opts)
    ) {
      add("network-driver", field)
    }
  }

  // The prescan refuses these before `config` can read the file; checked
  // again here so this function stands on its own.
  const configs = isRecord(model.configs) ? model.configs : {}
  for (const [key, c] of Object.entries(configs)) {
    if (isRecord(c) && present(c.file)) add("file-config", `configs.${key}`)
  }
  const secrets = isRecord(model.secrets) ? model.secrets : {}
  for (const [key, s] of Object.entries(secrets)) {
    if (!isRecord(s)) continue
    if (present(s.file)) add("file-secret", `secrets.${key}`)
    if (s.external === true || s.external === "true") {
      add("external-secret", `secrets.${key}`)
    }
  }
}

/**
 * Every rule of §3.3 against a normalised model. `[]` means the stack may be
 * transformed and deployed.
 */
export function validateModel(model: unknown, ctx: ValidateContext): Refusal[] {
  const noServices: Refusal[] = [
    { code: "no-services", service: null, field: "services" },
  ]
  if (!isRecord(model) || !isRecord(model.services)) return noServices
  const services = model.services
  const names = new Set(Object.keys(services))
  if (names.size === 0) return noServices

  const out: Refusal[] = []
  const push = (r: Refusal): void => {
    out.push(r)
  }
  const declaredVolumes = new Set(
    isRecord(model.volumes) ? Object.keys(model.volumes) : [],
  )

  for (const [name, svc] of Object.entries(services)) {
    if (!isRecord(svc)) {
      push({ code: "service-not-a-mapping", service: name, field: null })
      continue
    }
    checkService(svc, names, declaredVolumes, (code, field) =>
      push({ code, service: name, field }),
    )
  }
  checkTopLevel(model, ctx.project, push)

  for (const name of ctx.routedServices) {
    const svc = services[name]
    if (!(names.has(name) && isRecord(svc))) {
      push({ code: "routed-unknown", service: name, field: null })
      continue
    }
    // The forms refuse such a name; this is what stops one sent by hand.
    if (!isRoutableServiceName(name)) {
      push({ code: "routed-name", service: name, field: null })
    }
    if (present(svc.network_mode)) {
      // Caddy reaches a routed service over the shared network, which a
      // service in another's (or no) network namespace cannot join.
      push({
        code: "routed-network-mode",
        service: name,
        field: "network_mode",
      })
    }
  }

  return sortRefusals(out)
}
