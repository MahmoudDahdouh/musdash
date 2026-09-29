import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  ComposeModelError,
  stackMemoryBytes,
  type TransformContext,
  transformModel,
} from "./transform.ts"
import { isRecord } from "./validate.ts"

const MIB = 1024 * 1024

function model(name: string): unknown {
  return JSON.parse(
    readFileSync(
      join(import.meta.dir, "fixtures", `${name}.normalized.json`),
      "utf8",
    ),
  )
}

function ctx(routedServices: string[]): TransformContext {
  return {
    project: "musdash-01jfixture",
    resourceId: "01JFIXTURE",
    projectId: "01JPROJECT",
    network: "musdash",
    routedServices,
    defaultMemoryBytes: 512 * MIB,
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("expected a mapping")
  return value
}

function service(out: unknown, name: string): Record<string, unknown> {
  return record(record(record(out).services)[name])
}

describe("transformModel on allowed.normalized.json, web routed", () => {
  const input = model("allowed")
  const before = JSON.stringify(input)
  const out = transformModel(input, ctx(["web"]))

  test("every service has the four ownership labels and no deployment id", () => {
    for (const name of ["web", "db"]) {
      const labels = record(service(out, name).labels)
      expect(labels).toEqual({
        "musdash.managed": "true",
        "musdash.resource_id": "01JFIXTURE",
        "musdash.project_id": "01JPROJECT",
        "musdash.service": name,
      })
      expect(Object.hasOwn(labels, "musdash.deployment_id")).toBe(false)
    }
  })

  test("memory: the default when absent, kept when set, swap equal", () => {
    expect(service(out, "db").mem_limit).toBe("536870912")
    expect(service(out, "db").memswap_limit).toBe("536870912")
    expect(service(out, "web").mem_limit).toBe("268435456")
    expect(service(out, "web").memswap_limit).toBe("268435456")
  })

  test("restart defaults to unless-stopped; logging is forced", () => {
    expect(service(out, "db").restart).toBe("unless-stopped")
    for (const name of ["web", "db"]) {
      expect(service(out, name).logging).toEqual({
        driver: "json-file",
        options: { "max-size": "10m", "max-file": "2" },
      })
    }
  })

  test("only the routed service joins musdash, and keeps its default network", () => {
    expect(service(out, "web").networks).toEqual({
      default: null,
      musdash: null,
    })
    expect(service(out, "db").networks).toEqual({ default: null })
    expect(record(record(out).networks).musdash).toEqual({
      name: "musdash",
      external: true,
    })
    expect(record(record(out).networks).default).toEqual({
      name: "musdash-01jfixture_default",
      ipam: {},
    })
  })

  test("declared volumes are labelled", () => {
    expect(record(record(out).volumes)["db-data"]).toEqual({
      name: "musdash-01jfixture_db-data",
      labels: {
        "musdash.managed": "true",
        "musdash.resource_id": "01JFIXTURE",
        "musdash.project_id": "01JPROJECT",
        "musdash.volume": "db-data",
      },
    })
  })

  test("the project name is set and other values are untouched", () => {
    expect(record(out).name).toBe("musdash-01jfixture")
    expect(service(out, "web").environment).toEqual({
      DATABASE_URL: "postgres://app:pw@db:5432/app",
      PUBLIC_URL: "https://web.example",
    })
    expect(record(out)["x-common"]).toEqual({ restart: "unless-stopped" })
  })

  test("the input is not mutated", () => {
    expect(JSON.stringify(input)).toBe(before)
  })

  test("stackMemoryBytes sums the effective limits", () => {
    expect(stackMemoryBytes(out)).toBe(268_435_456 + 536_870_912)
  })
})

describe("transformModel: other shapes", () => {
  test("with no routed service there is no musdash network anywhere", () => {
    const out = transformModel(model("allowed"), ctx([]))
    expect(JSON.stringify(out)).not.toContain('"musdash":')
    expect(Object.keys(record(record(out).networks))).toEqual(["default"])
    expect(service(out, "web").networks).toEqual({ default: null })
  })

  test("a deploy memory limit is kept and swap matches it", () => {
    const out = transformModel(model("deploy_memory"), ctx([]))
    const app = service(out, "app")
    expect(app.mem_limit).toBeUndefined()
    expect(record(record(record(app.deploy).resources).limits).memory).toBe(
      "314572800",
    )
    expect(app.memswap_limit).toBe("314572800")
    expect(stackMemoryBytes(out)).toBe(314_572_800)
  })

  test("an explicit restart is kept, including a one-shot's", () => {
    const m = {
      services: {
        once: { image: "busybox", restart: "no" },
        always: { image: "nginx", restart: "always" },
      },
    }
    const out = transformModel(m, ctx([]))
    expect(service(out, "once").restart).toBe("no")
    expect(service(out, "always").restart).toBe("always")
  })

  test("a routed service with no networks key gets default and musdash", () => {
    const m = { services: { app: { image: "nginx" } } }
    const out = transformModel(m, ctx(["app"]))
    expect(service(out, "app").networks).toEqual({
      default: null,
      musdash: null,
    })
  })

  test("user labels are kept beside the ownership labels", () => {
    const m = {
      services: { app: { image: "nginx", labels: { "com.example": "1" } } },
      volumes: { d: { name: "p_d", labels: { keep: "me" } } },
    }
    const out = transformModel(m, ctx([]))
    expect(record(service(out, "app").labels)["com.example"]).toBe("1")
    expect(record(record(record(out).volumes).d).labels).toEqual(
      expect.objectContaining({ keep: "me", "musdash.volume": "d" }),
    )
  })

  test("a model that breaks the precondition throws a typed error", () => {
    expect(() => transformModel(null, ctx([]))).toThrow(ComposeModelError)
    expect(() =>
      transformModel({ services: { app: { mem_limit: "-1" } } }, ctx([])),
    ).toThrow(ComposeModelError)
  })

  test("stackMemoryBytes of garbage is 0", () => {
    expect(stackMemoryBytes(null)).toBe(0)
    expect(stackMemoryBytes({ services: [] })).toBe(0)
  })
})
