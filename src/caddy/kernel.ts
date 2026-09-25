import { existsSync } from "node:fs"

/**
 * Lets a closing listener hand its queued connections to its replacement.
 *
 * Every admin-API write is a full config reload. Caddy starts the new config
 * before stopping the old one (caddy.go: run the new, then unsyncedStop the
 * old), binding :80/:443 again with SO_REUSEPORT, and then closes the old
 * socket. Linux resets whatever was still in the closing socket's accept queue
 * — measured on a real VPS as one failed request (a TLS connect error) at every
 * route switch, which is the zero-downtime guarantee failing (D30). With this
 * set, the kernel migrates those connections to the new socket instead.
 * Connections Go had already accepted are not at risk: Shutdown leaves a
 * connection still in its TLS handshake alone for its first five seconds, and
 * Caddy's grace period is unbounded. Namespaced to the proxy's own network
 * namespace, so nothing on the host changes.
 */
export const MIGRATE_SYSCTL = "net.ipv4.tcp_migrate_req"

/**
 * Records on the proxy container whether it was created WITH the sysctl — "1"
 * or "0". The kernel check alone answers the wrong question: a proxy created
 * on an old kernel keeps running without the sysctl after the kernel is
 * upgraded, so "does the kernel support it" and "does the running proxy have
 * it" diverge. A missing label counts as "0".
 */
export const MIGRATE_LABEL = "musdash.proxy_migrate"

/**
 * Whether the kernel has tcp_migrate_req (Linux 5.14+).
 *
 * Read from this host's /proc, which assumes the Docker daemon shares this
 * kernel — true for the local socket, which is the only place the proxy runs.
 * Phase 5's remote servers break that assumption and must ask the remote host
 * instead (N-13). The check matters because runc fails the container START,
 * not the create, on a sysctl the kernel does not have: a proxy that never
 * starts is far worse than one that occasionally drops a request during a
 * reload.
 */
export function supportsListenerMigration(): boolean {
  return existsSync(`/proc/sys/${MIGRATE_SYSCTL.replaceAll(".", "/")}`)
}
