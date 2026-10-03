import { describe, expect, test } from "bun:test"
import { refusalMessage } from "./messages.ts"
import type { RefusalCode } from "./types.ts"

/**
 * Every code, as a `satisfies Record` so tsc fails this file the moment a
 * RefusalCode is added without being listed — and refusalMessage's own
 * `never` check fails the build without a sentence for it.
 */
const ALL = {
  "too-large": true,
  "yaml-invalid": true,
  "not-a-mapping": true,
  "no-services": true,
  "service-not-a-mapping": true,
  include: true,
  "extends-file": true,
  "env-file": true,
  "file-config": true,
  "file-secret": true,
  build: true,
  "no-image": true,
  "external-secret": true,
  privileged: true,
  "network-mode": true,
  "namespace-host": true,
  "bind-mount": true,
  "docker-socket": true,
  "volume-external": true,
  "volume-name": true,
  "volume-driver": true,
  "network-external": true,
  "network-name": true,
  "network-driver": true,
  "network-reserved": true,
  "cap-add": true,
  devices: true,
  gpus: true,
  runtime: true,
  "cgroup-parent": true,
  "security-opt": true,
  oom: true,
  "memory-unlimited": true,
  memswap: true,
  ports: true,
  "container-name": true,
  replicas: true,
  "volumes-from-container": true,
  "reserved-label": true,
  "logging-driver": true,
  "image-invalid": true,
  "external-links": true,
  "routed-unknown": true,
  "routed-network-mode": true,
  "routed-name": true,
  "unsupported-key": true,
  "network-ipam": true,
} satisfies Record<RefusalCode, true>

const CODES = Object.keys(ALL) as RefusalCode[]

describe("refusalMessage", () => {
  test("every code has its own sentence", () => {
    const seen = new Set<string>()
    for (const code of CODES) {
      const msg = refusalMessage({ code, service: null, field: null })
      expect(msg.length).toBeGreaterThan(10)
      expect(msg).not.toMatch(/undefined|null|\[object/)
      expect(msg.endsWith(".")).toBe(true)
      seen.add(msg)
    }
    expect(seen.size).toBe(CODES.length)
  })

  test("it names the service and the field, and interpolates nothing else", () => {
    for (const code of CODES) {
      const a = refusalMessage({ code, service: "svcAAA", field: "fldBBB" })
      const b = refusalMessage({ code, service: "svcCCC", field: "fldDDD" })
      expect(a).toContain("svcAAA")
      expect(a).toContain("fldBBB")
      // With the two inputs masked the sentences are identical: nothing else
      // in the line depends on the refusal — in particular no value.
      expect(a.replace("svcAAA", "S").replace("fldBBB", "F")).toBe(
        b.replace("svcCCC", "S").replace("fldDDD", "F"),
      )
    }
  })

  test("a file-level refusal reads as the file's", () => {
    expect(
      refusalMessage({ code: "include", service: null, field: "include" }),
    ).toMatch(/^The file, include: /)
    expect(
      refusalMessage({
        code: "privileged",
        service: "web",
        field: "privileged",
      }),
    ).toMatch(/^Service web, privileged: /)
  })
})
