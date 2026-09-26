/**
 * How much memory the proxy may use, from how much the Docker host has.
 *
 * The cap used to be a fixed 512 MiB. On a 512MB VPS (458 MiB usable) that is
 * more than the whole host, so it contained nothing: after a reboot Caddy grew
 * to 277 MiB of anonymous memory, the host thrashed with every site down, and
 * only the kernel's GLOBAL OOM killer ended it, 22 minutes later (L-1, D46).
 * V-1 was the same mistake on the build daemon, and its premise test showed
 * that a cap below the host's memory confines a runaway process to its own
 * cgroup within seconds. For the proxy that means a
 * kill and an `unless-stopped` restart — seconds of downtime, not minutes.
 *
 *     cap = clamp(floor32(MemTotal / 4), 128, 512) MiB
 *
 * A quarter of the host, because the proxy shares it with the OS and Docker
 * (~216 MiB measured on 1GB), musdash, the build daemon, and every app.
 *
 * MIN is headroom over what Caddy has been measured to use: 18–44 MiB idle on
 * the 512MB host, 67 MiB on the 1GB host serving three apps. 128 is about
 * twice the largest. It binds below 512 MiB of MemTotal, which is every "512MB"
 * host.
 *
 * MAX is the old fixed cap, so a MemTotal of 2 GiB and up behaves as before.
 *
 * Caddy sets GOMEMLIMIT to 90% of its cgroup limit on start ("GOMEMLIMIT is
 * updated" in its log), so the cap also makes its garbage collector work
 * harder before the kernel has to step in. No environment variable is needed.
 *
 * No imports, and no Docker: the only input is MemTotal as the DAEMON reports
 * it, so this stays right when the daemon is on another machine.
 */

const MIB = 1024 * 1024
const MIN = 128 * MIB
const MAX = 512 * MIB
const STEP = 32 * MIB

/** Precondition: memTotalBytes is a finite integer > 0 (EngineInfo guarantees it). */
export function proxyMemoryCap(memTotalBytes: number): number {
  // Checked anyway: a NaN would compare false against MIN and MAX alike and
  // reach the Engine as a memory limit.
  if (!Number.isInteger(memTotalBytes) || memTotalBytes <= 0) {
    throw new RangeError(
      `host memory must be a positive integer of bytes, got ${memTotalBytes}`,
    )
  }
  const stepped = Math.floor(memTotalBytes / 4 / STEP) * STEP
  return Math.min(Math.max(stepped, MIN), MAX)
}
