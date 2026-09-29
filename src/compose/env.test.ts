import { describe, expect, test } from "bun:test"
import { interpolationEnv, RESERVED_ENV } from "./env.ts"
import type { Reference } from "./types.ts"

const need = (name: string): Reference => ({ name, hasDefault: false })
const optional = (name: string): Reference => ({ name, hasDefault: true })

describe("interpolationEnv", () => {
  test("passes only the variables the file references", () => {
    const result = interpolationEnv(
      { DATABASE_URL: "postgres://x", UNUSED_SECRET: "s", OPT: "o" },
      [need("DATABASE_URL"), optional("OPT"), optional("UNSET")],
    )
    expect(result.env).toEqual({ DATABASE_URL: "postgres://x", OPT: "o" })
    expect(result.missing).toEqual([])
    expect(result.dropped).toEqual([])
  })

  test("withholds referenced keys that steer the CLI, and lists them sorted", () => {
    const resolved = {
      PATH: "/evil",
      HOME: "/root",
      DOCKER_HOST: "tcp://elsewhere",
      COMPOSE_FILE: "/root/x.yaml",
      BUILDKIT_X: "1",
      LD_PRELOAD: "/tmp/x.so",
      https_proxy: "http://p",
      DATABASE_URL: "postgres://x",
      MY_DOCKER_TAG: "keep",
    }
    const result = interpolationEnv(
      resolved,
      Object.keys(resolved).map((k) => optional(k)),
    )
    expect(result.dropped).toEqual([
      "BUILDKIT_X",
      "COMPOSE_FILE",
      "DOCKER_HOST",
      "HOME",
      "LD_PRELOAD",
      "PATH",
      "https_proxy",
    ])
    expect(result.env).toEqual({
      DATABASE_URL: "postgres://x",
      MY_DOCKER_TAG: "keep",
    })
  })

  test("a reserved key the file does not reference is not listed as dropped", () => {
    expect(interpolationEnv({ PATH: "/x" }, []).dropped).toEqual([])
  })

  test("the reserved set", () => {
    for (const key of [
      "PATH",
      "HOME",
      "TMPDIR",
      "COMPOSE_",
      "COMPOSE_PROFILES",
      "DOCKER_CONFIG",
      "BUILDKIT_PROGRESS",
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "GODEBUG",
      "GOTRACEBACK",
      "GOMAXPROCS",
      "GOFLAGS",
      "XDG_CONFIG_HOME",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "HTTP_PROXY",
      "https_proxy",
      "NO_PROXY",
      "no_proxy",
      "ALL_PROXY",
      "Ftp_Proxy",
    ]) {
      expect([key, RESERVED_ENV.test(key)]).toEqual([key, true])
    }
    for (const key of [
      "PATHS",
      "XHOME",
      "COMPOSEFILE",
      "DOCKERX",
      "LDAP_URL",
      "GOPATH",
      "PROXY",
      "PROXY_URL",
      "MY_XDG",
      "SSL_CERT",
    ]) {
      expect([key, RESERVED_ENV.test(key)]).toEqual([key, false])
    }
  })

  test("missing: unset references with no default, sorted", () => {
    const result = interpolationEnv({ SET: "v" }, [
      need("ZED"),
      need("SET"),
      optional("OPTIONAL"),
      need("ALPHA"),
    ])
    expect(result.missing).toEqual(["ALPHA", "ZED"])
  })

  test("a dropped key referenced without a default is missing", () => {
    const result = interpolationEnv({ DOCKER_HOST: "x", HOME: "/h" }, [
      need("DOCKER_HOST"),
      optional("HOME"),
    ])
    expect(result.missing).toEqual(["DOCKER_HOST"])
    expect(result.dropped).toEqual(["DOCKER_HOST", "HOME"])
    expect(result.env).toEqual({})
  })

  test("an empty value is set, not missing", () => {
    const result = interpolationEnv({ EMPTY: "" }, [need("EMPTY")])
    expect(result.missing).toEqual([])
    expect(result.env).toEqual({ EMPTY: "" })
  })

  test("a key named __proto__ stays an ordinary key", () => {
    const resolved: Record<string, string> = Object.fromEntries([
      ["__proto__", "v"],
    ])
    const { env, missing } = interpolationEnv(resolved, [need("__proto__")])
    expect(Object.hasOwn(env, "__proto__")).toBe(true)
    expect(missing).toEqual([])
  })

  test("inherited properties of the resolved map are not values", () => {
    const { env, missing } = interpolationEnv({}, [need("toString")])
    expect(env).toEqual({})
    expect(missing).toEqual(["toString"])
  })
})
