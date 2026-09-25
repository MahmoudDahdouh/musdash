import { logger } from "./log.ts"

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
  if (peer !== undefined && isPrivatePeer(peer)) return undefined
  logger.debug({ peer: peer ?? null }, "refused a request from a public peer")
  return new Response(
    "Forbidden: this port only answers the local proxy. Open the dashboard on port 80 or 443.\n",
    { status: 403 },
  )
}

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
  set,
}: {
  code: string | number
  error: unknown
  request: Request
  set: { status?: number | string }
}): Response | string {
  const where = { method: request.method, path: new URL(request.url).pathname }
  if (code === "NOT_FOUND") {
    logger.info({ ...where, code }, "no route for the request")
    return new Response("Not found", { status: 404 })
  }
  logger.error({ ...where, code, err: String(error) }, "request failed")
  set.status = 500
  return "Something went wrong. Check the server logs."
}
