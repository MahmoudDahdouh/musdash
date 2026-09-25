import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test"
import { Elysia } from "elysia"
import { WEBHOOK_PATH } from "./github/webhook.ts"
import {
  handleError,
  isPrivatePeer,
  isTrustedPeer,
  limitRequestBody,
  MAX_FORM_BODY_BYTES,
  MAX_REQUEST_BODY_BYTES,
  rejectPublicPeers,
  serveOptions,
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

describe("request body limits (B-1)", () => {
  // A real server, because the ceiling is Bun's own and a Request built in the
  // test never passes through it. Deleting maxRequestBodySize from
  // serveOptions(), or a Bun upgrade that stops honouring it, would silently
  // bring back 128 MiB per request, and no click-through would show it (D35).
  let loginCalls = 0
  let webhookCalls = 0
  let stop = () => {}
  let base = ""

  beforeAll(() => {
    const server = new Elysia()
      .onRequest(limitRequestBody)
      .post("/login", () => {
        loginCalls++
        return "ok"
      })
      .post(
        WEBHOOK_PATH,
        async ({ request }) => {
          webhookCalls++
          return String((await request.arrayBuffer()).byteLength)
        },
        { parse: "none" },
      )
      .listen({ ...serveOptions(), port: 0, hostname: "127.0.0.1" })
    stop = () => void server.stop(true)
    base = `http://127.0.0.1:${server.server?.port}`
  })

  afterAll(() => stop())

  const post = (path: string, bytes: number) =>
    fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `a=${"x".repeat(bytes - 2)}`,
    })

  test("a form one byte over the limit gets the 413 page, not the handler", async () => {
    const before = loginCalls
    const res = await post("/login", MAX_FORM_BODY_BYTES + 1)
    expect(res.status).toBe(413)
    expect(res.headers.get("content-type")).toContain("text/html")
    await res.text()
    expect(loginCalls).toBe(before)
  })

  test("a form exactly at the limit reaches the handler", async () => {
    const before = loginCalls
    const res = await post("/login", MAX_FORM_BODY_BYTES)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("ok")
    expect(loginCalls).toBe(before + 1)
  })

  test("the webhook is exempt from the form limit", async () => {
    const res = await post(WEBHOOK_PATH, 300 * 1024)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("307200")
  })

  test("the webhook is still held to Bun's ceiling", async () => {
    const before = webhookCalls
    const res = await post(WEBHOOK_PATH, MAX_REQUEST_BODY_BYTES + 1)
    expect(res.status).toBe(413)
    await res.arrayBuffer()
    expect(webhookCalls).toBe(before)
  })

  const withLength = (value: string | null) =>
    limitRequestBody({
      request: new Request("http://example.test/login", {
        method: "POST",
        headers: value === null ? {} : { "content-length": value },
      }),
    })

  test("no Content-Length is left to Bun's ceiling", () => {
    expect(withLength(null)).toBeUndefined()
  })

  for (const value of ["abc", "100, 100", "+100"]) {
    test(`a Content-Length of "${value}" is a 400`, () => {
      expect(withLength(value)?.status).toBe(400)
    })
  }

  test("a leading zero within the limit is still a plain integer", () => {
    expect(withLength("0100")).toBeUndefined()
  })

  test("a chunked body past the ceiling logs a warn, without Bun's message", () => {
    const calls: [string, unknown[]][] = []
    const spies = (["error", "warn", "info", "debug"] as const).map((level) =>
      spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
        calls.push([level, args])
      }) as never),
    )
    try {
      const res = handleError({
        code: "UNKNOWN",
        error: new Error("Request body exceeded maxRequestBodySize"),
        request: new Request(`http://example.test${WEBHOOK_PATH}`, {
          method: "POST",
        }),
      })
      expect(res.status).toBe(413)
      expect(calls.map(([level]) => level)).toEqual(["warn"])
      expect(JSON.stringify(calls)).not.toContain("exceeded")
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })
})
