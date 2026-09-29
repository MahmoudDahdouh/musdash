// biome-ignore-all lint/suspicious/noTemplateCurlyInString: ${VAR} in a plain
// string is the Compose interpolation under test here, not a mistyped template
// literal. The rule stays on everywhere else, where it is catching a real bug.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { MAX_COMPOSE_BYTES, prescanCompose } from "./prescan.ts"
import type { RefusalCode } from "./types.ts"

/**
 * The prescan's host-file checks run before `docker compose config`, which
 * reads files as root (D65 item 2); those must not miss. Its other checks are
 * form feedback, and validateModel stays the authority.
 */

function raw(name: string): string {
  return readFileSync(join(import.meta.dir, "fixtures", `${name}.yaml`), "utf8")
}

function codes(text: string): RefusalCode[] {
  return prescanCompose(text).refusals.map((r) => r.code)
}

describe("prescanCompose: raw fixtures", () => {
  const cases: [fixture: string, code: RefusalCode][] = [
    ["privileged", "privileged"],
    ["build", "build"],
    ["ports_published", "ports"],
    ["ports_ephemeral", "ports"],
    ["container_name", "container-name"],
    ["cap_add", "cap-add"],
    ["devices", "devices"],
    ["bind_relative", "bind-mount"],
    ["bind_absolute", "bind-mount"],
    ["bind_long", "bind-mount"],
    ["docker_sock", "docker-socket"],
    ["network_mode_host", "network-mode"],
    ["no_image", "no-image"],
  ]
  for (const [fixture, code] of cases) {
    test(`${fixture} → ${code} on app`, () => {
      expect(prescanCompose(raw(fixture)).refusals).toContainEqual(
        expect.objectContaining({ code, service: "app" }),
      )
    })
  }

  test("the docker socket is reported as itself, not as a bind mount", () => {
    expect(prescanCompose(raw("docker_sock")).refusals).toEqual([
      { code: "docker-socket", service: "app", field: "volumes[0]" },
    ])
  })

  test("allowed.yaml passes, services in file order", () => {
    const result = prescanCompose(raw("allowed"))
    expect(result.refusals).toEqual([])
    expect(result.services).toEqual(["web", "db", "migrate"])
  })

  for (const fixture of [
    "network_mode_none",
    "network_mode_service",
    "volumes_from_service",
    "secret_env",
    "deploy_memory",
  ]) {
    test(`${fixture} passes`, () => {
      expect(prescanCompose(raw(fixture)).refusals).toEqual([])
    })
  }
})

describe("prescanCompose: host-file reads and file shape", () => {
  test("include", () => {
    expect(
      prescanCompose("include: [/root/x.yaml]\nservices: {a: {image: nginx}}\n")
        .refusals,
    ).toEqual([{ code: "include", service: null, field: "include" }])
  })

  test("extends with a file is refused; extends within the file is not", () => {
    expect(
      prescanCompose(
        "services: {a: {extends: {file: /root/c.yaml, service: x}}}",
      ).refusals,
    ).toEqual([{ code: "extends-file", service: "a", field: "extends.file" }])
    expect(
      codes("services: {base: {image: nginx}, a: {extends: base}}"),
    ).toEqual([])
    expect(
      codes("services: {base: {image: nginx}, a: {extends: {service: base}}}"),
    ).toEqual([])
  })

  test("env_file, even empty", () => {
    expect(
      codes("services: {a: {image: nginx, env_file: /root/.env}}"),
    ).toEqual(["env-file"])
    expect(codes("services: {a: {image: nginx, env_file: }}")).toEqual([
      "env-file",
    ])
  })

  test("file-backed configs and secrets, and external secrets", () => {
    const text = [
      "services: {a: {image: nginx}}",
      "configs: {c: {file: /etc/shadow}, ok: {content: x}}",
      "secrets: {s: {file: /root/k}, e: {external: true}, env: {environment: T}}",
    ].join("\n")
    expect(prescanCompose(text).refusals).toEqual([
      { code: "file-config", service: null, field: "configs.c" },
      { code: "external-secret", service: null, field: "secrets.e" },
      { code: "file-secret", service: null, field: "secrets.s" },
    ])
  })

  test("too large: one byte over 128 KiB, counted in bytes", () => {
    expect(MAX_COMPOSE_BYTES).toBe(128 * 1024)
    const base = "services: {a: {image: nginx}}\n#"
    const exact = base + "x".repeat(MAX_COMPOSE_BYTES - base.length)
    expect(codes(exact)).toEqual([])
    const over = `${exact}x`
    expect(prescanCompose(over)).toEqual({
      refusals: [{ code: "too-large", service: null, field: null }],
      services: [],
      references: [],
    })
    // 43,691 three-byte characters: under the cap in length, over it in bytes.
    expect(codes(`#${"€".repeat(43_691)}`)).toEqual(["too-large"])
  })

  test("invalid YAML is refused without the parser's message", () => {
    const result = prescanCompose("services: {a: [\npassword: hunter2")
    expect(result.refusals).toEqual([
      { code: "yaml-invalid", service: null, field: null },
    ])
    expect(JSON.stringify(result)).not.toContain("hunter2")
  })

  test("a root that is not a mapping", () => {
    for (const text of ["- a\n- b\n", "just text", "", "a: 1\n---\nb: 2\n"]) {
      expect(codes(text)).toEqual(["not-a-mapping"])
    }
  })

  test("services missing, empty, or not a mapping", () => {
    for (const text of [
      "volumes: {v: {}}",
      "services: {}",
      "services: [a]",
      "services:",
    ]) {
      expect(prescanCompose(text)).toEqual({
        refusals: [{ code: "no-services", service: null, field: "services" }],
        services: [],
        references: [],
      })
    }
  })

  test("a service that is not a mapping", () => {
    expect(prescanCompose("services: {a: nginx, b: {image: x}}")).toEqual({
      refusals: [{ code: "service-not-a-mapping", service: "a", field: null }],
      services: ["a", "b"],
      references: [],
    })
  })

  test("anchors and merges are resolved before the checks", () => {
    const text = [
      "x-base: &base {image: nginx, privileged: true}",
      "services:",
      "  a:",
      "    <<: *base",
    ].join("\n")
    expect(prescanCompose(text).refusals).toEqual([
      { code: "privileged", service: "a", field: "privileged" },
    ])
  })

  test("network_mode: another service passes, container:* does not", () => {
    expect(
      codes(
        "services: {a: {image: x, network_mode: 'service:b'}, b: {image: y}}",
      ),
    ).toEqual([])
    expect(
      codes("services: {a: {image: x, network_mode: 'service:nope'}}"),
    ).toEqual(["network-mode"])
    expect(
      codes("services: {a: {image: x, network_mode: 'container:caddy'}}"),
    ).toEqual(["network-mode"])
  })

  test("empty ports, cap_add and devices pass, as in validateModel", () => {
    expect(
      codes("services: {a: {image: x, ports: [], cap_add: [], devices: []}}"),
    ).toEqual([])
  })
})

describe("prescanCompose: the key allowlists", () => {
  // label_file was confirmed on the VPS (Compose v5.5.1) to read /root/x.env
  // into `config` output and leak /etc/shadow fragments into its warnings.
  test("label_file is refused before config can read it", () => {
    expect(
      prescanCompose("services: {a: {image: nginx, label_file: /etc/shadow}}")
        .refusals,
    ).toEqual([{ code: "unsupported-key", service: "a", field: "label_file" }])
  })

  test("unreviewed service keys, and a harmless unknown one", () => {
    const text = [
      "services:",
      "  a:",
      "    image: nginx",
      "    models: [m]",
      "    develop: {watch: []}",
      "    provider: {type: model}",
      "    use_api_socket: true",
      "    blkio_config: {weight: 10}",
      "    colour: blue",
      "    x-note: fine",
    ].join("\n")
    expect(prescanCompose(text).refusals).toEqual(
      [
        "blkio_config",
        "colour",
        "develop",
        "models",
        "provider",
        "use_api_socket",
      ].map((field) => ({ code: "unsupported-key", service: "a", field })),
    )
  })

  test("top-level models and unknown keys; name, version and x-* pass", () => {
    const text = [
      "name: mine",
      "version: '3.9'",
      "x-anything: {a: 1}",
      "models: {m: {model: ai/x}}",
      "colour: blue",
      "services: {a: {image: nginx}}",
    ].join("\n")
    expect(prescanCompose(text).refusals).toEqual([
      { code: "unsupported-key", service: null, field: "colour" },
      { code: "unsupported-key", service: null, field: "models" },
    ])
  })

  test("nested keys of extends, configs, secrets, volumes and networks", () => {
    const text = [
      "services:",
      "  base: {image: nginx}",
      "  a: {extends: {service: base, from: elsewhere}}",
      "configs: {c: {content: x, driver: d}}",
      "secrets: {s: {environment: T, x-y: 1}}",
      "volumes: {v: {driver: local, labels: {}, size: 1}}",
      "networks: {n: {internal: true, ipam: {}, priority: 1}}",
    ].join("\n")
    expect(prescanCompose(text).refusals).toEqual([
      { code: "unsupported-key", service: null, field: "configs.c.driver" },
      { code: "unsupported-key", service: null, field: "networks.n.priority" },
      { code: "unsupported-key", service: null, field: "secrets.s.x-y" },
      { code: "unsupported-key", service: null, field: "volumes.v.size" },
      { code: "unsupported-key", service: "a", field: "extends.from" },
    ])
  })

  test("a merge from a list of anchors surfaces the hidden env_file", () => {
    const text = [
      "x-a: &a {image: nginx}",
      "x-b: &b {env_file: /root/x.env}",
      "services:",
      "  s:",
      "    <<: [*a, *b]",
    ].join("\n")
    expect(prescanCompose(text).refusals).toEqual([
      { code: "env-file", service: "s", field: "env_file" },
    ])
  })

  test("an inline merge mapping surfaces the hidden env_file and label_file", () => {
    const text = [
      "services:",
      "  s:",
      "    image: nginx",
      "    <<: {env_file: /root/x.env, label_file: /etc/shadow}",
    ].join("\n")
    expect(prescanCompose(text).refusals).toEqual([
      { code: "env-file", service: "s", field: "env_file" },
      { code: "unsupported-key", service: "s", field: "label_file" },
    ])
  })
})

describe("prescanCompose: references", () => {
  function refs(text: string) {
    return prescanCompose(text).references
  }
  const wrap = (value: string): string =>
    `services: {a: {image: nginx, environment: {V: '${value}'}}}`

  test("allowed.yaml references two placeholders with no default", () => {
    expect(refs(raw("allowed"))).toEqual([
      { name: "SERVICE_PASSWORD_DB", hasDefault: false },
      { name: "SERVICE_URL_WEB_3000", hasDefault: false },
    ])
  })

  test("$$ is a literal, not a reference", () => {
    expect(refs(wrap("$$X and $${Y}"))).toEqual([])
  })

  test("every form, and which of them is a default", () => {
    expect(
      refs(
        wrap(
          "${A:-d} ${B-d} ${C:+x} ${D+x} ${E} ${F:?need F} ${G?need G} $H x$",
        ),
      ),
    ).toEqual([
      { name: "A", hasDefault: true },
      { name: "B", hasDefault: true },
      { name: "C", hasDefault: true },
      { name: "D", hasDefault: true },
      { name: "E", hasDefault: false },
      { name: "F", hasDefault: false },
      { name: "G", hasDefault: false },
      { name: "H", hasDefault: false },
    ])
  })

  test("a name used with and without a default has none", () => {
    expect(
      refs(
        "services: {a: {image: nginx, environment: {X: '${A}', Y: '${A:-d}'}}}",
      ),
    ).toEqual([{ name: "A", hasDefault: false }])
  })

  test("a bare $NAME is detected, and ends at the first non-name character", () => {
    expect(refs(wrap("pa$B-x"))).toEqual([{ name: "B", hasDefault: false }])
  })

  test("comments and keys are not references", () => {
    const text = [
      "# ${IN_COMMENT}",
      "services:",
      "  a:",
      "    image: nginx # $TRAILING",
      "    environment:",
      "      ${KEY}: v",
    ].join("\n")
    expect(refs(text)).toEqual([])
  })

  test("a default that interpolates is scanned, and held to its own form", () => {
    expect(refs(wrap("${A:-${B}} ${C:-${D:-x}}"))).toEqual([
      { name: "A", hasDefault: true },
      { name: "B", hasDefault: false },
      { name: "C", hasDefault: true },
      { name: "D", hasDefault: true },
    ])
  })

  test("pass-through environment entries are references with a default", () => {
    const text = [
      "services:",
      "  a:",
      "    image: nginx",
      "    environment: [BAR, 'SET=1', '${NOT_A_NAME}']",
      "  b:",
      "    image: nginx",
      "    environment: {BAZ: , QUX: '', BAR: '${BAR}'}",
    ].join("\n")
    expect(refs(text)).toEqual([
      { name: "NOT_A_NAME", hasDefault: false },
      { name: "BAR", hasDefault: false },
      { name: "BAZ", hasDefault: true },
    ])
    expect(refs("services: {a: {image: nginx, environment: [ONLY]}}")).toEqual([
      { name: "ONLY", hasDefault: true },
    ])
  })

  test("a secret or config from the environment is a required reference", () => {
    expect(refs(raw("secret_env"))).toEqual([
      { name: "TOKEN", hasDefault: false },
    ])
    expect(
      refs("services: {a: {image: nginx}}\nconfigs: {c: {environment: CONF}}"),
    ).toEqual([{ name: "CONF", hasDefault: false }])
  })

  test("an unparseable or unterminated ${ is ignored", () => {
    expect(refs(wrap("${} ${1A} ${A B} ${C"))).toEqual([])
  })

  test("references in lists, numbers-as-strings and extension fields", () => {
    const text = [
      "x-env: &env {K: '${EXT}'}",
      "services:",
      "  a:",
      "    image: 'nginx:${TAG:-1}'",
      "    command: [run, '${ARG}']",
      "    environment: *env",
    ].join("\n")
    expect(refs(text)).toEqual([
      { name: "EXT", hasDefault: false },
      { name: "TAG", hasDefault: true },
      { name: "ARG", hasDefault: false },
    ])
  })

  function laughs(depth: number): string {
    const levels = ["a: &l0 ['${DEEP}', x, x, x, x, x, x, x, x, x]"]
    for (let i = 1; i < depth; i++) {
      const prev = `*l${i - 1}`
      levels.push(
        `l${i}: &l${i} [${Array.from({ length: 10 }, () => prev).join(", ")}]`,
      )
    }
    levels.push("services: {a: {image: nginx}}")
    return levels.join("\n")
  }

  test("nested aliases and cycles are walked once, not expanded", () => {
    // Six levels is 10^6 strings if expanded; Bun.YAML shares the objects.
    const started = performance.now()
    expect(refs(laughs(6))).toEqual([{ name: "DEEP", hasDefault: false }])
    expect(performance.now() - started).toBeLessThan(1000)

    expect(
      prescanCompose("c: &c ['${CYCLE}', *c]\nservices: {a: {image: nginx}}")
        .references,
    ).toEqual([{ name: "CYCLE", hasDefault: false }])
  })

  test("Bun.YAML refuses a billion laughs itself", () => {
    expect(codes(laughs(12))).toEqual(["yaml-invalid"])
  })
})
