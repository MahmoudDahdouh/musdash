import {
  createServer as createTcpServer,
  type Server,
  type Socket,
} from "node:net"
import { createServer as createTlsServer } from "node:tls"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  probeCertificateOnce,
  type ProxyTarget,
  waitForCertificate,
} from "./tls-probe.ts"

/**
 * The certificate wait against real sockets on loopback: a closed port, a TCP
 * listener that never speaks, and node:tls servers (Bun.serve({ tls }) also
 * works on Bun 1.4, but only node:tls can reproduce Caddy's no-certificate
 * alert, below).
 *
 * Every wait uses a 1.5s deadline and must resolve at most 250ms past it — the
 * clamping of attempt timeouts and retry sleeps to the deadline is what keeps a
 * deploy's 30s bound a real bound.
 */

// TEST-ONLY throwaway key pair, not a secret: a self-signed P-256 certificate
// for probe.musdash.test and *.wild.musdash.test, valid until 2126. Nothing
// trusts it and it guards nothing. Regenerate with:
//
//   openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
//     -pkeyopt ec_param_enc:named_curve -nodes -days 36500 \
//     -subj /CN=probe.musdash.test \
//     -addext "subjectAltName=DNS:probe.musdash.test,DNS:*.wild.musdash.test" \
//     -keyout key.pem -out cert.pem
//
// ec_param_enc:named_curve matters with LibreSSL (macOS's openssl), which
// otherwise writes explicit curve parameters that BoringSSL rejects.
const FIXTURE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg021QlGfZtpqbn9aN
Wl2PswFrETZlos1TWWJPPSxmseKhRANCAAQGFmNzP/Id5CXGRsEyTMzcnOYlsySR
9684G0cQnt5L7hN17YdjV5M4cn+nszSOK2MPjMhBmrdLah0PBPcKm3NO
-----END PRIVATE KEY-----
`
const FIXTURE_CERT = `-----BEGIN CERTIFICATE-----
MIIBaTCCAQ+gAwIBAgIJAKtuGOmprJXZMAoGCCqGSM49BAMCMB0xGzAZBgNVBAMM
EnByb2JlLm11c2Rhc2gudGVzdDAgFw0yNjA5MjUxOTQ4MDBaGA8yMTI2MDkwMTE5
NDgwMFowHTEbMBkGA1UEAwwScHJvYmUubXVzZGFzaC50ZXN0MFkwEwYHKoZIzj0C
AQYIKoZIzj0DAQcDQgAEBhZjcz/yHeQlxkbBMkzM3JzmJbMkkfevOBtHEJ7eS+4T
de2HY1eTOHJ/p7M0jitjD4zIQZq3S2odDwT3CptzTqM2MDQwMgYDVR0RBCswKYIS
cHJvYmUubXVzZGFzaC50ZXN0ghMqLndpbGQubXVzZGFzaC50ZXN0MAoGCCqGSM49
BAMCA0gAMEUCIQCvT0mk7oCLIXwTZl7XtyGYd2N9+n0wLSmZwm6P2nHk7gIgM8IC
yrwivV6FAGmlvUO1s71KGL1VVNQKgG4Rnic2BrE=
-----END CERTIFICATE-----
`

const FAST = { attemptTimeoutMs: 300, intervalMs: 100 }
const WINDOW_MS = 1_500
const SLACK_MS = 250

async function listen(server: Server): Promise<ProxyTarget> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address")
  }
  return { dialHost: "127.0.0.1", port: address.port }
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
  })
}

/** Runs a wait with the test deadline and reports how far past it it ended. */
async function timedWait(host: string, target: ProxyTarget) {
  const deadline = Date.now() + WINDOW_MS
  const result = await waitForCertificate(host, deadline, { ...FAST, target })
  return { result, overrun: Date.now() - deadline }
}

let silentConnections = 0
// Bun's node:net server does not release a connection it never reads from,
// even after the probe's FIN arrives (verified: the probe's side is closed), so
// close() would wait forever. The accepted sockets are kept to destroy them.
const silentSockets: Socket[] = []
const silent = createTcpServer((conn) => {
  silentConnections++
  silentSockets.push(conn)
  // Accept and never write. The probe destroying its end can surface here as
  // a reset; without a listener that would be an unhandled 'error'.
  conn.on("error", () => {})
})

const tls = createTlsServer(
  { key: FIXTURE_KEY, cert: FIXTURE_CERT },
  (conn) => {
    conn.on("error", () => {})
    conn.end()
  },
)
// The probe hangs up right after the handshake; that is not a server fault.
tls.on("tlsClientError", () => {})

// What Caddy does for a name it holds no certificate for yet: completes TCP,
// then answers the ClientHello with an internal_error alert. An SNICallback
// that yields no context makes BoringSSL send exactly that alert.
const noCert = createTlsServer(
  {
    SNICallback: (_name, cb) => {
      cb(null, undefined)
    },
  },
  (conn) => conn.end(),
)
noCert.on("tlsClientError", () => {})

let silentTarget: ProxyTarget
let tlsTarget: ProxyTarget
let noCertTarget: ProxyTarget
let closedTarget: ProxyTarget

beforeAll(async () => {
  silentTarget = await listen(silent)
  tlsTarget = await listen(tls)
  noCertTarget = await listen(noCert)
  // Bind port 0, read the port the kernel chose, then stop: nothing listens
  // there for the rest of the run.
  const probe = createTcpServer()
  closedTarget = await listen(probe)
  await close(probe)
})

afterAll(async () => {
  for (const conn of silentSockets) conn.destroy()
  await Promise.all([close(silent), close(tls), close(noCert)])
})

describe("waitForCertificate", () => {
  test("a closed port ends in connect, within the deadline", async () => {
    const { result, overrun } = await timedWait(
      "probe.musdash.test",
      closedTarget,
    )
    expect(result.ready).toBe(false)
    expect(result.last).toMatchObject({ ok: false, reason: "connect" })
    expect(overrun).toBeLessThanOrEqual(SLACK_MS)
  })

  test("a listener that never speaks ends in timeout, and is retried", async () => {
    silentConnections = 0
    const { result, overrun } = await timedWait(
      "probe.musdash.test",
      silentTarget,
    )
    expect(result.ready).toBe(false)
    expect(result.last).toMatchObject({ ok: false, reason: "timeout" })
    expect(overrun).toBeLessThanOrEqual(SLACK_MS)
    expect(silentConnections).toBeGreaterThanOrEqual(2)
  })

  test("an exact SAN is ready at once, despite a self-signed chain", async () => {
    const started = Date.now()
    const { result } = await timedWait("probe.musdash.test", tlsTarget)
    expect(result.ready).toBe(true)
    expect(result.last).toEqual({ ok: true })
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test("a wildcard SAN covers exactly one leftmost label", async () => {
    const wild = await timedWait("a.wild.musdash.test", tlsTarget)
    expect(wild.result.ready).toBe(true)

    for (const host of ["other.musdash.test", "a.b.wild.musdash.test"]) {
      const { result, overrun } = await timedWait(host, tlsTarget)
      expect(result.ready).toBe(false)
      expect(result.last).toMatchObject({ ok: false, reason: "san-mismatch" })
      expect(overrun).toBeLessThanOrEqual(SLACK_MS)
    }
  })

  test("a proxy with no certificate for the name ends in handshake", async () => {
    const { result, overrun } = await timedWait(
      "probe.musdash.test",
      noCertTarget,
    )
    expect(result.ready).toBe(false)
    expect(result.last).toMatchObject({ ok: false, reason: "handshake" })
    expect(overrun).toBeLessThanOrEqual(SLACK_MS)
  })
})

describe("probeCertificateOnce", () => {
  test("an empty host resolves not-ok instead of throwing", async () => {
    const attempt = await probeCertificateOnce("", 300, tlsTarget)
    expect(attempt.ok).toBe(false)
  })
})
