import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Refusal, RefusalCode } from "./types.ts"
import { validateModel } from "./validate.ts"

/**
 * Every model here is real `docker compose config --format json` output from
 * Compose v5.5.1 (D65), never a hand-written shape: the rules compare fields,
 * and a guessed shape would test a comparison against nothing.
 */

const FIXTURES = join(import.meta.dir, "fixtures")
const PROJECT = "musdash-01jfixture"

function model(name: string): unknown {
  return JSON.parse(
    readFileSync(join(FIXTURES, `${name}.normalized.json`), "utf8"),
  )
}

function validate(name: string, routedServices: string[] = []): Refusal[] {
  return validateModel(model(name), { project: PROJECT, routedServices })
}

describe("validateModel: every §3.3 rule refuses its fixture", () => {
  const cases: [fixture: string, code: RefusalCode, service: string | null][] =
    [
      ["privileged", "privileged", "app"],
      ["network_mode_host", "network-mode", "app"],
      ["network_mode_container", "network-mode", "app"],
      ["pid_host", "namespace-host", "app"],
      ["ipc_host", "namespace-host", "app"],
      ["uts_host", "namespace-host", "app"],
      ["userns_host", "namespace-host", "app"],
      ["cgroup_host", "namespace-host", "app"],
      ["bind_relative", "bind-mount", "app"],
      ["bind_absolute", "bind-mount", "app"],
      ["bind_long", "bind-mount", "app"],
      ["docker_sock", "docker-socket", "app"],
      ["volume_external", "volume-external", null],
      ["volume_named", "volume-name", null],
      ["network_external", "network-external", null],
      ["network_named", "network-name", null],
      ["cap_add", "cap-add", "app"],
      ["devices", "devices", "app"],
      ["device_cgroup_rules", "devices", "app"],
      ["gpus", "gpus", "app"],
      ["runtime", "runtime", "app"],
      ["cgroup_parent", "cgroup-parent", "app"],
      ["seccomp_unconfined", "security-opt", "app"],
      ["apparmor_unconfined", "security-opt", "app"],
      ["label_disable", "security-opt", "app"],
      ["oom_kill_disable", "oom", "app"],
      ["oom_score_adj", "oom", "app"],
      ["mem_unlimited", "memory-unlimited", "app"],
      ["memswap_bigger", "memswap", "app"],
      ["memswap_unlimited", "memswap", "app"],
      ["ports_published", "ports", "app"],
      ["ports_ephemeral", "ports", "app"],
      ["container_name", "container-name", "app"],
      ["replicas", "replicas", "app"],
      ["scale", "replicas", "app"],
      ["build", "build", "app"],
      ["volumes_from_container", "volumes-from-container", "app"],
      ["label_musdash", "reserved-label", "app"],
      ["label_compose", "reserved-label", "app"],
      ["logging_syslog", "logging-driver", "app"],
      ["image_uppercase", "image-invalid", "app"],
    ]

  for (const [fixture, code, service] of cases) {
    test(`${fixture} → ${code} on ${service ?? "the file"}`, () => {
      const refusals = validate(fixture)
      expect(refusals).toContainEqual(
        expect.objectContaining({ code, service }),
      )
    })
  }

  test("the fields name keys and indexes", () => {
    expect(validate("bind_absolute")).toEqual([
      { code: "bind-mount", service: "app", field: "volumes[0]" },
    ])
    expect(validate("docker_sock")).toEqual([
      { code: "docker-socket", service: "app", field: "volumes[0]" },
    ])
    expect(validate("label_musdash")).toEqual([
      {
        code: "reserved-label",
        service: "app",
        field: "labels.musdash.resource_id",
      },
    ])
    expect(validate("pid_host")).toEqual([
      { code: "namespace-host", service: "app", field: "pid" },
    ])
    expect(validate("seccomp_unconfined")).toEqual([
      { code: "security-opt", service: "app", field: "security_opt[0]" },
    ])
  })

  test("an external volume is refused for both external and its foreign name", () => {
    expect(validate("volume_external")).toEqual([
      { code: "volume-external", service: null, field: "volumes.caddy" },
      { code: "volume-name", service: null, field: "volumes.caddy" },
    ])
  })

  // Pinned reading of the networks rule: each check stands alone, and a
  // network NAMED musdash is reserved as well as a key named musdash.
  test("a network named musdash is reserved, external and foreign at once", () => {
    expect(validate("network_external")).toEqual([
      { code: "network-external", service: null, field: "networks.other" },
      { code: "network-name", service: null, field: "networks.other" },
      { code: "network-reserved", service: null, field: "networks.other" },
    ])
    expect(validate("network_named")).toEqual([
      { code: "network-name", service: null, field: "networks.other" },
      { code: "network-reserved", service: null, field: "networks.other" },
    ])
  })

  test("a user network keyed musdash is reserved even with the project's name", () => {
    const m = {
      services: { app: { image: "nginx", networks: { musdash: null } } },
      networks: { musdash: { name: `${PROJECT}_musdash` } },
    }
    expect(validateModel(m, { project: PROJECT, routedServices: [] })).toEqual([
      { code: "network-reserved", service: null, field: "networks.musdash" },
    ])
  })
})

describe("validateModel: the allowed twins pass", () => {
  for (const fixture of [
    "allowed",
    "network_mode_none",
    "network_mode_service",
    "volumes_from_service",
    "secret_env",
    "deploy_memory",
  ]) {
    test(fixture, () => {
      expect(validate(fixture)).toEqual([])
    })
  }
})

describe("validateModel: routed services", () => {
  test("a routed service not in the stack is routed-unknown", () => {
    expect(validate("allowed", ["web", "api"])).toEqual([
      { code: "routed-unknown", service: "api", field: null },
    ])
  })

  test("routing web and db of the allowed stack passes", () => {
    expect(validate("allowed", ["web", "db"])).toEqual([])
  })

  test("a routed service in another's network namespace is refused", () => {
    expect(validate("network_mode_service", ["app"])).toEqual([
      { code: "routed-network-mode", service: "app", field: "network_mode" },
    ])
    expect(validate("network_mode_service", ["side"])).toEqual([])
  })

  test("network_mode none is allowed, but not on a routed service", () => {
    expect(validate("network_mode_none", ["app"])).toEqual([
      { code: "routed-network-mode", service: "app", field: "network_mode" },
    ])
  })
})

describe("validateModel: no value ever reaches a refusal", () => {
  // Concrete values from the fixtures that a careless `field` would carry.
  const VALUES = [
    "musdash-caddy",
    "musdash-other",
    "/etc",
    "/host",
    "/srv/musdash-fixture",
    "/var/run/docker.sock",
    "/dev/sda",
    "/system.slice",
    "8080",
    "NET_ADMIN",
    "unconfined",
    "label=disable",
    "syslog",
    "runc",
    "Nginx",
    "1073741824",
    "-500",
    "c 1:3",
  ]
  const fixtures = readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".normalized.json"))
    .map((f) => f.slice(0, -".normalized.json".length))

  test("across every fixture", () => {
    expect(fixtures.length).toBeGreaterThan(40)
    for (const fixture of fixtures) {
      const text = JSON.stringify(validate(fixture, ["app"]))
      for (const value of VALUES) {
        if (text.includes(value)) {
          throw new Error(`${fixture}: a refusal carries the value ${value}`)
        }
      }
    }
  })
})

describe("validateModel: stricter readings, pinned", () => {
  const ctx = { project: PROJECT, routedServices: [] }
  const one = (svc: Record<string, unknown>): Refusal[] =>
    validateModel({ services: { app: { image: "nginx", ...svc } } }, ctx)

  test("garbage input is one no-services refusal, never a throw", () => {
    for (const m of [
      null,
      1,
      "x",
      [],
      {},
      { services: [] },
      { services: {} },
    ]) {
      expect(validateModel(m, ctx)).toEqual([
        { code: "no-services", service: null, field: "services" },
      ])
    }
  })

  test("a service that is not a mapping", () => {
    expect(validateModel({ services: { app: "nginx" } }, ctx)).toEqual([
      { code: "service-not-a-mapping", service: "app", field: null },
    ])
  })

  test("a service with no image is refused here too", () => {
    expect(validateModel({ services: { app: {} } }, ctx)).toEqual([
      { code: "no-image", service: "app", field: "image" },
    ])
  })

  test("the docker socket by /run, or with extra slashes", () => {
    for (const source of ["/run/docker.sock", "/var/run//docker.sock/"]) {
      expect(
        one({ volumes: [{ type: "bind", source, target: "/s" }] }),
      ).toEqual([
        { code: "docker-socket", service: "app", field: "volumes[0]" },
      ])
    }
  })

  test("mount types: only volume, tmpfs and image pass", () => {
    const vols = [
      { type: "npipe", source: "x", target: "/a" },
      { type: "cluster", source: "x", target: "/b" },
      { type: "future", source: "x", target: "/c" },
      { source: "x", target: "/d" },
      { type: "tmpfs", target: "/e" },
      { type: "image", source: "busybox", target: "/f" },
      { type: "volume", target: "/g" },
      { type: "volume", source: "undeclared", target: "/h" },
      { type: "image", source: "Bad Image", target: "/i" },
      { type: "image", target: "/j" },
    ]
    expect(one({ volumes: vols })).toEqual([
      { code: "bind-mount", service: "app", field: "volumes[0]" },
      { code: "bind-mount", service: "app", field: "volumes[1]" },
      { code: "bind-mount", service: "app", field: "volumes[2]" },
      { code: "bind-mount", service: "app", field: "volumes[3]" },
      { code: "volume-name", service: "app", field: "volumes[7]" },
      { code: "image-invalid", service: "app", field: "volumes[8]" },
      { code: "image-invalid", service: "app", field: "volumes[9]" },
    ])
  })

  test("memswap without a limit is refused; equal to the limit passes", () => {
    expect(one({ memswap_limit: "134217728" })).toEqual([
      { code: "memswap", service: "app", field: "memswap_limit" },
    ])
    expect(one({ mem_limit: "134217728", memswap_limit: "134217728" })).toEqual(
      [],
    )
    expect(
      one({
        deploy: { resources: { limits: { memory: "134217728" } } },
        memswap_limit: "134217728",
      }),
    ).toEqual([])
  })

  test("an unreadable or zero memory limit is unlimited", () => {
    expect(one({ mem_limit: "lots" })).toEqual([
      { code: "memory-unlimited", service: "app", field: "mem_limit" },
    ])
    expect(one({ deploy: { resources: { limits: { memory: "0" } } } })).toEqual(
      [
        {
          code: "memory-unlimited",
          service: "app",
          field: "deploy.resources.limits.memory",
        },
      ],
    )
  })

  test("security_opt: a seccomp profile from a host file is refused", () => {
    expect(
      one({
        security_opt: [
          "no-new-privileges:true",
          "seccomp=/etc/profile.json",
          "label=user:USER",
          "SYSTEMPATHS=UNCONFINED",
          "label=type:spc_t",
          "label:disable",
          "label=level:s0:c100,c200",
        ],
      }),
    ).toEqual([
      { code: "security-opt", service: "app", field: "security_opt[1]" },
      { code: "security-opt", service: "app", field: "security_opt[3]" },
      { code: "security-opt", service: "app", field: "security_opt[4]" },
      { code: "security-opt", service: "app", field: "security_opt[5]" },
    ])
  })

  test("pid and ipc joining a container; ipc shareable passes", () => {
    expect(one({ pid: "container:x", ipc: "shareable" })).toEqual([
      { code: "namespace-host", service: "app", field: "pid" },
    ])
  })

  test("device reservations and privileged hooks", () => {
    expect(
      one({
        deploy: {
          resources: { reservations: { devices: [{ capabilities: ["gpu"] }] } },
        },
      }),
    ).toEqual([
      {
        code: "devices",
        service: "app",
        field: "deploy.resources.reservations.devices",
      },
    ])
    expect(
      one({
        post_start: [{ command: "x" }, { command: "y", privileged: true }],
      }),
    ).toEqual([{ code: "privileged", service: "app", field: "post_start[1]" }])
  })

  test("top-level volume and network drivers, and file-backed configs", () => {
    const m = {
      services: { app: { image: "nginx" } },
      volumes: {
        a: { name: `${PROJECT}_a`, driver: "local" },
        b: { name: `${PROJECT}_b`, driver_opts: { device: "/etc" } },
        c: { name: `${PROJECT}_c`, driver: "nfs" },
      },
      networks: {
        default: { name: `${PROJECT}_default`, driver: "bridge" },
        n: { name: `${PROJECT}_n`, driver: "macvlan" },
      },
      configs: { f: { file: "/etc/shadow" } },
      secrets: { s: { file: "/root/x" }, e: { external: true } },
    }
    expect(validateModel(m, { project: PROJECT, routedServices: [] })).toEqual([
      { code: "file-config", service: null, field: "configs.f" },
      { code: "network-driver", service: null, field: "networks.n" },
      { code: "external-secret", service: null, field: "secrets.e" },
      { code: "file-secret", service: null, field: "secrets.s" },
      { code: "volume-driver", service: null, field: "volumes.b" },
      { code: "volume-driver", service: null, field: "volumes.c" },
    ])
  })

  test("a network that picks its own IPAM is refused; Compose's ipam: {} is not", () => {
    const m = {
      services: { app: { image: "nginx" } },
      networks: {
        default: { name: `${PROJECT}_default`, ipam: {} },
        a: {
          name: `${PROJECT}_a`,
          ipam: { config: [{ subnet: "10.9.0.0/16" }] },
        },
        b: { name: `${PROJECT}_b`, ipam: { driver: "x" } },
        c: { name: `${PROJECT}_c`, ipam: "x" },
      },
    }
    expect(validateModel(m, ctx)).toEqual([
      { code: "network-ipam", service: null, field: "networks.a.ipam" },
      { code: "network-ipam", service: null, field: "networks.b.ipam" },
      { code: "network-ipam", service: null, field: "networks.c.ipam" },
    ])
    const text = JSON.stringify(validateModel(m, ctx))
    expect(text).not.toContain("10.9.0.0")
  })

  test("reserved labels on declared volumes and networks", () => {
    const m = {
      services: { app: { image: "nginx" } },
      volumes: {
        v: {
          name: `${PROJECT}_v`,
          labels: { "musdash.resource_id": "X", ok: "1" },
        },
      },
      networks: {
        n: {
          name: `${PROJECT}_n`,
          labels: { "com.docker.compose.project": "other" },
        },
      },
    }
    expect(validateModel(m, ctx)).toEqual([
      {
        code: "reserved-label",
        service: null,
        field: "networks.n.labels.com.docker.compose.project",
      },
      {
        code: "reserved-label",
        service: null,
        field: "volumes.v.labels.musdash.resource_id",
      },
    ])
  })

  test("refusals are ordered: the file first, then by service and field", () => {
    const m = {
      services: {
        zed: { image: "nginx", privileged: true, cap_add: ["X"] },
        alpha: { image: "nginx", ports: [{ target: 80 }] },
      },
      volumes: { v: { name: "other" } },
    }
    expect(
      validateModel(m, { project: PROJECT, routedServices: [] }).map((r) => [
        r.service,
        r.field,
      ]),
    ).toEqual([
      [null, "volumes.v"],
      ["alpha", "ports"],
      ["zed", "cap_add"],
      ["zed", "privileged"],
    ])
  })
})

describe("validateModel: the key allowlists", () => {
  const ctx = { project: PROJECT, routedServices: [] }

  // Each of these either reads a host file during `config` (label_file, and
  // env_file, which Compose inlines — so the prescan is what really stops
  // it), runs something on the host (provider, models), or reaches the
  // Engine (use_api_socket). The last is simply unknown.
  test("unreviewed service keys are refused by path", () => {
    const svc = {
      image: "nginx",
      label_file: "/root/x.env",
      models: ["m"],
      develop: { watch: [] },
      provider: { type: "model" },
      use_api_socket: true,
      blkio_config: { weight: 10 },
      frobnicate: 1,
      "x-extension": { any: "thing" },
    }
    expect(validateModel({ services: { app: svc } }, ctx)).toEqual(
      [
        "blkio_config",
        "develop",
        "frobnicate",
        "label_file",
        "models",
        "provider",
        "use_api_socket",
      ].map((field) => ({ code: "unsupported-key", service: "app", field })),
    )
  })

  test("env_file and build keep their own codes", () => {
    expect(
      validateModel(
        { services: { app: { image: "nginx", env_file: [], build: null } } },
        ctx,
      ),
    ).toEqual([
      { code: "build", service: "app", field: "build" },
      { code: "env-file", service: "app", field: "env_file" },
    ])
  })

  test("unreviewed top-level keys, including models and include", () => {
    const m = {
      services: { app: { image: "nginx" } },
      models: { m: { model: "ai/x" } },
      include: ["/root/x.yaml"],
      frobnicate: {},
      version: "3.9",
      "x-anything": {},
    }
    expect(validateModel(m, ctx)).toEqual([
      { code: "unsupported-key", service: null, field: "frobnicate" },
      { code: "include", service: null, field: "include" },
      { code: "unsupported-key", service: null, field: "models" },
    ])
  })

  test("nested keys of configs, secrets, volumes and networks", () => {
    const m = {
      services: { app: { image: "nginx" } },
      configs: {
        c: {
          name: `${PROJECT}_c`,
          content: "x",
          template_driver: "golang",
          x: 1,
        },
      },
      secrets: { s: { name: `${PROJECT}_s`, environment: "T", driver: "d" } },
      volumes: { v: { name: `${PROJECT}_v`, labels: {}, device: "/dev/sda" } },
      networks: {
        n: {
          name: `${PROJECT}_n`,
          internal: true,
          attachable: true,
          enable_ipv6: false,
          enable_ipv4: true,
          ipam: {},
          priority: 1,
        },
      },
    }
    expect(validateModel(m, ctx)).toEqual([
      { code: "unsupported-key", service: null, field: "configs.c.x" },
      { code: "unsupported-key", service: null, field: "networks.n.priority" },
      { code: "unsupported-key", service: null, field: "secrets.s.driver" },
      { code: "unsupported-key", service: null, field: "volumes.v.device" },
    ])
  })

  test("every key Compose writes into the fixtures is allowed", () => {
    // `command: null`, `ipam: {}`, depends_on's `required`/`restart`, the
    // names Compose adds: the allowed twins passing above covers these; this
    // pins that no fixture refusal anywhere is an unsupported key.
    for (const f of readdirSync(FIXTURES)) {
      if (!f.endsWith(".normalized.json")) continue
      const refusals = validateModel(
        JSON.parse(readFileSync(join(FIXTURES, f), "utf8")),
        ctx,
      )
      expect(refusals.filter((r) => r.code === "unsupported-key")).toEqual([])
    }
  })
})
