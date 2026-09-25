import { connect, type TLSSocket } from "node:tls"

/**
 * Asks the proxy, over a real TLS handshake, whether it can present a
 * certificate for a host yet.
 *
 * Caddy runs automatic HTTPS, not on-demand TLS: issuance for a name starts in
 * the background once a route's host matcher carries it, and until it finishes
 * Caddy answers a handshake for that name with an internal_error alert. A
 * handshake with that name as SNI is therefore the cheapest honest question —
 * no admin request (D30), no reading Caddy's logs or storage, and it tests the
 * thing a browser will actually do.
 *
 * The chain is deliberately NOT verified. The question is "is a certificate for
 * this name being served", not "is it trusted": a staging issuer, or a
 * self-signed fallback, still answers yes. Trust is the operator's business.
 *
 * This is not Docker code and imports nothing from src/docker/**: it dials the
 * proxy's published port like any client on the host would.
 */

/**
 * Where musdash reaches the proxy's published ports. The only definition —
 * Phase 5 remote servers change this in one place.
 */
export const PROXY_DIAL_HOST = "127.0.0.1"
export const PROXY_HTTPS_PORT = 443
export const CERT_ATTEMPT_TIMEOUT_MS = 3_000
export const CERT_RETRY_INTERVAL_MS = 1_000
/** Overall bound for ALL hosts waited on in one deploy (one shared deadline). */
export const CERT_WAIT_MS = 30_000

export interface ProxyTarget {
  dialHost: string
  port: number
}

export type CertAttemptFailure =
  "connect" | "timeout" | "handshake" | "san-mismatch"

export type CertAttempt =
  { ok: true } | { ok: false; reason: CertAttemptFailure; detail: string }

export interface CertWaitOptions {
  target?: ProxyTarget
  attemptTimeoutMs?: number
  intervalMs?: number
}

export interface CertWaitResult {
  host: string
  ready: boolean
  elapsedMs: number
  /** The final attempt. For pino only — its detail is raw socket text. */
  last: CertAttempt
}

const DEFAULT_TARGET: ProxyTarget = {
  dialHost: PROXY_DIAL_HOST,
  port: PROXY_HTTPS_PORT,
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The DNS names in a peer certificate's `subjectaltname`, which Node (and
 * Bun's node:tls) formats as `"DNS:a.example, DNS:*.b.example, IP Address:…"`.
 *
 * No CN fallback: browsers stopped honouring the CN years ago, and Caddy
 * always writes SANs, so a CN-only match would report ready for a certificate
 * no browser accepts.
 */
function parseSanDnsNames(subjectaltname: unknown): string[] {
  if (typeof subjectaltname !== "string") return []
  return subjectaltname
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("DNS:"))
    .map((entry) => entry.slice("DNS:".length))
}

/**
 * Exact (case-insensitive) or `*.` wildcard covering exactly one leftmost
 * label — the RFC 6125 rule browsers apply, so `*.wild.example` covers
 * `a.wild.example` but neither `wild.example` nor `a.b.wild.example`.
 */
export function certificateCovers(
  sanDnsNames: readonly string[],
  host: string,
): boolean {
  const h = host.toLowerCase()
  if (h === "") return false
  return sanDnsNames.some((raw) => {
    const san = raw.toLowerCase()
    if (san === h) return true
    if (!san.startsWith("*.")) return false
    const suffix = san.slice(1) // ".wild.example"
    if (!h.endsWith(suffix)) return false
    const label = h.slice(0, h.length - suffix.length)
    return label.length > 0 && !label.includes(".")
  })
}

/**
 * One handshake. SNI = host, chain NOT verified. Never throws, never rejects.
 *
 * Every exit goes through `settle`, which runs once: it clears the timer and
 * destroys the socket on every path, so nothing is left open or scheduled when
 * the promise resolves. Events that arrive after settling — a late 'error' from
 * the destroy, a 'close' — hit the guard and are dropped, but their listeners
 * stay attached: an EventEmitter 'error' with no listener crashes the process.
 */
export function probeCertificateOnce(
  host: string,
  timeoutMs: number,
  target: ProxyTarget = DEFAULT_TARGET,
): Promise<CertAttempt> {
  return new Promise<CertAttempt>((resolve) => {
    let settled = false
    // Whether TCP connected. It is what separates "nothing is listening" (the
    // proxy is down or the port is unpublished) from "the proxy answered but
    // has no certificate for this name yet" — the case Caddy signals with an
    // internal_error alert, which surfaces here as a plain socket error.
    let connected = false
    let socket: TLSSocket | undefined
    let timer: ReturnType<typeof setTimeout> | undefined

    const settle = (result: CertAttempt): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      socket?.destroy()
      resolve(result)
    }

    try {
      socket = connect({
        host: target.dialHost,
        port: target.port,
        servername: host,
        // Not a trust decision: this connection carries no application data
        // and is destroyed right after the handshake, so there is nothing to
        // intercept. Verifying would make a staging certificate read as "not
        // ready" for the whole wait.
        rejectUnauthorized: false,
      })
    } catch (err) {
      // tls.connect throws synchronously on bad options — an out-of-range port,
      // or an IP address as the servername. Nothing was dialled.
      settle({ ok: false, reason: "connect", detail: messageOf(err) })
      return
    }

    // Attached in the same tick as connect(), before any event can fire.
    socket.on("error", (err: unknown) => {
      settle({
        ok: false,
        reason: connected ? "handshake" : "connect",
        detail: messageOf(err),
      })
    })
    socket.on("connect", () => {
      connected = true
    })
    // A peer that hangs up without an alert produces 'close' and no 'error'.
    socket.on("close", () => {
      settle({
        ok: false,
        reason: connected ? "handshake" : "connect",
        detail: "connection closed before the handshake completed",
      })
    })
    socket.on("secureConnect", () => {
      let names: string[] = []
      try {
        names = parseSanDnsNames(socket?.getPeerCertificate().subjectaltname)
      } catch (err) {
        settle({ ok: false, reason: "handshake", detail: messageOf(err) })
        return
      }
      if (certificateCovers(names, host)) {
        settle({ ok: true })
      } else {
        settle({
          ok: false,
          reason: "san-mismatch",
          detail: `certificate covers ${names.join(", ") || "no DNS names"}`,
        })
      }
    })

    timer = setTimeout(
      () => {
        settle({
          ok: false,
          reason: "timeout",
          detail: `no handshake within ${timeoutMs}ms`,
        })
      },
      Math.max(0, timeoutMs),
    )
  })
}

/**
 * Retries until ready or `deadline` (epoch ms). Each attempt's timeout and each
 * retry sleep are clamped to the deadline, so the wait ends at the deadline
 * rather than up to one attempt past it. Never throws/rejects; leaves no timer
 * or socket open when it resolves.
 *
 * The deadline is absolute rather than a duration so that several hosts waited
 * on together share one bound: a deploy with three unpointed names waits 30s,
 * not 90s.
 */
export async function waitForCertificate(
  host: string,
  deadline: number,
  opts: CertWaitOptions = {},
): Promise<CertWaitResult> {
  const target = opts.target ?? DEFAULT_TARGET
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? CERT_ATTEMPT_TIMEOUT_MS
  const intervalMs = opts.intervalMs ?? CERT_RETRY_INTERVAL_MS
  const started = Date.now()
  let last: CertAttempt = {
    ok: false,
    reason: "timeout",
    detail: "the deadline passed before any attempt",
  }

  try {
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      last = await probeCertificateOnce(
        host,
        Math.min(attemptTimeoutMs, remaining),
        target,
      )
      if (last.ok) {
        return { host, ready: true, elapsedMs: Date.now() - started, last }
      }
      const left = deadline - Date.now()
      if (left <= 0) break
      await Bun.sleep(Math.min(intervalMs, left))
    }
  } catch (err) {
    // Unreachable by construction — the probe never rejects — but this
    // function's contract is "never rejects", and the caller sits past the
    // route switch, where a throw would mark a live deploy failed.
    last = { ok: false, reason: "handshake", detail: messageOf(err) }
  }
  return { host, ready: false, elapsedMs: Date.now() - started, last }
}
