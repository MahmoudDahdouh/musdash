import { constants, type Dir, type Stats } from "node:fs"
import { type FileHandle, lstat, open, opendir } from "node:fs/promises"
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path"

/**
 * Refuses a GitHub tarball deploy that depends on Git submodules or Git LFS
 * (D62). GitHub's archive does not carry either: a submodule arrives as an
 * empty directory (or nothing) and an LFS-tracked file arrives as its pointer
 * text. Building from that tree "succeeds" and ships a broken app, so the
 * deploy stops before the build with a message naming the feature and a path.
 *
 * The extracted tree is untrusted — anyone who can push to the repository
 * shapes it — and this runs inside a process that holds the Docker socket. So
 * the scanner never follows a symlink: every path is reached one lstat-checked
 * component at a time or through a dirent typed as a real directory, and every
 * file is opened O_NOFOLLOW. It never recurses (explicit stack), reads at most
 * 1 KiB of a pointer candidate and 1 MiB of the root .gitmodules and
 * .gitattributes, and is bounded in entries and wall-clock time. When it cannot
 * finish it says why in `truncated` and returns what it found so far; the
 * caller refuses only on findings, because a false refusal of a working
 * repository is worse than the status quo it improves on.
 *
 * Pure filesystem: no database, config or logger — the caller logs.
 */

export interface ScanLimits {
  /** Dirents examined in the context walk. */
  maxEntries: number
  /** Wall clock for the whole scan. */
  budgetMs: number
  /** Paths retained per list. */
  maxHits: number
}

export const SCAN_LIMITS: Readonly<ScanLimits> = {
  maxEntries: 50_000,
  budgetMs: 3000,
  maxHits: 3,
}

export type ScanStop = "entries" | "time" | "unreadable"

export interface SourceFindings {
  /** Repo-relative, "/"-separated, first maxHits in .gitmodules order. */
  submodules: string[]
  submoduleCount: number
  /** Repo-relative, "/"-separated, first maxHits in walk order. */
  lfsPointers: string[]
  lfsPointerCount: number
  /** Why the scan stopped before finishing; null = it finished. Fail-open signal. */
  truncated: ScanStop | null
}

/** Root .gitmodules / .gitattributes larger than this are ignored, not parsed. */
const MAX_CONFIG_BYTES = 1024 * 1024

/** git-lfs writes pointers well inside this range; anything outside is content. */
const POINTER_MIN_BYTES = 100
const POINTER_MAX_BYTES = 1024

/**
 * The spec's first line, byte for byte. It is 43 bytes long ("version " 8,
 * "https://git-lfs.github.com/spec/v1" 34, "\n" 1); the comparison uses the
 * buffer's own length so the constant, not a hand count, is authoritative.
 */
const VERSION_LINE = Buffer.from("version https://git-lfs.github.com/spec/v1\n")
const OID_LINE = /^oid sha256:[0-9a-f]{64}$/
const SIZE_LINE = /^size [0-9]+$/

/**
 * O_NOFOLLOW closes the gap between an lstat that saw a regular file and the
 * open that reads it. Nothing else writes the build dir during a scan, so this
 * is belt-and-braces; undefined on Windows, where the flag is simply absent.
 */
const READ_NOFOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)

const MAX_SHOWN_CHARS = 120

interface ScanState {
  readonly limits: ScanLimits
  readonly started: number
  truncated: ScanStop | null
}

/**
 * Records why the scan did not finish. A hard stop (entries, time) replaces an
 * earlier "unreadable", because it is the one that explains the most missing
 * coverage; "unreadable" never replaces anything.
 */
function stopReason(state: ScanState, reason: ScanStop): void {
  if (reason !== "unreadable" || state.truncated === null) {
    state.truncated = reason
  }
}

function outOfTime(state: ScanState): boolean {
  if (performance.now() - state.started > state.limits.budgetMs) {
    stopReason(state, "time")
    return true
  }
  return false
}

function errorCode(err: unknown): string | undefined {
  if (err instanceof Error && "code" in err && typeof err.code === "string") {
    return err.code
  }
  return undefined
}

class Hits {
  readonly paths: string[] = []
  count = 0
  constructor(private readonly max: number) {}
  add(path: string): void {
    this.count += 1
    if (this.paths.length < this.max) this.paths.push(path)
  }
}

type Lookup =
  | { kind: "found"; stats: Stats }
  | { kind: "missing" }
  | { kind: "not-followed" }
  | { kind: "unreadable" }

/**
 * lstat `rel` (repo-relative, "/"-separated) by descending from repoRoot one
 * component at a time. An ancestor that is a symlink or not a directory stops
 * the descent as "not-followed": resolving through it would let a repository
 * point the scanner at any path on the host.
 */
async function lookupNoFollow(repoRoot: string, rel: string): Promise<Lookup> {
  const parts = rel === "" ? [] : rel.split("/")
  let current = repoRoot
  let stats: Stats
  try {
    stats = await lstat(current)
    for (const part of parts) {
      if (!stats.isDirectory()) return { kind: "not-followed" }
      current = join(current, part)
      stats = await lstat(current)
    }
  } catch (err) {
    const code = errorCode(err)
    if (code === "ENOENT") return { kind: "missing" }
    if (code === "ENOTDIR") return { kind: "not-followed" }
    return { kind: "unreadable" }
  }
  return { kind: "found", stats }
}

/** Reads until `length` bytes or end of file; returns how many arrived. */
async function readInto(
  handle: FileHandle,
  buf: Buffer,
  offset: number,
  length: number,
): Promise<number> {
  let got = 0
  while (got < length) {
    const { bytesRead } = await handle.read(
      buf,
      offset + got,
      length - got,
      offset + got,
    )
    if (bytesRead === 0) break
    got += bytesRead
  }
  return got
}

/**
 * The text of a root-level config file, or null when it is absent, not a
 * regular file (a symlink could name anything on the host), or over 1 MiB.
 */
async function readRootConfig(
  state: ScanState,
  path: string,
): Promise<string | null> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) return null
    const handle = await open(path, READ_NOFOLLOW)
    try {
      // One byte of headroom detects a file that grew past the cap after lstat.
      const buf = Buffer.alloc(info.size + 1)
      const got = await readInto(handle, buf, 0, buf.length)
      if (got > MAX_CONFIG_BYTES) return null
      return buf.toString("utf8", 0, got)
    } finally {
      await handle.close()
    }
  } catch (err) {
    if (errorCode(err) !== "ENOENT") stopReason(state, "unreadable")
    return null
  }
}

function isCommentLine(line: string, markers: string): boolean {
  const first = line.trimStart()[0]
  return first !== undefined && markers.includes(first)
}

const SECTION_HEADER =
  /^\s*\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/
const KEY_VALUE = /^\s*([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/

/** A git-config value: quoted → the quoted text; unquoted → up to a ` #`/` ;` comment. */
function configValue(raw: string): string {
  const value = raw.trim()
  if (value.startsWith('"')) {
    const close = value.indexOf('"', 1)
    return close === -1 ? value.slice(1) : value.slice(1, close)
  }
  return value.replace(/\s[#;].*$/, "").trim()
}

/**
 * Submodule paths from .gitmodules, in first-appearance order of their
 * sections. Sections with the same name merge as git merges them, with the
 * last `path` winning. Deliberately a small subset of git-config: it only has
 * to find `path` in the files real repositories contain. It does not handle
 * escaped quotes, line continuations or a comment character with no space
 * before it, and a path it misreads is then "missing" and refuses — a rare
 * false refusal, like a stale entry (D62), not a skipped check.
 */
function parseGitmodules(text: string): string[] {
  const paths = new Map<string, string>()
  let section: string | null = null
  for (const line of text.split(/\r?\n/)) {
    if (isCommentLine(line, "#;")) continue
    const header = SECTION_HEADER.exec(line)
    if (header) {
      const kind = header[1]?.toLowerCase()
      section = kind === "submodule" ? (header[2] ?? null) : null
      continue
    }
    if (section === null) continue
    const kv = KEY_VALUE.exec(line)
    if (kv?.[1]?.toLowerCase() !== "path") continue
    const value = configValue(kv[2] ?? "")
    // Map.set on an existing key keeps its original position: first-appearance
    // order, last value — git's own merge semantics.
    paths.set(section, value)
  }
  return [...paths.values()]
}

/**
 * A submodule path as a clean repo-relative path, or null when it could never
 * name something inside the repository.
 */
function cleanRepoPath(raw: string): string | null {
  if (raw === "" || raw.includes("\0") || posix.isAbsolute(raw)) return null
  const normal = posix.normalize(raw).replace(/\/+$/, "")
  if (normal === "" || normal === ".") return null
  // A ".." segment, not any name beginning with two dots: "..data" is a
  // legitimate directory name.
  if (normal === ".." || normal.startsWith("../")) return null
  return normal
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return (
    rel === "" ||
    !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
  )
}

async function isEmptyDirectory(path: string): Promise<boolean> {
  const dir = await opendir(path)
  try {
    return (await dir.read()) === null
  } finally {
    await dir.close()
  }
}

/**
 * A submodule is live — its content missing from the archive — when its path
 * is absent or is a real, empty directory. A symlink, a file, or a directory
 * with content means the repository ships something else there, and a path
 * behind a symlinked ancestor is never looked at.
 */
async function findSubmodules(
  state: ScanState,
  repoRoot: string,
  contextDir: string,
  hits: Hits,
): Promise<void> {
  const text = await readRootConfig(state, join(repoRoot, ".gitmodules"))
  if (text === null) return
  const seen = new Set<string>()
  for (const raw of parseGitmodules(text)) {
    if (outOfTime(state)) return
    const rel = cleanRepoPath(raw)
    if (rel === null || seen.has(rel)) continue
    seen.add(rel)
    // Arithmetic, not the filesystem: contextDir may not exist, and a
    // submodule at or under it still breaks the build.
    if (!isWithin(contextDir, resolve(repoRoot, ...rel.split("/")))) continue
    const found = await lookupNoFollow(repoRoot, rel)
    if (found.kind === "missing") {
      hits.add(rel)
    } else if (found.kind === "unreadable") {
      stopReason(state, "unreadable")
    } else if (found.kind === "found" && found.stats.isDirectory()) {
      try {
        if (await isEmptyDirectory(join(repoRoot, rel))) hits.add(rel)
      } catch {
        stopReason(state, "unreadable")
      }
    }
  }
}

/**
 * Whether the root .gitattributes routes anything through LFS. Only the root
 * file is consulted: nested .gitattributes and .git/info/attributes are out of
 * scope (D62), so a repository that enables LFS only below the root is not
 * detected — fail-open by design.
 */
async function lfsEnabled(
  state: ScanState,
  repoRoot: string,
): Promise<boolean> {
  const text = await readRootConfig(state, join(repoRoot, ".gitattributes"))
  if (text === null) return false
  return text
    .split(/\r?\n/)
    .some((line) => !isCommentLine(line, "#") && line.includes("filter=lfs"))
}

/** Whether `file` is a Git LFS pointer, by the spec's size, first line and keys. */
async function isLfsPointer(file: string): Promise<boolean> {
  const info = await lstat(file)
  if (
    !info.isFile() ||
    info.size < POINTER_MIN_BYTES ||
    info.size >= POINTER_MAX_BYTES
  ) {
    return false
  }
  const handle = await open(file, READ_NOFOLLOW)
  try {
    // The whole file fits in one 1 KiB buffer; the first line is read alone
    // so the overwhelmingly common non-pointer costs one short read.
    const buf = Buffer.alloc(POINTER_MAX_BYTES)
    const head = await readInto(handle, buf, 0, VERSION_LINE.length)
    if (
      head < VERSION_LINE.length ||
      !buf.subarray(0, head).equals(VERSION_LINE)
    ) {
      return false
    }
    const rest = await readInto(handle, buf, head, POINTER_MAX_BYTES - head)
    const total = head + rest
    if (total >= POINTER_MAX_BYTES) return false
    const lines = buf.toString("utf8", 0, total).split("\n")
    return (
      lines.some((line) => OID_LINE.test(line)) &&
      lines.some((line) => SIZE_LINE.test(line))
    )
  } finally {
    await handle.close()
  }
}

function childPath(dirRel: string, name: string): string {
  return dirRel === "" ? name : `${dirRel}/${name}`
}

/**
 * Depth-first walk of the build context for LFS pointers, with an explicit
 * stack so a deep tree cannot exhaust the call stack. Symlinks are skipped
 * outright (never followed, so a link loop costs one entry) and `.git`
 * directories at any depth are skipped because their contents are git's, not
 * the build's.
 *
 * fs.promises.opendir rather than readdir: it hands entries over one at a time,
 * so the entry and time limits apply inside a single huge directory and
 * nothing requires the whole listing to be materialised by this code.
 */
async function findLfsPointers(
  state: ScanState,
  repoRoot: string,
  contextRel: string,
  hits: Hits,
): Promise<void> {
  const stack: string[] = [contextRel]
  let examined = 0
  for (let dirRel = stack.pop(); dirRel !== undefined; dirRel = stack.pop()) {
    let dir: Dir
    try {
      dir = await opendir(join(repoRoot, dirRel))
    } catch {
      stopReason(state, "unreadable")
      continue
    }
    try {
      let entry = await dir.read()
      while (entry !== null) {
        if (examined >= state.limits.maxEntries) {
          stopReason(state, "entries")
          return
        }
        if (outOfTime(state)) return
        examined += 1
        const rel = childPath(dirRel, entry.name)
        const skipped = entry.name === ".git" || entry.isSymbolicLink()
        if (!skipped && entry.isDirectory()) {
          stack.push(rel)
        } else if (!skipped && entry.isFile()) {
          try {
            if (await isLfsPointer(join(repoRoot, rel))) hits.add(rel)
          } catch {
            stopReason(state, "unreadable")
          }
        } else if (
          !skipped &&
          !entry.isFIFO() &&
          !entry.isSocket() &&
          !entry.isBlockDevice() &&
          !entry.isCharacterDevice()
        ) {
          // A filesystem that reports no type (DT_UNKNOWN) would make the walk
          // examine nothing; say so rather than report a finished scan.
          stopReason(state, "unreadable")
        }
        entry = await dir.read()
      }
    } catch {
      stopReason(state, "unreadable")
    } finally {
      await closeDir(state, dir)
    }
  }
}

/** Closes a directory handle; a failure is recorded, never thrown out of the scan. */
async function closeDir(state: ScanState, dir: Dir): Promise<void> {
  try {
    await dir.close()
  } catch {
    stopReason(state, "unreadable")
  }
}

/**
 * Scans an extracted repository for the two things GitHub's archive cannot
 * carry. `repoRoot` is the extraction directory; `contextDir` the build
 * context, which need not exist. Only findings at or under the context are
 * reported, since only those reach the build.
 *
 * Never rejects on a filesystem error inside the tree; such errors set
 * truncated = "unreadable".
 */
export async function scanUnsupportedSource(
  repoRoot: string,
  contextDir: string,
  limits: ScanLimits = SCAN_LIMITS,
): Promise<SourceFindings> {
  const state: ScanState = {
    limits,
    started: performance.now(),
    truncated: null,
  }
  const root = resolve(repoRoot)
  const context = resolve(contextDir)
  const submodules = new Hits(limits.maxHits)
  const pointers = new Hits(limits.maxHits)

  await findSubmodules(state, root, context, submodules)

  if (state.truncated !== "time" && (await lfsEnabled(state, root))) {
    const contextRel = relative(root, context)
    const escapes =
      contextRel === ".." ||
      contextRel.startsWith(`..${sep}`) ||
      isAbsolute(contextRel)
    if (!escapes) {
      const rel = contextRel.split(sep).filter(Boolean).join("/")
      const found = await lookupNoFollow(root, rel)
      if (found.kind === "unreadable") {
        stopReason(state, "unreadable")
      } else if (found.kind === "found" && found.stats.isDirectory()) {
        await findLfsPointers(state, root, rel, pointers)
      }
    }
  }

  return {
    submodules: submodules.paths,
    submoduleCount: submodules.count,
    lfsPointers: pointers.paths,
    lfsPointerCount: pointers.count,
    truncated: state.truncated,
  }
}

/**
 * A repository path as it may appear in a deploy log: control characters
 * become "?" so a crafted name cannot forge log lines, and long paths are cut
 * so one cannot flood the message.
 */
function shownPath(path: string): string {
  const chars = Array.from(path, (ch) => {
    const code = ch.codePointAt(0) ?? 0
    // C0 and C1 controls, DEL, and the line/paragraph separators and bidi
    // overrides that could make a deploy-log line read as something else.
    return code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
      ? "?"
      : ch
  })
  return chars.length > MAX_SHOWN_CHARS
    ? `${chars.slice(0, MAX_SHOWN_CHARS - 3).join("")}...`
    : chars.join("")
}

/**
 * The deploy-log message for a refused source. Built only from fixed text and
 * sanitised repo-relative paths — never from a filesystem error — so it is safe
 * to show as-is. Empty when there is nothing to report.
 */
export function unsupportedSourceMessage(f: SourceFindings): string {
  const parts: string[] = []
  const submodule = f.submodules[0]
  if (submodule !== undefined) {
    const more = f.submoduleCount - 1
    const named =
      more >= 1
        ? `\`${shownPath(submodule)}\` and ${more} more`
        : `\`${shownPath(submodule)}\``
    parts.push(
      `This repository uses Git submodules (${named}), which musdash does not fetch yet: GitHub's archive leaves them empty. Vendor the submodule's files into the repository, or remove the submodule, to deploy.`,
    )
  }
  const pointer = f.lfsPointers[0]
  if (pointer !== undefined) {
    const more = f.lfsPointerCount - 1
    const named =
      more >= 1
        ? `\`${shownPath(pointer)}\` and ${more} more are LFS pointers, not the files`
        : `\`${shownPath(pointer)}\` is an LFS pointer, not the file`
    parts.push(
      `This repository stores files with Git LFS (${named}). musdash does not fetch Git LFS files yet.`,
    )
  }
  return parts.join(" ")
}

/** Thrown before the build when the source needs submodules or LFS (D62). */
export class UnsupportedSourceError extends Error {
  override readonly name = "UnsupportedSourceError"
  readonly findings: SourceFindings
  constructor(findings: SourceFindings) {
    super(unsupportedSourceMessage(findings))
    this.findings = findings
  }
}
