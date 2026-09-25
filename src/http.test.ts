import { afterEach, describe, expect, spyOn, test } from "bun:test"
import {
  handleError,
  isPrivatePeer,
  isTrustedPeer,
  rejectPublicPeers,
  trustSubnets,
} from "./http.ts"
import { logger } from "./log.ts"

/**
 * The dashboard port's peer check (D31, N-9). It is the only thing between the
 * internet and the login form on a host whose firewall is off, so a regression
 * here is an exposure, not a bug.
 */

afterEach(() => trustSubnets([]))

describe("isPrivatePeer", () => {
  const cases: [string, boolean][] = [
    ["127.0.0.1", true],
    ["10.1.2.3", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["172.32.0.1", false],
    ["192.168.1.9", true],
    ["100.64.0.1", true],
    ["100.128.0.1", false],
    ["8.8.8.8", false],
    ["168.235.65.93", false],
    ["::1", true],
    ["::ffff:172.18.0.2", true],
    ["::ffff:1.1.1.1", false],
    ["fd12:3456::1", true],
    ["fc::1", false],
    ["fe80::1", true],
    ["2001:db8::1", false],
    ["1.2.3", false],
    ["", false],
  ]
  for (const [address, expected] of cases) {
    test(`${address || "(empty)"} -> ${expected}`, () => {
      expect(isPrivatePeer(address)).toBe(expected)
    })
  }
})

describe("trusted Docker subnets (N-9)", () => {
  test("a public pool is refused until the network's subnet is trusted", () => {
    expect(isTrustedPeer("44.10.0.5")).toBe(false)
    trustSubnets(["44.10.0.0/16"])
    expect(isTrustedPeer("44.10.0.5")).toBe(true)
    expect(isTrustedPeer("::ffff:44.10.200.1")).toBe(true)
    expect(isTrustedPeer("44.11.0.5")).toBe(false)
  })

  test("malformed and IPv6 subnets are ignored rather than trusting everything", () => {
    trustSubnets(["garbage", "fd00::/64", "1.2.3.4/33", "0.0.0.0/x"])
    expect(isTrustedPeer("8.8.8.8")).toBe(false)
  })
})

describe("rejectPublicPeers", () => {
  const request = new Request("http://example.test/login")
  const from = (address: string | null) => ({
    requestIP: () => (address === null ? null : { address }),
  })

  test("lets a private peer through", () => {
    expect(
      rejectPublicPeers({ request, server: from("172.18.0.2") }),
    ).toBeUndefined()
  })

  test("answers a public peer with a 403 page", () => {
    const res = rejectPublicPeers({ request, server: from("203.0.113.9") })
    expect(res?.status).toBe(403)
  })

  test("fails closed when the peer address is unknown", () => {
    expect(rejectPublicPeers({ request, server: from(null) })?.status).toBe(403)
    expect(rejectPublicPeers({ request, server: null })?.status).toBe(403)
  })

  test("ignores X-Forwarded-For", () => {
    const spoofed = new Request("http://example.test/login", {
      headers: { "x-forwarded-for": "127.0.0.1" },
    })
    const res = rejectPublicPeers({
      request: spoofed,
      server: from("203.0.113.9"),
    })
    expect(res?.status).toBe(403)
  })
})

describe("handleError never logs a request body", () => {
  // Elysia's ValidationError message carries `found: <the whole body>`, and an
  // env form's body is decrypted values. This pins the rule "never log a
  // decrypted env value" on the path the Validator found it broken.
  const secret = "DATABASE_URL=postgres://admin:hunter2@db/prod"
  const request = new Request("http://example.test/r/abc/env", {
    method: "POST",
  })

  for (const code of ["VALIDATION", "PARSE"]) {
    test(`${code}: 400, and the body appears in no log call`, () => {
      const calls: unknown[][] = []
      const spies = (["error", "warn", "info", "debug"] as const).map((level) =>
        spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
          calls.push(args)
        }) as never),
      )
      try {
        const error = new Error(
          JSON.stringify({ type: "validation", found: { runtime: secret } }),
        )
        const res = handleError({ code, error, request })
        expect(res.status).toBe(400)
        expect(JSON.stringify(calls)).not.toContain("hunter2")
        expect(calls.length).toBeGreaterThan(0)
      } finally {
        for (const spy of spies) spy.mockRestore()
      }
    })
  }
})
