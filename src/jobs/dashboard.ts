import { promises as dns } from "node:dns"
import { networkInterfaces } from "node:os"
import { caddy, ensureDashboardRoutes } from "../caddy/client.ts"
import { config } from "../config.ts"
import { logger } from "../log.ts"
import {
  type DashboardCheck,
  getDashboardHost,
  setAppliedHost,
  setDashboardCheck,
} from "../settings.ts"

/**
 * Pushes the configured dashboard hostname into Caddy, then proves the path.
 *
 * The payload is empty on purpose, matching prune_build_cache: the value comes
 * from the settings row, so a job queued before the operator changed it must
 * not run against the value that was current when it was queued.
 */

/** DNS has no timeout option of its own, and the worker is single-threaded. */
const DNS_TIMEOUT_MS = 3_000

/** The reachability probe goes through the proxy, so it is a local round trip. */
const PROBE_TIMEOUT_MS = 5_000

export async function runApplyDashboardHost(): Promise<void> {
  const host = getDashboardHost()

  // Order matters: the route change is the operation the operator asked for, so
  // it happens first and is allowed to fail the job. Everything below is
  // diagnostics and must never turn a successful configuration into a retry.
  await ensureDashboardRoutes(host)

  // Makes an existing MUSDASH_ACME_STAGING / MUSDASH_ACME_EMAIL actually take
  // effect. Without it a box first bootstrapped on staging keeps issuing
  // untrusted certificates forever, which presents as "musdash cannot get me a
  // certificate" and is invisible from the dashboard.
  await caddy.ensureTlsAutomation()

  setAppliedHost(host)

  const check: DashboardCheck = {
    ...(await checkDns(host)),
    ...(await checkReachable()),
    at: new Date().toISOString(),
  }
  setDashboardCheck(check)

  logger.info(
    { host: host ?? null, dns: check.dns, reachable: check.reachable },
    "applied the dashboard host",
  )
}

/**
 * Does the hostname resolve to this machine?
 *
 * Advisory only, and never a reason to refuse. A mismatch is legitimate behind
 * a proxying CDN, behind NAT with a floating address, on an IPv6-only box, or
 * with split-horizon DNS — and networkInterfaces() cannot see a public address
 * that is NATed rather than assigned to a NIC. So this is best-effort by
 * construction and is presented to the operator as a warning, not a verdict.
 */
async function checkDns(
  host: string | undefined,
): Promise<Pick<DashboardCheck, "dns" | "resolved" | "local">> {
  const local = localAddresses()
  if (!host) return { dns: "skipped", resolved: [], local }

  const resolved = await withTimeout(
    Promise.allSettled([dns.resolve4(host), dns.resolve6(host)]).then((rs) =>
      rs.flatMap((r) => (r.status === "fulfilled" ? r.value : [])),
    ),
    DNS_TIMEOUT_MS,
    [] as string[],
  )

  if (resolved.length === 0) return { dns: "unresolved", resolved, local }
  const matches = resolved.some((a) => local.includes(a))
  return { dns: matches ? "ok" : "mismatch", resolved, local }
}

function localAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((addrs) => addrs ?? [])
    .filter((a) => !a.internal)
    .map((a) => a.address)
}

/**
 * Can Caddy actually reach this process?
 *
 * The single most useful check in the slice. It traverses host → the proxy's
 * published :80 → the catch-all route → the ExtraHosts alias → back into this
 * process, so a 200 proves the bind address, the bridge path, the firewall and
 * the catch-all's continued existence in one call. Without it, a host firewall
 * that DROPs traffic from the docker bridge presents as an unexplained timeout
 * with nothing in any log.
 *
 * The Host header is a bare address on purpose: it must not match the
 * host-matched route, or the automatic HTTP-to-HTTPS redirect that route
 * installs would answer instead of the dashboard.
 */
async function checkReachable(): Promise<
  Pick<DashboardCheck, "reachable" | "reachError">
> {
  try {
    const res = await fetch("http://127.0.0.1:80/health", {
      headers: { host: "127.0.0.1" },
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    const body = await res.text().catch(() => "")
    if (res.ok && body.trim() === "ok") return { reachable: true }
    return {
      reachable: false,
      reachError: `the proxy answered ${res.status} on port 80`,
    }
  } catch (err) {
    return { reachable: false, reachError: (err as Error).message }
  }
}

function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ])
}

/** Exported for the bootstrap's warn-only probe. */
export async function probeDashboardReachable(): Promise<void> {
  const host = getDashboardHost()
  const check: DashboardCheck = {
    ...(await checkDns(host)),
    ...(await checkReachable()),
    at: new Date().toISOString(),
  }
  setDashboardCheck(check)
  if (!check.reachable) {
    logger.warn(
      { err: check.reachError, port: config.port },
      "the proxy cannot reach the dashboard — check that the host firewall allows the docker bridge to reach this port",
    )
  }
}
