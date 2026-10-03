import { describe, expect, test } from "bun:test"
import { isStackContainer, LABEL_SERVICE } from "../docker/client.ts"
import {
  composeDescriptor,
  composeProject,
  isOneShot,
  placeholderVars,
  primaryService,
  routedServicesFor,
  type StackContainerView,
  serviceVerdict,
  stackServicesDown,
} from "./compose-plan.ts"

describe("isStackContainer", () => {
  // reclaimStrays, runRemove's stray loop and the reconciler's per-resource
  // map all skip on this: on a stack, each of them would otherwise treat every
  // service but one as a leftover of the resource.
  test("a container with a musdash.service label is Compose's", () => {
    expect(
      isStackContainer({
        "musdash.managed": "true",
        "musdash.resource_id": "01ABC",
        [LABEL_SERVICE]: "db",
      }),
    ).toBe(true)
    // Present is enough, whatever its value.
    expect(isStackContainer({ [LABEL_SERVICE]: "" })).toBe(true)
  })

  test("an image or git resource's container, or a sidecar, is not", () => {
    expect(
      isStackContainer({
        "musdash.managed": "true",
        "musdash.resource_id": "01ABC",
        "musdash.deployment_id": "01DEF",
      }),
    ).toBe(false)
    expect(
      isStackContainer({ "musdash.managed": "true", "musdash.role": "proxy" }),
    ).toBe(false)
    // An inherited property is not a label.
    expect(isStackContainer(Object.create({ [LABEL_SERVICE]: "x" }))).toBe(
      false,
    )
  })
})

describe("stackServicesDown (the reconciler's stack rule)", () => {
  const up: StackContainerView = {
    running: true,
    state: "running",
    exitCode: null,
  }
  test("all running: nothing to heal", () => {
    expect(
      stackServicesDown(
        ["web", "db"],
        new Map([
          ["web", up],
          ["db", up],
        ]),
      ),
    ).toEqual([])
  })

  test("a missing service, or one that crashed, is down", () => {
    const crashed = { running: false, state: "exited", exitCode: 137 }
    expect(
      stackServicesDown(
        ["web", "db", "worker"],
        new Map([
          ["web", up],
          ["worker", crashed],
        ]),
      ),
    ).toEqual(["db", "worker"])
  })

  test("a one-shot that exited 0 is finished, not down", () => {
    const done = { running: false, state: "exited", exitCode: 0 }
    expect(
      stackServicesDown(
        ["web", "migrate"],
        new Map([
          ["web", up],
          ["migrate", done],
        ]),
      ),
    ).toEqual([])
  })

  test("restarting and created are down", () => {
    expect(
      stackServicesDown(
        ["a", "b"],
        new Map([
          ["a", { running: false, state: "restarting", exitCode: null }],
          ["b", { running: false, state: "created", exitCode: null }],
        ]),
      ),
    ).toEqual(["a", "b"])
  })
})

describe("serviceVerdict (the gate's rule for services without a route)", () => {
  const running = {
    state: "running",
    containerId: "c1",
    exitCode: null,
    restartCount: 0,
  }

  test("running and never restarted passes", () => {
    expect(serviceVerdict(running, undefined, "unless-stopped")).toEqual({
      ok: true,
    })
  })

  test("a restart since up fails at once; one from before up does not", () => {
    const restarted = { ...running, restartCount: 3 }
    // Same container as before up, which had 3 already: unchanged service.
    expect(
      serviceVerdict(
        restarted,
        { containerId: "c1", restartCount: 3 },
        "always",
      ),
    ).toEqual({ ok: true })
    // Same container, one more restart than before: it crashed.
    const v = serviceVerdict(
      { ...running, restartCount: 4 },
      { containerId: "c1", restartCount: 3 },
      "always",
    )
    expect(v).toMatchObject({ ok: false, final: true })
    // A recreated container starts from zero, whatever the old one had.
    expect(
      serviceVerdict(
        restarted,
        { containerId: "old", restartCount: 3 },
        "always",
      ),
    ).toMatchObject({ ok: false, final: true })
  })

  test("a one-shot that exited 0 passes; any other exit 0 waits", () => {
    const done = { ...running, state: "exited", exitCode: 0 }
    expect(serviceVerdict(done, undefined, "no")).toEqual({ ok: true })
    expect(serviceVerdict(done, undefined, "on-failure:3")).toEqual({
      ok: true,
    })
    expect(serviceVerdict(done, undefined, "unless-stopped")).toMatchObject({
      ok: false,
      final: false,
    })
  })

  test("a non-zero exit fails at once, naming the code", () => {
    const v = serviceVerdict(
      { ...running, state: "exited", exitCode: 1 },
      undefined,
      "no",
    )
    expect(v).toEqual({ ok: false, final: true, reason: "exited with code 1" })
  })

  test("no container yet waits", () => {
    expect(
      serviceVerdict(
        { state: null, containerId: null, exitCode: null, restartCount: 0 },
        undefined,
        undefined,
      ),
    ).toMatchObject({ ok: false, final: false })
  })

  test("isOneShot", () => {
    expect(isOneShot("no")).toBe(true)
    expect(isOneShot("on-failure")).toBe(true)
    expect(isOneShot("unless-stopped")).toBe(false)
    expect(isOneShot("always")).toBe(false)
    expect(isOneShot(undefined)).toBe(false)
  })
})

describe("names", () => {
  test("the project is musdash- and the lowercased resource id", () => {
    expect(composeProject("01J9ZABCDEFGHJKMNPQRSTVWXY")).toBe(
      "musdash-01j9zabcdefghjkmnpqrstvwxy",
    )
  })

  test("the descriptor is stable per text and names 12 hex", () => {
    const a = composeDescriptor("services:\n  web:\n    image: nginx\n")
    expect(a).toMatch(/^compose@sha256:[0-9a-f]{12}$/)
    expect(composeDescriptor("services:\n  web:\n    image: nginx\n")).toBe(a)
    expect(composeDescriptor("services: {}\n")).not.toBe(a)
  })

  test("the primary service is the public one, else the first", () => {
    expect(
      primaryService({ publicService: "web", services: ["db", "web"] }),
    ).toBe("web")
    expect(
      primaryService({ publicService: null, services: ["db", "web"] }),
    ).toBe("db")
    expect(primaryService({ publicService: null, services: [] })).toBeNull()
  })

  test("only a public service with a port and a host is routed", () => {
    expect(
      routedServicesFor({ publicService: "web", publicPort: 80 }, 1),
    ).toEqual(["web"])
    expect(
      routedServicesFor({ publicService: "web", publicPort: 80 }, 0),
    ).toEqual([])
    expect(
      routedServicesFor({ publicService: null, publicPort: null }, 2),
    ).toEqual([])
  })
})

describe("placeholderVars", () => {
  const refs = [
    { name: "SERVICE_PASSWORD_DB", hasDefault: false },
    { name: "SERVICE_USER_DB", hasDefault: false },
    { name: "SERVICE_FQDN_WEB_8080", hasDefault: false },
    { name: "SERVICE_URL_WEB", hasDefault: false },
    { name: "SERVICE_FQDN_API", hasDefault: false },
    { name: "PLAIN", hasDefault: false },
  ]
  const route = {
    publicService: "web",
    publicPort: 8080,
    autoHost: "shop-production.apps.example.test",
  }

  test("secrets for every secret placeholder, routes for the public service", () => {
    const vars = placeholderVars(refs, new Set(), route)
    const byKey = new Map(vars.map((v) => [v.key, v.value]))
    expect(byKey.get("SERVICE_PASSWORD_DB")).toMatch(/^[A-Za-z0-9]{32}$/)
    expect(byKey.get("SERVICE_USER_DB")).toMatch(/^[a-z]{16}$/)
    expect(byKey.get("SERVICE_FQDN_WEB_8080")).toBe(route.autoHost)
    expect(byKey.get("SERVICE_URL_WEB")).toBe(`https://${route.autoHost}`)
    // Another service, and a plain variable: left for the deploy to name.
    expect(byKey.has("SERVICE_FQDN_API")).toBe(false)
    expect(byKey.has("PLAIN")).toBe(false)
  })

  test("nothing already resolvable is generated again", () => {
    const vars = placeholderVars(
      refs,
      new Set(["SERVICE_PASSWORD_DB", "SERVICE_URL_WEB"]),
      route,
    )
    const keys = vars.map((v) => v.key)
    expect(keys).not.toContain("SERVICE_PASSWORD_DB")
    expect(keys).not.toContain("SERVICE_URL_WEB")
  })

  test("without a route (a settings save), only secrets", () => {
    const keys = placeholderVars(refs, new Set(), null).map((v) => v.key)
    expect(new Set(keys)).toEqual(
      new Set(["SERVICE_PASSWORD_DB", "SERVICE_USER_DB"]),
    )
  })

  test("a port that is not the public port is left unset", () => {
    const keys = placeholderVars(
      [{ name: "SERVICE_FQDN_WEB_3000", hasDefault: false }],
      new Set(),
      route,
    ).map((v) => v.key)
    expect(keys).toEqual([])
  })
})
