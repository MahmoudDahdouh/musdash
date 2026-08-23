import type { LogLine } from "../docker/client.ts"

/**
 * Fixed-capacity ring buffer, 1000 lines per resource.
 *
 * Logs never go to SQLite — that would wreck both the RAM and the disk profile.
 * The implementation matters as much as the cap: a plain array with push() and
 * an occasional slice() still grows between trims and keeps the discarded
 * strings alive until GC. A pre-allocated ring overwrites in place, so memory
 * is bounded by construction rather than by remembering to trim.
 */

export const RING_CAPACITY = 1000

export class RingBuffer {
  private readonly items: (LogLine | undefined)[]
  private next = 0
  private count = 0

  constructor(readonly capacity: number = RING_CAPACITY) {
    this.items = new Array<LogLine | undefined>(capacity)
  }

  push(line: LogLine): void {
    this.items[this.next] = line
    this.next = (this.next + 1) % this.capacity
    if (this.count < this.capacity) this.count++
  }

  /** Oldest-first. `limit` returns only the most recent N. */
  toArray(limit = this.capacity): LogLine[] {
    const n = Math.min(limit, this.count)
    const out: LogLine[] = new Array<LogLine>(n)
    const start = (this.next - n + this.capacity * 2) % this.capacity
    for (let i = 0; i < n; i++) {
      out[i] = this.items[(start + i) % this.capacity] as LogLine
    }
    return out
  }

  get size(): number {
    return this.count
  }

  clear(): void {
    this.items.fill(undefined)
    this.next = 0
    this.count = 0
  }
}

/**
 * One buffer per resource. Buffers must be dropped when a resource is deleted,
 * or a long-lived process accumulates one per resource ever created — a slow
 * leak that only shows up after weeks of uptime.
 */
const buffers = new Map<string, RingBuffer>()

export function bufferFor(resourceId: string): RingBuffer {
  let b = buffers.get(resourceId)
  if (!b) {
    b = new RingBuffer()
    buffers.set(resourceId, b)
  }
  return b
}

export function appendLine(resourceId: string, line: LogLine): void {
  bufferFor(resourceId).push(line)
}

export function tail(resourceId: string, limit = 200): LogLine[] {
  return buffers.get(resourceId)?.toArray(limit) ?? []
}

export function dropBuffer(resourceId: string): void {
  buffers.delete(resourceId)
}

export function bufferCount(): number {
  return buffers.size
}
