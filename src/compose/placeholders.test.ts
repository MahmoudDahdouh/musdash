import { describe, expect, test } from "bun:test"
import {
  generateSecret,
  type Placeholder,
  parsePlaceholder,
  RandomSourceError,
} from "./placeholders.ts"

describe("parsePlaceholder", () => {
  const table: [string, Placeholder | null][] = [
    ["SERVICE_PASSWORD_DB", { name: "SERVICE_PASSWORD_DB", kind: "password" }],
    ["SERVICE_USER_ADMIN", { name: "SERVICE_USER_ADMIN", kind: "user" }],
    ["SERVICE_BASE64_KEY_2", { name: "SERVICE_BASE64_KEY_2", kind: "base64" }],
    [
      "SERVICE_FQDN_WEB",
      { name: "SERVICE_FQDN_WEB", kind: "fqdn", service: "web" },
    ],
    [
      "SERVICE_FQDN_WEB_3000",
      {
        name: "SERVICE_FQDN_WEB_3000",
        kind: "fqdn",
        service: "web",
        port: 3000,
      },
    ],
    [
      "SERVICE_URL_WEB_3000",
      { name: "SERVICE_URL_WEB_3000", kind: "url", service: "web", port: 3000 },
    ],
    // Pinned: the service name is lowercased and `_` becomes `-`.
    [
      "SERVICE_URL_MY_APP",
      { name: "SERVICE_URL_MY_APP", kind: "url", service: "my-app" },
    ],
    [
      "SERVICE_FQDN_MY_APP_8080",
      {
        name: "SERVICE_FQDN_MY_APP_8080",
        kind: "fqdn",
        service: "my-app",
        port: 8080,
      },
    ],
    [
      "SERVICE_URL_APP_V2",
      { name: "SERVICE_URL_APP_V2", kind: "url", service: "app-v2" },
    ],
    [
      "SERVICE_FQDN_WEB_65535",
      {
        name: "SERVICE_FQDN_WEB_65535",
        kind: "fqdn",
        service: "web",
        port: 65_535,
      },
    ],
    // Pinned: a trailing number that is not a port makes it no placeholder.
    ["SERVICE_FQDN_WEB_0", null],
    ["SERVICE_FQDN_WEB_65536", null],
    ["SERVICE_FQDN_WEB_03000", null],
    ["SERVICE_FOO_X", null],
    ["SERVICE_PASSWORD_", null],
    ["SERVICE_PASSWORD_db", null],
    ["SERVICE_FQDN_web", null],
    ["SERVICE_FQDN__WEB", null],
    ["SERVICE_FQDN_WEB_", null],
    ["SERVICE_FQDN_", null],
    ["MY_SERVICE_PASSWORD_DB", null],
    ["DATABASE_URL", null],
  ]
  for (const [name, expected] of table) {
    test(name, () => {
      expect(parsePlaceholder(name)).toEqual(expected)
    })
  }
})

describe("generateSecret", () => {
  test("password: 32 of [A-Za-z0-9]", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateSecret("password")).toMatch(/^[A-Za-z0-9]{32}$/)
    }
  })

  test("user: 16 of [a-z]", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateSecret("user")).toMatch(/^[a-z]{16}$/)
    }
  })

  test("base64: 32 bytes, standard alphabet with padding", () => {
    const value = generateSecret("base64")
    expect(value).toMatch(/^[A-Za-z0-9+/]{43}=$/)
    expect(Buffer.from(value, "base64").length).toBe(32)
  })

  test("1000 passwords are distinct", () => {
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i++) seen.add(generateSecret("password"))
    expect(seen.size).toBe(1000)
  })

  function counter(): (bytes: Uint8Array) => void {
    let n = 0
    return (bytes) => {
      for (let i = 0; i < bytes.length; i++) bytes[i] = n++ & 0xff
    }
  }

  test("a deterministic rng gives deterministic output", () => {
    for (const kind of ["password", "user", "base64"] as const) {
      expect(generateSecret(kind, counter())).toBe(
        generateSecret(kind, counter()),
      )
    }
    expect(generateSecret("password", counter())).toBe(
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef",
    )
  })

  test("bytes that would bias the draw are skipped, not folded", () => {
    // 248..255 are the bytes `% 62` would fold onto A..H; 0 is A.
    const rng = (bytes: Uint8Array): void => {
      bytes.fill(255)
      bytes[bytes.length - 1] = 0
    }
    expect(() => generateSecret("password", rng)).not.toThrow()
    expect(generateSecret("password", rng)).toBe("A".repeat(32))
  })

  test("an rng that never yields a usable byte throws, never hangs", () => {
    expect(() => generateSecret("user", (b) => b.fill(255))).toThrow(
      RandomSourceError,
    )
  })
})
