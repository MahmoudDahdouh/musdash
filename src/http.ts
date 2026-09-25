import { bindHostname, config } from "./config.ts"
import { docker } from "./docker/impl.ts"
import { WEBHOOK_PATH } from "./github/webhook.ts"
import { logger } from "./log.ts"
import { type LayoutData, renderForbidden, renderPage } from "./views/render.ts"

/**
 * Process-wide HTTP hooks, kept out of src/index.ts so the entry point stays a
 * list of wiring.
 */

interface PeerSource {
  requestIP(request: Request): { address: string } | null
}

/** Dotted-quad IPv4 to its four octets, or null when it is not one. */
function octets(address: string): number[] | null {
  const parts = address.split(".")
  if (parts.length !== 4) return null
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN))
  return nums.every((n) => n >= 0 && n <= 255) ? nums : null
}

/**
 * Whether a TCP peer address is one the public internet cannot originate.
 *
 * Loopback, RFC 1918, CGNAT shared space (100.64/10, which is also where
 * Tailscale lives) and their IPv6 counterparts. Caddy reaches the dashboard
 * from its address on the musdash bridge — a private range by Docker's default
 * address pools — and a local tunnel or SSH forward arrives on loopback.
 */
export function isPrivatePeer(address: string): boolean {
  const lower = address.toLowerCase()
  // An IPv4 peer on a dual-stack socket arrives as ::ffff:a.b.c.d.
  const v4 = octets(lower.startsWith("::ffff:") ? lower.slice(7) : lower)
  if (v4) {
    const [a = -1, b = -1] = v4
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    )
  }
  // ::1, unique-local fc00::/7, link-local fe80::/10.
  return (
    lower === "::1" ||
    // A full first hextet only: "fc::1" is 0x00fc, not fc00::/7.
    /^f[cd][0-9a-f]{2}:/.test(lower) ||
    /^fe[89ab][0-9a-f]:/.test(lower)
  )
}

/** An IPv4 CIDR as a 32-bit network address and mask. */
interface Subnet4 {
  network: number
  mask: number
}

function ipv4ToInt(address: string): number | null {
  const o = octets(address)
  if (!o) return null
  return (
    (((o[0] ?? 0) << 24) |
      ((o[1] ?? 0) << 16) |
      ((o[2] ?? 0) << 8) |
      (o[3] ?? 0)) >>>
    0
  )
}

function parseSubnet4(cidr: string): Subnet4 | null {
  const [ip = "", bits = ""] = cidr.split("/")
  const base = ipv4ToInt(ip)
  const n = Number(bits)
  if (base === null || !/^\d{1,2}$/.test(bits) || n > 32) return null
  const mask = n === 0 ? 0 : (0xffffffff << (32 - n)) >>> 0
  return { network: (base & mask) >>> 0, mask }
}

/**
 * The Docker network's own subnets, trusted in addition to the private ranges.
 *
 * Caddy reaches the dashboard from its address on the musdash network. Docker
 * allocates that from private pools by default, but `default-address-pools`
 * and `bip` are the operator's to set, and a host using a public range would
 * have the dashboard refuse its own proxy (N-9). Refreshed by the reconciler,
 * never by a request: this is a Docker read.
 */
let trustedSubnets: Subnet4[] = []

/** Replaces the trusted subnets. Non-IPv4 entries are ignored. */
export function trustSubnets(cidrs: string[]): void {
  trustedSubnets = cidrs.flatMap((c) => {
    const s = parseSubnet4(c)
    return s ? [s] : []
  })
}

/** A private address, or one inside the musdash network's own subnets. */
export function isTrustedPeer(address: string): boolean {
  if (isPrivatePeer(address)) return true
  const lower = address.toLowerCase()
  const ip = ipv4ToInt(lower.startsWith("::ffff:") ? lower.slice(7) : lower)
  if (ip === null) return false
  return trustedSubnets.some((s) => (ip & s.mask) >>> 0 === s.network)
}

/**
 * Re-reads the musdash network's subnets. Called by the reconciler at startup
 * and every tick; a failure keeps the previous list rather than emptying it,
 * because Docker being briefly unreachable is no reason to lock Caddy out.
 */
export async function refreshTrustedSubnets(): Promise<void> {
  try {
    trustSubnets(await docker.networkSubnets(config.network))
    subnetReadFailing = false
  } catch (err) {
    // Warned once per outage, not every 30-second tick: the reachability
    // probe's 403 message promises this clears on its own, and when it does
    // not, this line is the one that says why.
    if (!subnetReadFailing) {
      logger.warn(
        { err: (err as Error).message, network: config.network },
        "could not read the musdash network's subnets; keeping the previous list",
      )
    }
    subnetReadFailing = true
  }
}

let subnetReadFailing = false

/**
 * A status page. The words live in the template, not here.
 *
 * The default frame is the signed-out one, which is right for everything this
 * module answers: those run before (or without) a session lookup. A router
 * that has a session passes its own frame — see statusFor in routes/layout.ts.
 */
export function statusPage(
  status: 400 | 403 | 404 | 413 | 500,
  extra?: Record<string, unknown>,
  layout: LayoutData = { title: String(status) },
): Response {
  return new Response(renderPage("status", { ...extra, status }, layout), {
    status,
    headers: HTML,
  })
}

const HTML = { "content-type": "text/html; charset=utf-8" }

/**
 * Refuses a request whose TCP peer is on the public internet.
 *
 * The dashboard must bind every interface, because Caddy dials it through the
 * host's bridge address (D23), and D23 made the host firewall the boundary. A
 * real VPS showed that boundary is often not there: stock Ubuntu images ship
 * ufw installed but INACTIVE, and install.sh only adds rules, so port 8000
 * answered the whole internet — the login form over plain HTTP, bypassing the
 * TLS Caddy provides. This makes the process enforce what the firewall was
 * assumed to (D31). The firewall rules stay, as a second layer.
 *
 * The peer is the socket's address, never a header: X-Forwarded-For is
 * whatever the client chose to send.
 */
export function rejectPublicPeers({
  request,
  server,
}: {
  request: Request
  server: PeerSource | null
}): Response | undefined {
  const peer = server?.requestIP(request)?.address
  if (peer !== undefined && isTrustedPeer(peer)) return undefined
  logger.debug({ peer: peer ?? null }, "refused a request from a public peer")
  return new Response(renderForbidden(), { status: 403, headers: HTML })
}

/**
 * Bun's ceiling for every route and every peer: the webhook's allowance (D35).
 *
 * Bun's default is 128 MiB per request, and a body is held at least twice
 * (the buffer, then the string), so two concurrent requests could exhaust a
 * 1GB host (B-1). The option is server-wide, so it must be the largest
 * legitimate body — a GitHub push — and forms get their smaller limit from
 * limitRequestBody. Bun refuses a Content-Length over this with its own bare
 * 413 before musdash sees the request, and cuts a chunked body off here too.
 */
export const MAX_REQUEST_BODY_BYTES = 1_048_576

/**
 * Every non-webhook route, checked from Content-Length before Elysia parses.
 * Over 6x a heavy environment-variable paste, which is the largest form.
 */
export const MAX_FORM_BODY_BYTES = 262_144

/**
 * Refuses a form whose declared body is over MAX_FORM_BODY_BYTES.
 *
 * Runs in onRequest, before Elysia reads anything, and never reads the body
 * itself: answering early is what keeps a refused body from being buffered —
 * Bun discards the unread rest and keeps the connection usable (D35).
 *
 * The webhook is exempt; only Bun's ceiling applies to it. No Content-Length at
 * all means a chunked body, which that same ceiling bounds. A header that is
 * present but not a plain integer is refused outright: Bun joins duplicate
 * headers into "100, 100", which no integer parse should be trusted to read
 * the way the body parser will, and no legitimate client sends one.
 */
export function limitRequestBody({
  request,
}: {
  request: Request
}): Response | undefined {
  const header = request.headers.get("content-length")
  if (header === null) return undefined
  const path = new URL(request.url).pathname
  if (!/^\d+$/.test(header)) {
    logger.debug(
      { method: request.method, path },
      "refused a malformed Content-Length",
    )
    return statusPage(400)
  }
  const contentLength = Number(header)
  if (contentLength <= MAX_FORM_BODY_BYTES || path === WEBHOOK_PATH) {
    return undefined
  }
  // Debug, and never the body: this runs before authentication, so anyone can
  // produce one of these per request.
  logger.debug(
    { method: request.method, path, contentLength },
    "refused a request body over the form limit",
  )
  return statusPage(413, { limitKb: MAX_FORM_BODY_BYTES / 1024 })
}

/**
 * The single global onRequest hook: public peers first (D31), then body size.
 *
 * Destructured rather than taking Elysia's whole context, so its inference is
 * not switched fully on for every request.
 */
export function guardRequest({
  request,
  server,
}: {
  request: Request
  server: PeerSource | null
}): Response | undefined {
  return rejectPublicPeers({ request, server }) ?? limitRequestBody({ request })
}

/** Options for Elysia's .listen(), which spreads them into Bun.serve. */
export function serveOptions(): {
  port: number
  hostname: string
  maxRequestBodySize: number
} {
  return {
    port: config.port,
    hostname: bindHostname(),
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
  }
}

/**
 * Bun's error text when a chunked body runs past maxRequestBodySize. Elysia
 * passes it through as UNKNOWN on a route with parse "none" (the webhook).
 */
const BODY_CEILING_MESSAGE = "Request body exceeded maxRequestBodySize"

/**
 * The global error handler.
 *
 * Never hands an internal error to the browser — logs the detail, shows a line.
 * The log names the method and path, because "request failed" with no request
 * attached cannot be traced to anything. The path only, not the query: OAuth
 * callbacks carry one-time codes there.
 *
 * NOT_FOUND is logged at info. It is a client asking for something that does
 * not exist — every internet scanner does it — and at error level it buried
 * the real failures in the journal.
 */
export function handleError({
  code,
  error,
  request,
}: {
  code: string | number
  error: unknown
  request: Request
}): Response {
  const where = { method: request.method, path: new URL(request.url).pathname }
  if (code === "NOT_FOUND") {
    logger.info({ ...where, code }, "no route for the request")
    return statusPage(404)
  }
  // NEVER log these errors' messages. Elysia builds a ValidationError's message
  // as JSON carrying `found: <the whole request body>`, in production too, and
  // it validates before any handler runs — so an env form that fails its schema
  // (a missing csrf field is enough) would write the decrypted values in its
  // textareas to the journal. A parse error carries the raw body the same way.
  if (code === "VALIDATION" || code === "PARSE") {
    logger.warn({ ...where, code }, "rejected a malformed request")
    return statusPage(400)
  }
  // Anyone can send a chunked body past the ceiling, so it must not be an
  // error-level line per request. Bun has already answered with its own bare
  // 413 and closed the connection by the time this runs — the page returned
  // here is never delivered, it only keeps the handler's contract. The match is
  // on Bun's message text: if Bun rewords it, this falls through to the
  // error-level line below, so only a log level is lost. The message itself is
  // still not logged, by the same rule as the branch above.
  if (
    code === "UNKNOWN" &&
    error instanceof Error &&
    error.message === BODY_CEILING_MESSAGE
  ) {
    logger.warn(where, "request body over the size ceiling")
    return statusPage(413, { limitKb: MAX_REQUEST_BODY_BYTES / 1024 })
  }
  logger.error({ ...where, code, err: String(error) }, "request failed")
  return statusPage(500)
}
