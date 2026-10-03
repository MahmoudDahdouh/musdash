import type { Refusal, RefusalCode } from "./types.ts"

/**
 * One deploy-log sentence per refusal (docs/PHASE-3-PLAN.md §3.3).
 *
 * The line names the service and the field — keys and indexes the refusal
 * already carries — and nothing else. It never quotes a value: a refused
 * value may be a secret the user pasted, and this line is shown in the
 * browser and kept in the deploy log. The form-time wording of the same
 * rules is the UI's, in a template keyed by code.
 *
 * Pure.
 */

/** The fixed part of each sentence, after "<where>: ". */
function reason(code: RefusalCode): string {
  switch (code) {
    case "too-large":
      return "the Compose file is larger than 64 KiB"
    case "yaml-invalid":
      return "the Compose file is not valid YAML"
    case "not-a-mapping":
      return "the Compose file must be one YAML document with a services key"
    case "no-services":
      return "the Compose file defines no services"
    case "service-not-a-mapping":
      return "a service must be a mapping of settings"
    case "include":
      return "include is not supported, because it reads other files on this server"
    case "extends-file":
      return "extends with a file is not supported, because it reads another file on this server; extend a service in the same file instead"
    case "env-file":
      return "env_file is not supported, because it reads a file on this server; set the variables on the Variables tab and reference them in the file"
    case "file-config":
      return "a config read from a file is not supported, because it reads a file on this server; use content or environment instead"
    case "file-secret":
      return "a secret read from a file is not supported, because it reads a file on this server; use environment instead"
    case "external-secret":
      return "external secrets are not supported"
    case "build":
      return "build is not supported; build the image elsewhere and name it with image"
    case "no-image":
      return "every service needs an image"
    case "privileged":
      return "privileged mode is refused, because it gives the container root on the host"
    case "network-mode":
      return "this network_mode is refused, because it leaves the stack's own network; only none or service:<name> of this file is allowed"
    case "namespace-host":
      return "sharing a host namespace is refused, because it escapes the container"
    case "bind-mount":
      return "mounting a path from the host is refused; use a named volume declared in this file"
    case "docker-socket":
      return "mounting the Docker socket is refused, because it gives the container control of the host"
    case "volume-external":
      return "external volumes are refused, because they could attach another stack's data"
    case "volume-name":
      return "a volume must be one this file declares, without a custom name"
    case "volume-driver":
      return "volume drivers and driver options are refused, because they can mount a host path"
    case "network-external":
      return "external networks are refused, because they could join another stack's network"
    case "network-name":
      return "a network must not set a custom name"
    case "network-driver":
      return "network drivers other than bridge, and driver options, are refused"
    case "network-reserved":
      return "the network name musdash is reserved for musdash's own network"
    case "cap-add":
      return "adding capabilities is refused"
    case "devices":
      return "host devices are refused"
    case "gpus":
      return "GPUs are not supported"
    case "runtime":
      return "a custom runtime or provider is refused, because it runs a program on the host"
    case "cgroup-parent":
      return "cgroup_parent is refused"
    case "security-opt":
      return "this security option is refused, because it turns off the container's confinement"
    case "oom":
      return "turning off or lowering the out-of-memory killer is refused, because a leaking stack must not take down the server"
    case "memory-unlimited":
      return "the memory limit must be a positive size; there is no unlimited"
    case "memswap":
      return "memswap_limit must equal the memory limit, because swap stays off"
    case "ports":
      return "publishing ports is refused, because it bypasses the proxy and the firewall; use expose, and give the service a domain"
    case "container-name":
      return "container_name is refused, because container names are global on the server"
    case "replicas":
      return "more than one replica is not supported"
    case "volumes-from-container":
      return "volumes_from may name a service of this file, not a container"
    case "reserved-label":
      return "labels starting musdash. or com.docker.compose. are reserved"
    case "logging-driver":
      return "logging drivers other than json-file are refused, because musdash caps the log files"
    case "image-invalid":
      return "the image is not a valid image reference"
    case "external-links":
      return "external_links is refused, because it reaches containers outside the stack"
    case "routed-unknown":
      return "the public service is not a service in this file"
    case "routed-network-mode":
      return "the public service cannot set network_mode, because it must join musdash's network to be reachable"
    case "unsupported-key":
      return "this key is not supported by musdash yet"
    case "network-ipam":
      return "a network may not choose its own subnet, gateway or IPAM driver"
    default:
      return unreachable(code)
  }
}

/** A compile error, not a runtime one, when a new RefusalCode has no sentence. */
function unreachable(code: never): string {
  return `refused (${String(code)})`
}

function where(r: Refusal): string {
  const subject = r.service === null ? "The file" : `Service ${r.service}`
  return r.field === null ? subject : `${subject}, ${r.field}`
}

export function refusalMessage(r: Refusal): string {
  return `${where(r)}: ${reason(r.code)}.`
}
