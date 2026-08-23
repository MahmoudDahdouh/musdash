import { describe, expect, test } from "bun:test"
import {
  createDemuxer,
  createLineAssembler,
  DemuxError,
  type Frame,
} from "./demux.ts"

/** Builds one Docker log frame: 8-byte header + payload. */
function frame(stream: 1 | 2, text: string): Uint8Array {
  const payload = new TextEncoder().encode(text)
  const out = new Uint8Array(8 + payload.length)
  out[0] = stream
  const dv = new DataView(out.buffer)
  dv.setUint32(4, payload.length, false) // big-endian
  out.set(payload, 8)
  return out
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

const decodeFrame = (f: Frame) => new TextDecoder().decode(f.payload)

describe("createDemuxer", () => {
  test("decodes a single complete frame", () => {
    const d = createDemuxer()
    const frames = d.push(frame(1, "hello"))
    expect(frames).toHaveLength(1)
    expect(frames[0]?.stream).toBe("stdout")
    expect(decodeFrame(frames[0] as Frame)).toBe("hello")
    expect(d.pending()).toBe(0)
  })

  test("multiple complete frames in one chunk", () => {
    const d = createDemuxer()
    const frames = d.push(
      concat(frame(1, "one"), frame(2, "two"), frame(1, "three")),
    )
    expect(frames.map(decodeFrame)).toEqual(["one", "two", "three"])
    expect(frames.map((f) => f.stream)).toEqual(["stdout", "stderr", "stdout"])
    expect(d.pending()).toBe(0)
  })

  // The case that breaks naive implementations: the length field itself is
  // split, so the parser cannot even know how much to wait for.
  test("frame split mid-header emits nothing until complete", () => {
    const d = createDemuxer()
    const f = frame(1, "payload after split header")

    expect(d.push(f.slice(0, 3))).toHaveLength(0) // stopped inside the header
    expect(d.push(f.slice(3, 6))).toHaveLength(0) // still inside it
    const frames = d.push(f.slice(6))
    expect(frames).toHaveLength(1)
    expect(decodeFrame(frames[0] as Frame)).toBe("payload after split header")
    expect(d.pending()).toBe(0)
  })

  test("frame split mid-payload waits for the remainder", () => {
    const d = createDemuxer()
    const f = frame(2, "a longer payload that will be cut in half")
    const cut = 8 + 10

    expect(d.push(f.slice(0, cut))).toHaveLength(0)
    expect(d.pending()).toBe(cut)

    const frames = d.push(f.slice(cut))
    expect(frames).toHaveLength(1)
    expect(frames[0]?.stream).toBe("stderr")
    expect(decodeFrame(frames[0] as Frame)).toBe(
      "a longer payload that will be cut in half",
    )
  })

  test("zero-length payload is a real frame and advances the offset", () => {
    const d = createDemuxer()
    const frames = d.push(concat(frame(1, ""), frame(1, "after empty")))
    expect(frames).toHaveLength(2)
    expect(decodeFrame(frames[0] as Frame)).toBe("")
    expect(decodeFrame(frames[1] as Frame)).toBe("after empty")
  })

  // A payload may contain bytes that look exactly like a frame header. If the
  // parser ever rescans for a header instead of trusting the declared length,
  // it desynchronises here.
  test("payload containing header-looking bytes does not desync", () => {
    const fake = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 5])
    const payload = concat(new TextEncoder().encode("x"), fake)
    const out = new Uint8Array(8 + payload.length)
    out[0] = 1
    new DataView(out.buffer).setUint32(4, payload.length, false)
    out.set(payload, 8)

    const d = createDemuxer()
    const frames = d.push(concat(out, frame(1, "next")))
    expect(frames).toHaveLength(2)
    expect(frames[0]?.payload.length).toBe(payload.length)
    expect(decodeFrame(frames[1] as Frame)).toBe("next")
  })

  // Pathological delivery: one byte at a time exercises every partial-state
  // branch at once.
  test("byte-at-a-time delivery reassembles every frame", () => {
    const stream = concat(
      frame(1, "first line"),
      frame(2, "second line"),
      frame(1, ""),
      frame(1, "third line with more text"),
    )
    const d = createDemuxer()
    const collected: Frame[] = []
    for (const byte of stream) collected.push(...d.push(new Uint8Array([byte])))

    expect(collected.map(decodeFrame)).toEqual([
      "first line",
      "second line",
      "",
      "third line with more text",
    ])
    expect(d.pending()).toBe(0)
  })

  test("interleaved stdout and stderr preserve their stream type", () => {
    const d = createDemuxer()
    const frames = d.push(
      concat(frame(1, "o1"), frame(2, "e1"), frame(2, "e2"), frame(1, "o2")),
    )
    expect(frames.map((f) => `${f.stream}:${decodeFrame(f)}`)).toEqual([
      "stdout:o1",
      "stderr:e1",
      "stderr:e2",
      "stdout:o2",
    ])
  })

  test("large realistic payload split across many chunks", () => {
    // Mirrors what the spike saw: 3007-byte payloads, chunks that do not align.
    const body = "x".repeat(3007)
    const stream = concat(...Array.from({ length: 20 }, () => frame(1, body)))
    const d = createDemuxer()
    const collected: Frame[] = []
    for (let i = 0; i < stream.length; i += 1500) {
      collected.push(...d.push(stream.slice(i, i + 1500)))
    }
    expect(collected).toHaveLength(20)
    expect(collected.every((f) => decodeFrame(f) === body)).toBe(true)
    expect(d.pending()).toBe(0)
  })

  test("stdin frames (type 0) are treated as stdout", () => {
    const d = createDemuxer()
    const f = frame(1, "x")
    f[0] = 0
    expect(d.push(f)[0]?.stream).toBe("stdout")
  })

  test("an absurd declared length throws instead of buffering forever", () => {
    const bad = new Uint8Array(8)
    bad[0] = 1
    new DataView(bad.buffer).setUint32(4, 0xffffffff, false)
    expect(() => createDemuxer().push(bad)).toThrow(DemuxError)
  })
})

describe("createLineAssembler", () => {
  test("joins a line split across two frames", () => {
    const a = createLineAssembler()
    expect(a.push({ stream: "stdout", payload: enc("par") })).toEqual([])
    expect(a.push({ stream: "stdout", payload: enc("tial\n") })).toEqual([
      { stream: "stdout", text: "partial" },
    ])
  })

  test("splits several lines in one frame and strips CR", () => {
    const a = createLineAssembler()
    expect(a.push({ stream: "stdout", payload: enc("a\r\nb\nc\n") })).toEqual([
      { stream: "stdout", text: "a" },
      { stream: "stdout", text: "b" },
      { stream: "stdout", text: "c" },
    ])
  })

  test("keeps stdout and stderr partials independent", () => {
    const a = createLineAssembler()
    a.push({ stream: "stdout", payload: enc("out-") })
    a.push({ stream: "stderr", payload: enc("err-") })
    expect(a.push({ stream: "stderr", payload: enc("done\n") })).toEqual([
      { stream: "stderr", text: "err-done" },
    ])
    expect(a.push({ stream: "stdout", payload: enc("done\n") })).toEqual([
      { stream: "stdout", text: "out-done" },
    ])
  })

  test("a multi-byte character split across frames survives", () => {
    const euro = new TextEncoder().encode("€") // 3 bytes
    const a = createLineAssembler()
    expect(a.push({ stream: "stdout", payload: euro.slice(0, 2) })).toEqual([])
    const out = a.push({
      stream: "stdout",
      payload: new Uint8Array([...euro.slice(2), 0x0a]),
    })
    expect(out).toEqual([{ stream: "stdout", text: "€" }])
  })

  test("flush emits a trailing line with no newline", () => {
    const a = createLineAssembler()
    a.push({ stream: "stdout", payload: enc("no trailing newline") })
    expect(a.flush()).toEqual([
      { stream: "stdout", text: "no trailing newline" },
    ])
    expect(a.flush()).toEqual([])
  })
})

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}
