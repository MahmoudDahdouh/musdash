import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs"
import { join } from "node:path"
import { config } from "../config.ts"
import type { LogLine } from "../docker/client.ts"

/**
 * Append-and-rotate log files under data/logs/. Rotate at 10MB, keep 2 files.
 *
 * Disk exhaustion generates more support load than any other single issue, so
 * the cap is enforced here rather than left to logrotate — musdash cannot
 * assume anything about the host's log tooling.
 */

const MAX_BYTES = 10 * 1024 * 1024
const KEEP = 2

let dirReady = false

function ensureDir(): void {
  if (dirReady) return
  mkdirSync(config.logDir, { recursive: true })
  dirReady = true
}

function pathFor(resourceId: string): string {
  // resourceId is a ULID from our own generator, so it cannot traverse — but
  // strip anything path-like anyway, since this builds a filesystem path.
  const safe = resourceId.replace(/[^A-Za-z0-9_-]/g, "")
  return join(config.logDir, `${safe}.log`)
}

function rotateIfNeeded(file: string): void {
  let size = 0
  try {
    size = statSync(file).size
  } catch {
    return // does not exist yet
  }
  if (size < MAX_BYTES) return

  // Drop the oldest, shift the rest down: file.1 -> file.2, file -> file.1
  const oldest = `${file}.${KEEP}`
  if (existsSync(oldest)) unlinkSync(oldest)
  for (let i = KEEP - 1; i >= 1; i--) {
    const from = `${file}.${i}`
    if (existsSync(from)) renameSync(from, `${file}.${i + 1}`)
  }
  renameSync(file, `${file}.1`)
}

export function appendToFile(resourceId: string, line: LogLine): void {
  ensureDir()
  const file = pathFor(resourceId)
  rotateIfNeeded(file)
  appendFileSync(file, `${line.timestamp} ${line.stream} ${line.text}\n`)
}

export function appendManyToFile(
  resourceId: string,
  lines: readonly LogLine[],
): void {
  if (lines.length === 0) return
  ensureDir()
  const file = pathFor(resourceId)
  rotateIfNeeded(file)
  const body = lines
    .map((l) => `${l.timestamp} ${l.stream} ${l.text}\n`)
    .join("")
  appendFileSync(file, body)
}

export function removeLogFiles(resourceId: string): void {
  const file = pathFor(resourceId)
  for (const p of [
    file,
    ...Array.from({ length: KEEP }, (_, i) => `${file}.${i + 1}`),
  ]) {
    try {
      if (existsSync(p)) unlinkSync(p)
    } catch {
      // Best effort: a locked file must not break resource deletion.
    }
  }
}
