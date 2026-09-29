/**
 * Shapes shared by the Compose pipeline (docs/PHASE-3-PLAN.md §3.2). The
 * modules beside this one are pure: no Docker, database, logger or config.
 */

/**
 * Why a Compose file was refused. Each code is one sentence in an Eta partial
 * (the UI-Builder's), so a code here says which rule fired and nothing more.
 */
export type RefusalCode =
  // prescan: the raw YAML, before `docker compose config` may read host files
  | "too-large"
  | "yaml-invalid"
  | "not-a-mapping"
  | "no-services"
  | "service-not-a-mapping"
  | "include"
  | "extends-file"
  | "env-file"
  | "file-config"
  | "file-secret"
  | "build"
  | "no-image"
  | "external-secret"
  // model: Compose's own normalised output, which is authoritative
  | "privileged"
  | "network-mode"
  | "namespace-host"
  | "bind-mount"
  | "docker-socket"
  | "volume-external"
  | "volume-name"
  | "volume-driver"
  | "network-external"
  | "network-name"
  | "network-driver"
  | "network-reserved"
  | "cap-add"
  | "devices"
  | "gpus"
  | "runtime"
  | "cgroup-parent"
  | "security-opt"
  | "oom"
  | "memory-unlimited"
  | "memswap"
  | "ports"
  | "container-name"
  | "replicas"
  | "volumes-from-container"
  | "reserved-label"
  | "logging-driver"
  | "image-invalid"
  | "external-links"
  | "routed-unknown"
  | "routed-network-mode"
  // both: a key no one has reviewed; `field` is its path, e.g. "label_file"
  | "unsupported-key"
  // model: a network that picks its own subnet, gateway or IPAM driver
  | "network-ipam"

export interface Refusal {
  code: RefusalCode
  /** The service the rule fired on, or null for the file or a top-level key. */
  service: string | null
  /**
   * Where in the service or file, e.g. `security_opt`, `volumes[2]`,
   * `volumes.caddy`. Keys and indexes only — NEVER a value: a value may be a
   * secret the user pasted, and this string reaches the page and the deploy log.
   */
  field: string | null
}

/** `resources.source_json` for a compose resource (§3.1). */
export interface ComposeSource {
  /** The user's YAML exactly as pasted or templated; at most 128 KiB. */
  composeFile: string
  origin: "paste" | "template"
  templateId?: string
  templateVersion?: string
  /** Service names from the last successful normalisation. */
  services: string[]
  /** The service the auto domain routes to. */
  publicService: string | null
  /** The container port of publicService that Caddy dials; null with it. */
  publicPort: number | null
}

/** A `${NAME}` or `$NAME` the file interpolates. */
export interface Reference {
  name: string
  /** True only when every use of the name carries a `-`/`+` form default. */
  hasDefault: boolean
}
