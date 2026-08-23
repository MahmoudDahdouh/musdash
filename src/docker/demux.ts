/**
 * Docker log stream demultiplexer.
 *
 * When TTY is disabled (which it must be), the Engine prefixes every payload
 * with an 8-byte header:
 *
 *   byte 0    stream type — 0 stdin, 1 stdout, 2 stderr
 *   bytes 1-3 zero padding
 *   bytes 4-7 payload length, big-endian uint32
 *   bytes 8+  payload
 *
 * The subtlety that makes this the most bug-prone code in the project: a chunk
 * off the socket has no relationship to a frame. One chunk may hold many
 * frames, half a frame, or — worst case — part of a header, so the length field
 * itself can arrive split across two reads. Measured against a real daemon
 * during the spike: 603,000 bytes of output arrived in 12 chunks with 3007-byte
 * payloads, so frames spanned chunk boundaries constantly.
 *
 * The rule is therefore: never consume until the whole frame is present. Keep a
 * carry buffer across chunks, and stop the moment the remainder is short —
 * either shorter than a header, or shorter than the payload the header
 * declares.
 */

export type StreamType = "stdout" | "stderr"

export interface Frame {
  stream: StreamType
  /** Raw payload bytes. Decoding is the caller's problem — a multi-byte UTF-8
   *  character can itself straddle two frames. */
  payload: Uint8Array
}

const HEADER_LEN = 8

/**
 * A payload length is a uint32, so a corrupt or hostile header could claim up
 * to 4GB and make us buffer forever. Docker never emits anything near this;
 * the cap turns a would-be OOM into a clean error.
 */
const MAX_PAYLOAD = 16 * 1024 * 1024

export class DemuxError extends Error {
  override readonly name = "DemuxError"
}

export interface Demuxer {
  /** Feed one chunk; returns every frame that became complete. */
  push(chunk: Uint8Array): Frame[]
  /** Bytes currently held back waiting for the rest of their frame. */
  pending(): number
}

export function createDemuxer(): Demuxer {
  let carry: Uint8Array = new Uint8Array(0)

  function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    if (a.length === 0) return b
    if (b.length === 0) return a
    const out: Uint8Array = new Uint8Array(a.length + b.length)
    out.set(a, 0)
    out.set(b, a.length)
    return out
  }

  return {
    push(chunk: Uint8Array): Frame[] {
      carry = concat(carry, chunk)
      const frames: Frame[] = []
      let offset = 0

      for (;;) {
        // Not even a full header yet — the length field may be split.
        if (carry.length - offset < HEADER_LEN) break

        const typeByte = carry[offset] as number
        const len =
          (((carry[offset + 4] as number) << 24) >>> 0) +
          ((carry[offset + 5] as number) << 16) +
          ((carry[offset + 6] as number) << 8) +
          (carry[offset + 7] as number)

        if (len > MAX_PAYLOAD) {
          throw new DemuxError(
            `frame declares ${len} bytes, above the ${MAX_PAYLOAD} cap`,
          )
        }

        // Header is complete but the payload is not: wait for more.
        if (carry.length - offset - HEADER_LEN < len) break

        const start = offset + HEADER_LEN
        // Zero-length payloads are legal and must advance the offset.
        frames.push({
          stream: typeByte === 2 ? "stderr" : "stdout",
          payload: carry.slice(start, start + len),
        })
        offset = start + len
      }

      // Retain only the unconsumed tail. slice() copies, which matters: holding
      // a subarray view would keep the whole original buffer alive.
      carry = offset === 0 ? carry : carry.slice(offset)
      return frames
    },

    pending(): number {
      return carry.length
    },
  }
}

/**
 * Turns frames into whole text lines. Kept separate from framing because the
 * two split differently: a line can span frames, and a UTF-8 sequence can span
 * either. `stream: true` on the decoder handles the latter.
 */
export interface LineAssembler {
  push(frame: Frame): { stream: StreamType; text: string }[]
  flush(): { stream: StreamType; text: string }[]
}

export function createLineAssembler(): LineAssembler {
  const partial: Record<StreamType, string> = { stdout: "", stderr: "" }
  const decoders: Record<StreamType, TextDecoder> = {
    stdout: new TextDecoder(),
    stderr: new TextDecoder(),
  }

  return {
    push(frame: Frame) {
      const decoded = decoders[frame.stream].decode(frame.payload, {
        stream: true,
      })
      const combined = partial[frame.stream] + decoded
      const parts = combined.split("\n")
      partial[frame.stream] = parts.pop() ?? ""
      return parts.map((text) => ({
        stream: frame.stream,
        text: text.replace(/\r$/, ""),
      }))
    },

    flush() {
      const out: { stream: StreamType; text: string }[] = []
      for (const s of ["stdout", "stderr"] as const) {
        if (partial[s].length > 0) {
          out.push({ stream: s, text: partial[s] })
          partial[s] = ""
        }
      }
      return out
    },
  }
}
