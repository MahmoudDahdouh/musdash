import type { Reference, Refusal, RefusalCode } from "./types.ts"
import {
  checkServiceKeys,
  checkTopLevelKeys,
  isDockerSocketPath,
  isRecord,
  networkModeAllowed,
  nonEmpty,
  present,
  sortRefusals,
} from "./validate.ts"

/**
 * Stage A of the Compose pipeline (docs/PHASE-3-PLAN.md §3.2): a cheap look
 * at the raw YAML, before `docker compose config` ever sees it.
 *
 * It exists for one reason. `config` runs as root and READS HOST FILES named
 * by `include`, `extends.file`, `env_file`, `label_file` and file-backed
 * `configs`/`secrets` (D65 item 2: an `env_file: /root/…` put that file's
 * contents into the output). Those must be refused before the subprocess
 * runs, so every key is checked here against an allowlist (validate.ts) —
 * a key a later Compose adds is refused until it has been reviewed.
 *
 * Everything else here is form feedback — a pasted `privileged: true` is
 * refused on the form rather than after a job — and validateModel on
 * Compose's normalised output remains the authority. The quick checks are
 * therefore allowed to miss spellings; the host-file checks are not.
 *
 * It also collects the file's `${NAME}` references, so a variable with no
 * value and no default fails the deploy by name (D13, D65 item 3) instead of
 * Compose quietly substituting an empty string.
 *
 * Pure; never throws. `Bun.YAML` is built into the runtime and resolves
 * anchors and `<<` merges, so what is checked is what Compose will read.
 */

/**
 * 64 KiB, not more, because the file arrives as a URL-encoded form field and
 * forms are capped at 256 KiB before parsing (D35): percent-encoding can triple
 * a byte, so 64 KiB is the largest file that always fits. Real Compose files,
 * templates included, are a few KiB.
 */
export const MAX_COMPOSE_BYTES = 64 * 1024

export interface PrescanResult {
  /** Empty when the file passes. */
  refusals: Refusal[]
  /** Service names in file order; [] when the file could not be read. */
  services: string[]
  /** Deduplicated by name, in order of first use. */
  references: Reference[]
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

const NAME = /^[A-Za-z_][A-Za-z0-9_]*/

type AddReference = (name: string, hasDefault: boolean) => void

/** Index of the `}` closing a `${` whose body starts at `from`, or -1. */
function closingBrace(s: string, from: number): number {
  let depth = 1
  for (let i = from; i < s.length; i++) {
    if (s[i] === "{") depth++
    else if (s[i] === "}") {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * The body of one `${…}`. The `-` and `+` forms supply a value when the name
 * is unset (or supply nothing, which is also not an error), so they count as a
 * default; `?` forms and the plain form do not. A default may itself
 * interpolate (`${A:-${B}}`), so it is scanned in turn, and `B` there is held
 * to its own form: this over-reports rather than let a blank through. A body
 * Compose cannot parse is skipped — `config` rejects the file anyway.
 */
function scanBraced(body: string, add: AddReference): void {
  const name = NAME.exec(body)?.[0]
  if (name === undefined) return
  const rest = body.slice(name.length)
  if (rest === "") {
    add(name, false)
  } else if (rest.startsWith(":-") || rest.startsWith(":+")) {
    add(name, true)
    scanString(rest.slice(2), add)
  } else if (rest.startsWith("-") || rest.startsWith("+")) {
    add(name, true)
    scanString(rest.slice(1), add)
  } else if (rest.startsWith(":?") || rest.startsWith("?")) {
    // The message is an error text, not interpolated input.
    add(name, false)
  }
}

/**
 * Compose's interpolation grammar, read-only: `$$` is a literal `$`, `${…}`
 * is a braced reference, `$NAME` a bare one, and any other `$` is literal.
 */
function scanString(s: string, add: AddReference): void {
  let i = 0
  while (i < s.length) {
    const at = s.indexOf("$", i)
    if (at === -1) return
    const next = s[at + 1]
    if (next === "$") {
      i = at + 2
      continue
    }
    if (next === "{") {
      const end = closingBrace(s, at + 2)
      if (end === -1) {
        i = at + 2
        continue
      }
      scanBraced(s.slice(at + 2, end), add)
      i = end + 1
      continue
    }
    const bare = NAME.exec(s.slice(at + 1))?.[0]
    if (bare !== undefined) {
      add(bare, false)
      i = at + 1 + bare.length
      continue
    }
    i = at + 1
  }
}

/**
 * Every string VALUE in the document; keys are not interpolated. `Bun.YAML`
 * shares one object between an anchor and its aliases and can build cycles
 * (`&a [*a]`), so each object is visited once — without that, 64 KiB of
 * nested aliases expands exponentially.
 */
function collectReferences(doc: unknown): Reference[] {
  const found = new Map<string, boolean>()
  const add: AddReference = (name, hasDefault) => {
    const prev = found.get(name)
    found.set(name, (prev ?? true) && hasDefault)
  }
  const visited = new Set<object>()
  const stack: unknown[] = [doc]
  // Depth-first in document order, without recursion: nesting depth is
  // whatever the file says it is.
  while (stack.length > 0) {
    const value = stack.pop()
    if (typeof value === "string") {
      scanString(value, add)
      continue
    }
    if (typeof value !== "object" || value === null || visited.has(value)) {
      continue
    }
    visited.add(value)
    const children: unknown[] = Array.isArray(value)
      ? value
      : Object.values(value)
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i])
  }
  if (isRecord(doc)) collectEnvironmentReads(doc, add)
  return [...found].map(([name, hasDefault]) => ({ name, hasDefault }))
}

/** A variable name as a pass-through entry writes it: no `=`, nothing interpolated. */
const PASS_THROUGH = /^[^=$\s]+$/

/**
 * Reads of Compose's own environment that are not `${…}`: interpolationEnv
 * passes Compose only the variables the file references, so these must count
 * as references or their values never arrive.
 *
 *   - `environment: [BAR]` and `environment: {BAR: }` pass BAR through, and
 *     Compose simply omits it when unset (D65 item 4) — a default, in effect.
 *   - `secrets.<k>.environment: TOKEN` (and configs) is the secret's whole
 *     content, so it is required: an unset one fails the deploy by name.
 */
function collectEnvironmentReads(
  doc: Record<string, unknown>,
  add: AddReference,
): void {
  const services = isRecord(doc.services) ? doc.services : {}
  for (const svc of Object.values(services)) {
    if (!isRecord(svc)) continue
    const env = svc.environment
    if (Array.isArray(env)) {
      for (const item of env) {
        if (typeof item === "string" && PASS_THROUGH.test(item)) {
          add(item, true)
        }
      }
    } else if (isRecord(env)) {
      for (const [key, value] of Object.entries(env)) {
        if (value === null && PASS_THROUGH.test(key)) add(key, true)
      }
    }
  }
  for (const section of ["configs", "secrets"]) {
    const entries = doc[section]
    if (!isRecord(entries)) continue
    for (const entry of Object.values(entries)) {
      if (!isRecord(entry)) continue
      const name = entry.environment
      if (typeof name === "string" && PASS_THROUGH.test(name)) add(name, false)
    }
  }
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

function isTruthy(value: unknown): boolean {
  return (
    value !== undefined && value !== null && value !== false && value !== ""
  )
}

const BIND_KINDS = new Set(["bind", "npipe", "cluster"])

/**
 * Short syntax is `source:target[:mode]`; one part alone is an anonymous
 * volume. A source that is a path (`/`, `./`, `../`, `~`) is a bind mount.
 * A source that interpolates (`${DATA}:/x`) is left to validateModel, which
 * sees the resolved path.
 */
function volumeCode(entry: unknown): RefusalCode | null {
  if (typeof entry === "string") {
    const parts = entry.split(":")
    if (parts.slice(0, 2).some(isDockerSocketPath)) return "docker-socket"
    if (parts.length < 2) return null
    const source = parts[0] ?? ""
    return /^[/.~]/.test(source) ? "bind-mount" : null
  }
  if (!isRecord(entry)) return null
  if (isDockerSocketPath(entry.source) || isDockerSocketPath(entry.target)) {
    return "docker-socket"
  }
  return typeof entry.type === "string" && BIND_KINDS.has(entry.type)
    ? "bind-mount"
    : null
}

function checkService(
  svc: Record<string, unknown>,
  names: ReadonlySet<string>,
  add: (code: RefusalCode, field: string | null) => void,
): void {
  // Host-file reads — env_file, extends.file, label_file and any key not
  // reviewed yet — are why the prescan exists. The allowlist catches them.
  checkServiceKeys(svc, add)
  if (!present(svc.image) && !present(svc.extends)) add("no-image", "image")

  // Quick checks, for the form; the same tests validateModel applies.
  if (svc.privileged === true) add("privileged", "privileged")
  const mode = svc.network_mode
  if (
    !(typeof mode === "string" && mode.includes("$")) &&
    !networkModeAllowed(mode, names)
  ) {
    add("network-mode", "network_mode")
  }
  if (nonEmpty(svc.ports)) add("ports", "ports")
  if (present(svc.container_name)) add("container-name", "container_name")
  if (nonEmpty(svc.cap_add)) add("cap-add", "cap_add")
  if (nonEmpty(svc.devices)) add("devices", "devices")
  if (Array.isArray(svc.volumes)) {
    svc.volumes.forEach((entry: unknown, i) => {
      const code = volumeCode(entry)
      if (code !== null) add(code, `volumes[${i}]`)
    })
  }
}

function checkTopLevel(
  doc: Record<string, unknown>,
  add: (code: RefusalCode, field: string) => void,
): void {
  // `include` and any unreviewed top-level key; configs, secrets, volumes and
  // networks may use only their reviewed keys.
  checkTopLevelKeys(doc, add)
  const configs = isRecord(doc.configs) ? doc.configs : {}
  for (const [key, c] of Object.entries(configs)) {
    if (isRecord(c) && Object.hasOwn(c, "file")) {
      add("file-config", `configs.${key}`)
    }
  }
  const secrets = isRecord(doc.secrets) ? doc.secrets : {}
  for (const [key, s] of Object.entries(secrets)) {
    if (!isRecord(s)) continue
    if (Object.hasOwn(s, "file")) add("file-secret", `secrets.${key}`)
    if (isTruthy(s.external)) add("external-secret", `secrets.${key}`)
  }
}

function refused(code: RefusalCode): PrescanResult {
  return {
    refusals: [{ code, service: null, field: null }],
    services: [],
    references: [],
  }
}

export function prescanCompose(text: string): PrescanResult {
  // Before parsing: the cap is what bounds the parser's work.
  if (Buffer.byteLength(text, "utf8") > MAX_COMPOSE_BYTES) {
    return refused("too-large")
  }
  let doc: unknown
  try {
    doc = Bun.YAML.parse(text)
  } catch {
    // The parser's message quotes the offending line, which may be a secret.
    return refused("yaml-invalid")
  }
  // A multi-document stream parses to an array, and is refused here too.
  if (!isRecord(doc)) return refused("not-a-mapping")

  const references = collectReferences(doc)
  const refusals: Refusal[] = []
  checkTopLevel(doc, (code, field) =>
    refusals.push({ code, service: null, field }),
  )

  const services = doc.services
  if (!isRecord(services) || Object.keys(services).length === 0) {
    refusals.push({ code: "no-services", service: null, field: "services" })
    return { refusals: sortRefusals(refusals), services: [], references }
  }
  const names = Object.keys(services)
  const nameSet = new Set(names)
  for (const name of names) {
    const svc = services[name]
    if (!isRecord(svc)) {
      refusals.push({
        code: "service-not-a-mapping",
        service: name,
        field: null,
      })
      continue
    }
    checkService(svc, nameSet, (code, field) =>
      refusals.push({ code, service: name, field }),
    )
  }
  return { refusals: sortRefusals(refusals), services: names, references }
}
