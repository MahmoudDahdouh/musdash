/**
 * How much memory the build daemon may use, from how much the Docker host has.
 *
 * The cap used to be a fixed 1 GiB. On a 1GB VPS `docker stats` showed it as
 * the whole 961 MiB, so it limited nothing, and a runaway build could take the
 * host and the dashboard with it (V-1, D33). A build step is charged to the
 * buildkitd container's own cgroup — proven on cgroup v2 by capping the daemon
 * by hand at 384 MiB and running a step that allocates 50 MiB a second: the
 * kernel killed that step inside the container's cgroup, the daemon stayed up,
 * and the host bottomed out at 166 MiB available with the dashboard and an app
 * answering throughout (the 1GB VPS re-test, "V-1 premise test", D33). So a
 * cap that is smaller than the host is enough to contain a build. The work is
 * choosing it.
 *
 *     cap = clamp(floor32(min(MemTotal − 576 MiB, MemTotal / 2)), 192, 8192) MiB
 *
 * RESERVE is what has to survive while a build runs, measured on the 1GB host
 * at idle with two nginx apps: OS + dockerd + containerd ≈ 216 MiB (961 total,
 * 535 available, 210 in musdash and its containers), plus musdash at its deploy
 * peak rather than idle (128, V-3), Caddy 67 and the apps 14 — 425 MiB
 * measured. The remaining ~150 MiB is margin nobody has measured: the railpack
 * and buildctl clients and dockerd's spike while it imports the built image,
 * all host processes outside this cap, plus the file pages the kernel must keep
 * resident to avoid the C-3 eviction loop. It covers THAT workload only; every
 * further app eats into what is left, up to its own 512 MiB cap. If V-3's peak
 * moves, this number has to be revisited.
 *
 * Above MemTotal = 1152 MiB the half-of-host term binds instead. A resource's
 * old container keeps serving through its own rebuild — the zero-downtime
 * guarantee — so a build must not be able to push out what is serving: half to
 * the build, half to everything else. It also reproduces the old 1 GiB on a 2GB
 * host, the size RUNNING.md recommends for building.
 *
 * MIN is where buildkitd stops being able to build at all: it idles at ~66 MiB,
 * and 192 leaves ~125 for one small step. Below that the daemon's first build
 * would be killed in its own cgroup. The floor does NOT make a 512MB host safe
 * to build on — nothing in buildkitd's working range can — and the caller warns
 * when it binds; what to do about such hosts is C-3's decision.
 *
 * MAX only binds at 16 GiB and up. It is a judgement against a leaking build on
 * a big host, not a measurement; a legitimately larger build uses the override.
 *
 * STEP keeps the number round without costing much: 32 rather than 64 MiB, so
 * a "1GB" host a few MiB smaller than the measured 961 does not lose a whole
 * 64 MiB step. The cost of any step is boundary sensitivity — a host a few MiB
 * either side of a multiple gets a cap 32 MiB different — which is why the
 * value is logged on every boot.
 *
 * No imports, and no Docker: the only input is MemTotal as the DAEMON reports
 * it, so this stays right when the daemon is on another machine.
 */

const MIB = 1024 * 1024
const RESERVE = 576 * MIB
const MIN = 192 * MIB
const MAX = 8192 * MIB
const STEP = 32 * MIB

export interface BuildkitMemoryCap {
  /** The cap to pass as ContainerSpec.memoryLimitBytes. Always a multiple of 32 MiB. */
  bytes: number
  /** True when the host was too small for the formula and the floor was applied. */
  floored: boolean
}

/** Precondition: memTotalBytes is a finite integer > 0 (EngineInfo guarantees it). */
export function buildkitMemoryCap(memTotalBytes: number): BuildkitMemoryCap {
  // The precondition is checked anyway: a NaN here would compare false against
  // MIN and MAX alike and reach the Engine as a memory limit, which is the one
  // outcome this function exists to prevent.
  if (!Number.isInteger(memTotalBytes) || memTotalBytes <= 0) {
    throw new RangeError(
      `host memory must be a positive integer of bytes, got ${memTotalBytes}`,
    )
  }
  const raw = Math.min(memTotalBytes - RESERVE, Math.floor(memTotalBytes / 2))
  // Below 576 MiB `raw` is negative and this floors toward −∞. The exact value
  // never matters: anything under MIN takes the floor.
  const stepped = Math.floor(raw / STEP) * STEP
  if (stepped < MIN) return { bytes: MIN, floored: true }
  return { bytes: Math.min(stepped, MAX), floored: false }
}
