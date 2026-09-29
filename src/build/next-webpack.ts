import { constants, type Stats } from "node:fs"
import { type FileHandle, lstat, open } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

/**
 * Whether a Railpack build of a Next.js 16+ app should switch from Turbopack to
 * webpack because BuildKit's memory cap is too small for Turbopack.
 *
 * On the 2GB host (D52, T-3) a stock Next.js 16 app's `next build` peaked at
 * 1254 MiB with Turbopack — its default since 16 — and made no progress in
 * BuildKit's 960 MiB until the stall watchdog stopped it, while the same app
 * built with `next build --webpack` peaked at 408 MiB. So where the cap is
 * known to be below what Turbopack needs, musdash sets Railpack's
 * `RAILPACK_BUILD_CMD` to the app's own `next build …` plus `--webpack`.
 *
 * It switches only when every fact points the same way, and skips otherwise:
 * a wrong switch breaks a build that would have worked (Next.js 15 and older
 * reject the flag), while a missed one costs what it cost before.
 *
 * The facts come from three sources of rising cost — package.json, then
 * `railpack info`, then package-lock.json — and the decision asks for each
 * only once the cheaper ones have left the question open (`need`), so an app
 * that is not Next.js never pays for the subprocess or the lockfile parse.
 * `railpack info` is asked rather than its detection reimplemented: whichever
 * provider Railpack picks runs RAILPACK_BUILD_CMD, and a repository with a
 * go.mod or a requirements.txt beside its package.json is not built by Node.
 *
 * package.json is repository content, and this runs in a process that holds
 * the Docker socket, so the reader follows the rules of unsupported-source.ts
 * (D62): the build context is reached one lstat-checked component at a time,
 * every file is opened O_NOFOLLOW and must be a regular file, and sizes are
 * capped. The build command it produces is built only from tokens whose
 * charset leaves no shell metacharacter, because Railpack runs it in a shell.
 *
 * Pure filesystem and computation: no logger, database or config — the caller
 * logs, and nothing read here is ever emitted except the major version.
 */

const MIB = 1024 * 1024

/**
 * The cap at and above which Turbopack is left alone. 1.4 GiB is the cap at
 * which D52 saw Turbopack succeed (peak 1254 MiB); buildkitd's own memory
 * comes out of the same cap, so the threshold is the measured success, not
 * the measured peak.
 */
export const TURBOPACK_MIN_BYTES = 1434 * MIB

const PACKAGE_JSON_MAX_BYTES = 1 * MIB
const PACKAGE_LOCK_MAX_BYTES = 8 * MIB

/**
 * O_NOFOLLOW closes the gap between an lstat that saw a regular file and the
 * open that reads it. O_NONBLOCK keeps a FIFO swapped in during that gap from
 * blocking the open — it changes nothing for a regular file. Both are
 * undefined on Windows, where they are simply absent.
 */
const READ_FLAGS =
  constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)

/**
 * True iff the cap is known and below what Turbopack needs. The fingerprint
 * input and the decision both use this one function, so a build that switched
 * and one that did not can never share a fingerprint.
 */
export function belowTurbopackCap(limitBytes: number | null): boolean {
  return (
    limitBytes !== null &&
    Number.isFinite(limitBytes) &&
    limitBytes > 0 &&
    limitBytes < TURBOPACK_MIN_BYTES
  )
}

/**
 * One comparator (`^`, `~`, `>=`, `=` or none), an optional `v`, then
 * `N[.N|x|*][.N|x|*][-pre]`. Deliberately narrow: a union (`||`), a range with
 * a space, a protocol (`workspace:`, `catalog:`, `npm:`, git, URL) or a tag
 * says nothing certain about the major, and the answer must then be "unknown"
 * rather than a guess. `>=` yields its lower bound, which can only understate.
 */
const RANGE =
  /^(?:\^|~|>=|=)?v?(0|[1-9]\d{0,5})(?:\.(?:\d+|[xX*]))?(?:\.(?:\d+|[xX*]))?(?:-[0-9A-Za-z.-]+)?$/

/** An exact installed version, as package-lock.json records it. */
const EXACT =
  /^v?(0|[1-9]\d{0,5})\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** The major version a package.json range pins, or null when it pins none for certain. */
export function nextMajorFromSpec(spec: string): number | null {
  const major = RANGE.exec(spec)?.[1]
  return major === undefined ? null : Number(major)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * The installed major from a v2/v3 package-lock.json:
 * `packages["node_modules/next"].version` and nothing else. A v1 lock has no
 * `packages`, and the caller then falls back to the range.
 */
export function nextMajorFromLock(lock: unknown): number | null {
  if (!isRecord(lock) || !isRecord(lock.packages)) return null
  const entry = lock.packages["node_modules/next"]
  if (!isRecord(entry) || typeof entry.version !== "string") return null
  const major = EXACT.exec(entry.version)?.[1]
  return major === undefined ? null : Number(major)
}

// ---------------------------------------------------------------------------
// railpack info
// ---------------------------------------------------------------------------

/** `metadata.nodePackageManager` as railpack 0.37.0 reports it. */
export type NodePackageManager = "npm" | "pnpm" | "yarn1" | "yarnberry" | "bun"

const PACKAGE_MANAGERS: readonly NodePackageManager[] = [
  "npm",
  "pnpm",
  "yarn1",
  "yarnberry",
  "bun",
]

function isPackageManager(value: unknown): value is NodePackageManager {
  return PACKAGE_MANAGERS.some((pm) => pm === value)
}

/**
 * The build step Railpack generates when nothing overrides it: `<bin> run
 * build`, with `yarn` for Yarn 1. Anything else in the plan means something —
 * a railpack.json, a RAILPACK_CONFIG_FILE, a provider rule — chose the build
 * command, and RAILPACK_BUILD_CMD would silently replace that choice.
 */
const DEFAULT_BUILD_CMD: Readonly<
  Record<Exclude<NodePackageManager, "yarnberry">, string>
> = {
  npm: "npm run build",
  pnpm: "pnpm run build",
  yarn1: "yarn run build",
  bun: "bun run build",
}

/** What the decision takes from `railpack info --format json`. */
export interface RailpackInfo {
  /** `detectedProviders`, in Railpack's order. */
  providers: readonly string[]
  /** `metadata.nodePackageManager`; null when absent or not one of the five. */
  nodePackageManager: NodePackageManager | null
  /**
   * The `cmd` of each command in the plan's one `build` step, in order; empty
   * when that step has no commands. Null when the plan has no step named
   * `build`, or more than one.
   */
  buildCommands: readonly string[] | null
}

/**
 * Narrows `railpack info --format json` output (0.37.0) to what the decision
 * needs, or null when it is not a successful report of the expected shape.
 * The output is derived from repository content, so nothing is assumed about
 * it: every field is checked before it is read, and a command whose `cmd` is
 * present but not a string makes the whole build step unreadable rather than
 * being skipped.
 */
export function parseRailpackInfo(json: unknown): RailpackInfo | null {
  if (!isRecord(json) || json.success !== true) return null
  const detected = json.detectedProviders
  if (!Array.isArray(detected)) return null
  const providers: string[] = []
  for (const p of detected) {
    if (typeof p !== "string") return null
    providers.push(p)
  }

  const metadata = isRecord(json.metadata) ? json.metadata : {}
  const pm = metadata.nodePackageManager
  const nodePackageManager = isPackageManager(pm) ? pm : null

  return { providers, nodePackageManager, buildCommands: buildCommands(json) }
}

function buildCommands(json: Record<string, unknown>): string[] | null {
  if (!isRecord(json.plan) || !Array.isArray(json.plan.steps)) return null
  const builds = json.plan.steps.filter(
    (s): s is Record<string, unknown> => isRecord(s) && s.name === "build",
  )
  const [step] = builds
  if (step === undefined || builds.length !== 1) return null
  // No build script: Railpack 0.37.0 omits the key rather than writing [].
  if (step.commands === undefined) return []
  if (!Array.isArray(step.commands)) return null
  const cmds: string[] = []
  for (const c of step.commands) {
    // Non-exec commands (paths, variables, copies) carry no `cmd`.
    if (!isRecord(c) || !Object.hasOwn(c, "cmd")) continue
    if (typeof c.cmd !== "string") return null
    cmds.push(c.cmd)
  }
  return cmds
}

// ---------------------------------------------------------------------------
// Reading the untrusted tree
// ---------------------------------------------------------------------------

/**
 * package.json as the reader found it. `unreadable` covers everything that is
 * there but was not read: a context path through a symlink, a package.json
 * that is a symlink, not a regular file, over 1 MiB, not JSON, or any
 * filesystem error.
 */
export type PackageJsonRead =
  { kind: "absent" } | { kind: "unreadable" } | { kind: "json"; value: unknown }

function errorCode(err: unknown): string | undefined {
  if (err instanceof Error && "code" in err && typeof err.code === "string") {
    return err.code
  }
  return undefined
}

/**
 * The absolute path of `contextDir`, reached from `buildDir` one component at
 * a time, or null when it escapes buildDir or any component — the build dir
 * included — is not a real directory. A symlinked directory in the path would
 * otherwise let the repository point the reader anywhere on the host.
 */
async function reachContext(
  buildDir: string,
  contextDir: string,
): Promise<string | null> {
  const root = resolve(buildDir)
  const rel = relative(root, resolve(contextDir))
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return null
  }
  let current = root
  if (!(await lstat(current)).isDirectory()) return null
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part)
    // lstat: a symlink is never isDirectory(), whatever it points at.
    if (!(await lstat(current)).isDirectory()) return null
  }
  return current
}

/** Reads until `length` bytes or end of file; returns how many arrived. */
async function readInto(
  handle: FileHandle,
  buf: Buffer,
  length: number,
): Promise<number> {
  let got = 0
  while (got < length) {
    const { bytesRead } = await handle.read(buf, got, length - got, got)
    if (bytesRead === 0) break
    got += bytesRead
  }
  return got
}

type FileRead =
  | { kind: "absent" }
  /** Not a regular file, or larger than the cap. */
  | { kind: "refused" }
  | { kind: "text"; text: string }

/**
 * A regular file's text, capped at `maxBytes`. Checked by lstat before the
 * open and by fstat after it, and read with one byte of headroom so a file
 * that grew past the cap in between is refused too.
 */
async function readCapped(path: string, maxBytes: number): Promise<FileRead> {
  let info: Stats
  try {
    info = await lstat(path)
  } catch (err) {
    if (errorCode(err) === "ENOENT") return { kind: "absent" }
    throw err
  }
  if (!info.isFile() || info.size > maxBytes) return { kind: "refused" }
  const handle = await open(path, READ_FLAGS)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.size > maxBytes) return { kind: "refused" }
    const buf = Buffer.alloc(opened.size + 1)
    const got = await readInto(handle, buf, buf.length)
    if (got > maxBytes) return { kind: "refused" }
    return { kind: "text", text: buf.toString("utf8", 0, got) }
  } finally {
    await handle.close()
  }
}

/** JSON.parse without the byte-order mark some editors write. Throws on invalid JSON. */
function parseJson(text: string): unknown {
  return JSON.parse(text.startsWith("\uFEFF") ? text.slice(1) : text)
}

/** `<contextDir>/package.json`, never following a symlink. Never throws. */
export async function readPackageJson(
  buildDir: string,
  contextDir: string,
): Promise<PackageJsonRead> {
  try {
    const context = await reachContext(buildDir, contextDir)
    if (context === null) return { kind: "unreadable" }
    const file = await readCapped(
      join(context, "package.json"),
      PACKAGE_JSON_MAX_BYTES,
    )
    if (file.kind === "absent") return { kind: "absent" }
    if (file.kind === "refused") return { kind: "unreadable" }
    return { kind: "json", value: parseJson(file.text) }
  } catch {
    return { kind: "unreadable" }
  }
}

/**
 * `<contextDir>/package-lock.json` parsed, or null when it is absent, refused
 * (over 8 MiB, not a regular file, behind a symlink), not JSON, or anything
 * fails — all of which mean "the range decides". Never throws.
 */
export async function readPackageLock(
  buildDir: string,
  contextDir: string,
): Promise<unknown> {
  try {
    const context = await reachContext(buildDir, contextDir)
    if (context === null) return null
    const file = await readCapped(
      join(context, "package-lock.json"),
      PACKAGE_LOCK_MAX_BYTES,
    )
    return file.kind === "text" ? parseJson(file.text) : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * What has been gathered so far. `undefined` means not yet gathered; the
 * decision then answers with a `need` for it, and only once the cheaper facts
 * have left the question open.
 */
export interface NextProjectFacts {
  packageJson?: PackageJsonRead
  /** null: `railpack info` failed, timed out, or said something unexpected. */
  railpackInfo?: RailpackInfo | null
  /** Parsed package-lock.json; null when absent or unreadable. Read only for npm. */
  packageLock?: unknown
}

export type AutoWebpackSkip =
  | "cap-unknown"
  | "cap-large"
  | "user-build-cmd"
  | "no-package-json"
  | "package-json-unreadable"
  | "no-next"
  | "next-overridden"
  | "next-version-unknown"
  | "next-below-16"
  | "build-script"
  | "pre-post-script"
  | "railpack-info-unusable"
  | "other-provider"
  | "yarn-berry"
  | "railpack-config"

export type AutoWebpackDecision =
  | { switch: true; buildCmd: string; nextMajor: number; capMib: number }
  | { switch: false; reason: AutoWebpackSkip }

export type AutoWebpackFact = keyof NextProjectFacts

/** A decision, or the next fact the decision cannot be made without. */
export type AutoWebpackStep = AutoWebpackDecision | { need: AutoWebpackFact }

/**
 * A flag token the build command may carry through. The charset has no shell
 * metacharacter, quote, `$` or backtick, so the command Railpack runs in a
 * shell (`sh -c '…'`) is exactly the tokens it shows. No comma either: the
 * command reaches Railpack as an `--env` flag value, and a string-slice flag
 * may split on commas.
 */
const FLAG = /^--[a-z0-9][a-z0-9-]*(=[A-Za-z0-9._:/@+-]*)?$/

/** Flags that already pick a bundler: the app has made its own choice. */
const BUNDLER_FLAGS = new Set(["webpack", "turbopack", "turbo"])

/**
 * The build script's tokens when it is `next build` plus plain flags, else
 * null. Anything else — another command, a chained one, an env prefix, a
 * positional argument, a short flag — is not rewritten: the switch replaces
 * the whole script, and only a script this simple survives that unchanged.
 */
function plainNextBuild(script: string): string[] | null {
  const tokens = script.trim().split(/\s+/)
  if (tokens[0] !== "next" || tokens[1] !== "build") return null
  for (const token of tokens.slice(2)) {
    if (!FLAG.test(token)) return null
    const name = token.slice(2).split("=")[0] ?? ""
    if (BUNDLER_FLAGS.has(name)) return null
  }
  return tokens
}

/**
 * Yarn 2+ (Berry) defaults to Plug'n'Play, which writes no node_modules/.bin,
 * so a bare `next` in the build command would not be found. Checked here from
 * `packageManager` before Railpack is asked, since it costs nothing; Railpack's
 * own `yarnberry` covers `.yarnrc.yml`. A `yarn@` packageManager whose major
 * cannot be read is treated as Berry: skipping is the safe direction.
 */
function declaresYarnBerry(pkg: Record<string, unknown>): boolean {
  const pm = pkg.packageManager
  if (typeof pm !== "string" || !pm.startsWith("yarn@")) return false
  const major = /^yarn@v?(\d+)/.exec(pm)?.[1]
  return major === undefined || Number(major) >= 2
}

function nextRange(pkg: Record<string, unknown>): string | null {
  for (const field of ["dependencies", "devDependencies"]) {
    const deps = pkg[field]
    if (isRecord(deps) && typeof deps.next === "string") return deps.next
  }
  return null
}

/**
 * The package an override key targets: the last `>` (pnpm) or `/` (yarn)
 * segment, less any `@version`. Over-matches rather than under-matches — a
 * scoped `@x/next` counts too — because a miss here is the dangerous one.
 */
function overrideTarget(key: string): string {
  const last = key.split(/[>/]/).at(-1) ?? ""
  const at = last.indexOf("@", 1)
  return at === -1 ? last : last.slice(0, at)
}

/**
 * Whether package.json overrides the version of `next` that gets installed:
 * npm `overrides`, pnpm `pnpm.overrides`, yarn (and pnpm) `resolutions`, or
 * an `optionalDependencies` entry. Any of them can pin Next.js 15 behind a
 * `^16` range, and the flag would then be rejected.
 */
function overridesNext(pkg: Record<string, unknown>): boolean {
  // An optionalDependencies entry replaces the dependencies one under npm and
  // pnpm, so it can pin 15 the same way.
  const optional = pkg.optionalDependencies
  if (isRecord(optional) && Object.hasOwn(optional, "next")) return true
  const pnpm = isRecord(pkg.pnpm) ? pkg.pnpm : {}
  for (const table of [pkg.overrides, pnpm.overrides, pkg.resolutions]) {
    if (!isRecord(table)) continue
    if (Object.keys(table).some((k) => overrideTarget(k) === "next")) {
      return true
    }
  }
  return false
}

function skip(reason: AutoWebpackSkip): AutoWebpackDecision {
  return { switch: false, reason }
}

/**
 * The decision, as far as the facts gathered so far allow. Checks run in
 * order of what they cost to establish: the cap and the user's own
 * `RAILPACK_BUILD_CMD` need nothing; then package.json; then `railpack info`;
 * then, for npm only, package-lock.json. A skip at any stage is final, so the
 * caller gathers a fact only when the answer is a `need` for it — and a caller
 * that supplies every fact up front gets the same answer.
 */
export function decideAutoWebpack(input: {
  limitBytes: number | null
  buildEnv: Readonly<Record<string, string>>
  facts: NextProjectFacts
}): AutoWebpackStep {
  const { limitBytes, buildEnv, facts } = input
  if (!belowTurbopackCap(limitBytes)) {
    const known =
      limitBytes !== null && Number.isFinite(limitBytes) && limitBytes > 0
    return skip(known ? "cap-large" : "cap-unknown")
  }
  // Present at all, even empty: the user has taken over the build command.
  if (Object.hasOwn(buildEnv, "RAILPACK_BUILD_CMD")) {
    return skip("user-build-cmd")
  }

  // --- package.json ---
  if (facts.packageJson === undefined) return { need: "packageJson" }
  if (facts.packageJson.kind === "absent") return skip("no-package-json")
  if (
    facts.packageJson.kind === "unreadable" ||
    !isRecord(facts.packageJson.value)
  ) {
    return skip("package-json-unreadable")
  }
  const pkg = facts.packageJson.value
  const range = nextRange(pkg)
  if (range === null) return skip("no-next")
  if (overridesNext(pkg)) return skip("next-overridden")
  // A range that pins a major below 16 ends it here. One that pins none
  // (`latest`, a tag) goes on: npm's lock may still settle it.
  const rangeMajor = nextMajorFromSpec(range)
  // `--webpack` does not exist before 16, and on 15 Turbopack is opt-in.
  if (rangeMajor !== null && rangeMajor < 16) return skip("next-below-16")
  const scripts = isRecord(pkg.scripts) ? pkg.scripts : {}
  const build = typeof scripts.build === "string" ? scripts.build : null
  const tokens = build === null ? null : plainNextBuild(build)
  if (tokens === null) return skip("build-script")
  // `npm run build` runs these around the build; the replacement command
  // runs `next build` directly and would silently drop them.
  if (
    Object.hasOwn(scripts, "prebuild") ||
    Object.hasOwn(scripts, "postbuild")
  ) {
    return skip("pre-post-script")
  }
  if (declaresYarnBerry(pkg)) return skip("yarn-berry")

  // --- railpack info ---
  if (facts.railpackInfo === undefined) return { need: "railpackInfo" }
  const info = facts.railpackInfo
  if (info === null) return skip("railpack-info-unusable")
  // RAILPACK_BUILD_CMD replaces the build command of whichever provider wins,
  // and Railpack checks several before Node.
  if (info.providers.length !== 1 || info.providers[0] !== "node") {
    return skip("other-provider")
  }
  const pm = info.nodePackageManager
  if (pm === null) return skip("railpack-info-unusable")
  if (pm === "yarnberry") return skip("yarn-berry")
  const cmds = info.buildCommands
  if (cmds === null || cmds.length !== 1 || cmds[0] !== DEFAULT_BUILD_CMD[pm]) {
    return skip("railpack-config")
  }

  // --- package-lock.json (npm only) ---
  // The lock records what npm installs, so it wins over the range. Under any
  // other package manager a package-lock.json may be left over from before a
  // switch, and says nothing.
  let lockMajor: number | null = null
  if (pm === "npm") {
    if (facts.packageLock === undefined) return { need: "packageLock" }
    lockMajor = nextMajorFromLock(facts.packageLock)
  }
  const nextMajor = lockMajor ?? rangeMajor
  if (nextMajor === null) return skip("next-version-unknown")
  if (nextMajor < 16) return skip("next-below-16")

  return {
    switch: true,
    buildCmd: [...tokens, "--webpack"].join(" "),
    nextMajor,
    // belowTurbopackCap guarantees a finite positive number here.
    capMib: Math.round((limitBytes ?? 0) / MIB),
  }
}

/** Where each fact comes from. Each is called at most once. */
export interface AutoWebpackSources {
  packageJson(): Promise<PackageJsonRead>
  railpackInfo(): Promise<RailpackInfo | null>
  packageLock(): Promise<unknown>
}

/**
 * Runs the decision to its end, gathering each fact it asks for. Terminates:
 * the decision asks only for a fact that is still undefined, and each one is
 * set to a defined value before it is asked again.
 */
export async function resolveAutoWebpack(
  input: {
    limitBytes: number | null
    buildEnv: Readonly<Record<string, string>>
  },
  sources: AutoWebpackSources,
): Promise<AutoWebpackDecision> {
  const facts: NextProjectFacts = {}
  for (;;) {
    const step = decideAutoWebpack({ ...input, facts })
    if (!("need" in step)) return step
    const need: AutoWebpackFact = step.need
    if (need === "packageJson") {
      facts.packageJson = await sources.packageJson()
    } else if (need === "railpackInfo") {
      facts.railpackInfo = await sources.railpackInfo()
    } else {
      facts.packageLock = (await sources.packageLock()) ?? null
    }
  }
}
