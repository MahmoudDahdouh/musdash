#!/usr/bin/env bun
/**
 * The RAM gate. Boots the compiled binary, idles, measures RSS, fails above the
 * ceiling.
 *
 * CLAUDE.md: "Every release build boots the binary, idles 60 seconds, measures
 * RSS, and fails the build if it exceeds 100MB. Without that gate the number
 * drifts silently and the product loses its reason to exist."
 *
 * Cross-platform because development has happened on Windows and macOS and the
 * gate runs on Linux CI and VPSes: `ps -o rss=` does not exist on Windows, so
 * PowerShell is used there.
 *
 * On Linux it also prints the PEAK resident set (VmHWM) next to the idle one,
 * and the idle figure split into anonymous and file-backed pages. Both are
 * informational, never gated: the ceiling is an idle total by definition.
 *
 * The peak is the process's lifetime high-water mark, and this run never signs
 * in or deploys, so it is the boot peak only. On a real VPS the dominant peak
 * was sign-in, not deploys: argon2id at Bun's default cost took 64 MiB per hash
 * (V-3, D34), since cut to 7 MiB. Every deploy still logs the process's
 * lifetime peak as `peakRssMb` on its "deploy finished" line.
 *
 * The split explains why the VPS reads higher than a Mac (V-2): on Linux about
 * 40MB of the total is RssFile — clean pages of the mapped compiled binary,
 * which the kernel can reclaim — and only the rest is musdash's own heap. The
 * gate still judges the total, which is the conservative number.
 *
 * The binary runs isolated: every inherited MUSDASH_* variable is dropped, and
 * it gets a free port and a fresh temporary data directory. A second musdash
 * with an empty database and the real Docker socket treats every app container
 * on the host as an orphan and removes it (R-3), so by default it also gets a
 * socket path that does not exist and the gate is safe on a live server. That
 * idle figure leaves out Docker work: the sidecar bootstrap jobs and the
 * reconciler's calls fail fast instead.
 *
 * CI passes --with-docker, so the gated figure keeps the real socket: the
 * worker pulls and starts Caddy and BuildKit and the reconciler talks to Docker
 * during the idle, the conservative number. It refuses to run where any
 * musdash-managed container exists, which is exactly the host it would damage.
 *
 *   bun run gate:rss                 build, then measure
 *   bun run rss -- --idle 5          shorter idle while iterating
 *   bun run rss -- --ceiling 120     temporary ceiling (must be justified)
 *   bun run rss -- --with-docker     real Docker socket; refused beside musdash
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const CEILING_MB = 100
const IDLE_SEC = 60
const BINARY =
  process.platform === "win32" ? "dist/musdash.exe" : "dist/musdash"

function arg(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag)
  if (i === -1) return fallback
  const v = Number(process.argv[i + 1])
  return Number.isFinite(v) && v > 0 ? v : fallback
}

/** A port nothing is listening on right now, chosen by the kernel. */
function freePort(): number {
  const server = Bun.listen({
    // The address the binary binds (src/config.ts), so a port another
    // interface already holds is not handed out.
    hostname: "0.0.0.0",
    port: 0,
    socket: { data() {} },
  })
  const { port } = server
  server.stop(true)
  return port
}

const ceiling = arg("--ceiling", CEILING_MB)
const idle = arg("--idle", IDLE_SEC)
const withDocker = process.argv.includes("--with-docker")

if (!(await Bun.file(BINARY).exists())) {
  console.error(`No binary at ${BINARY}. Run \`bun run build\` first.`)
  process.exit(1)
}

if (withDocker) {
  // Asks the same daemon the binary will reach through its default socket.
  const ps = Bun.spawn(
    ["docker", "ps", "-aq", "--filter", "label=musdash.managed"],
    { stdout: "pipe", stderr: "ignore" },
  )
  const ids = (await new Response(ps.stdout).text()).trim()
  if ((await ps.exited) !== 0 || ids !== "") {
    console.error(
      ids === ""
        ? "--with-docker: could not list containers with the docker CLI."
        : "--with-docker: this host runs musdash containers, which the gate's empty database would remove as orphans. Run without --with-docker.",
    )
    process.exit(1)
  }
}

/** Resident set size in MB for a live pid, or null if it cannot be read. */
async function rssMb(pid: number): Promise<number | null> {
  if (process.platform === "win32") {
    const p = Bun.spawn(
      [
        "powershell",
        "-NoProfile",
        "-Command",
        `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).WorkingSet64`,
      ],
      { stdout: "pipe", stderr: "ignore" },
    )
    const out = (await new Response(p.stdout).text()).trim()
    const bytes = Number(out)
    return Number.isFinite(bytes) && bytes > 0 ? bytes / 1024 / 1024 : null
  }
  // Linux/macOS: ps reports RSS in kilobytes.
  const p = Bun.spawn(["ps", "-o", "rss=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
  })
  const out = (await new Response(p.stdout).text()).trim()
  const kb = Number(out)
  return Number.isFinite(kb) && kb > 0 ? kb / 1024 : null
}

/**
 * Peak resident set size in MB (Linux VmHWM), or null where /proc has no such
 * line — macOS and Windows expose no equivalent through a cheap interface.
 */
async function peakRssMb(pid: number): Promise<number | null> {
  const status = await Bun.file(`/proc/${pid}/status`)
    .text()
    .catch(() => "")
  const kb = Number(status.match(/^VmHWM:\s+(\d+)\s+kB/m)?.[1])
  return Number.isFinite(kb) && kb > 0 ? kb / 1024 : null
}

/**
 * The resident set split into anonymous (heap) and file-backed (mapped binary)
 * pages, in MB, or null where /proc has no such lines — macOS and Windows.
 */
async function rssSplitMb(
  pid: number,
): Promise<{ anon: number; file: number } | null> {
  const status = await Bun.file(`/proc/${pid}/status`)
    .text()
    .catch(() => "")
  const anon = Number(status.match(/^RssAnon:\s+(\d+)\s+kB/m)?.[1])
  const file = Number(status.match(/^RssFile:\s+(\d+)\s+kB/m)?.[1])
  return Number.isFinite(anon) && Number.isFinite(file)
    ? { anon: anon / 1024, file: file / 1024 }
    : null
}

console.log(`Booting ${BINARY}, idling ${idle}s, ceiling ${ceiling}MB...`)

const dataDir = await mkdtemp(join(tmpdir(), "musdash-rss-"))
const env: Record<string, string | undefined> = {}
for (const [key, value] of Object.entries(process.env)) {
  if (!key.startsWith("MUSDASH_")) env[key] = value
}
Object.assign(env, {
  NODE_ENV: "production",
  MUSDASH_DATA_DIR: dataDir,
  ...(withDocker
    ? {}
    : { MUSDASH_DOCKER_SOCKET: join(dataDir, "no-docker.sock") }),
})

// stdin and stdout ignored, stderr piped: what the spawn below passes.
type Child = Bun.Subprocess<"ignore", "ignore", "pipe">
let proc: Child | undefined

/** Stops the binary and removes its data directory. Never throws. */
async function cleanUp(): Promise<void> {
  if (proc !== undefined && proc.exitCode === null) {
    proc.kill()
    // Wait for the exit before deleting the directory the process writes to.
    await Promise.race([proc.exited, Bun.sleep(5000)])
    if (proc.exitCode === null) {
      proc.kill("SIGKILL")
      await Promise.race([proc.exited, Bun.sleep(2000)])
    }
  }
  await rm(dataDir, { recursive: true, force: true }).catch((err: unknown) => {
    console.warn(`Could not remove ${dataDir}: ${String(err)}`)
  })
}

// Ctrl-C or a cancelled CI job would otherwise skip the finally below.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void cleanUp().then(() => process.exit(1))
  })
}

/**
 * Idles the running binary and judges its RSS. Returns instead of calling
 * process.exit, so the caller's finally still kills it and removes its data
 * directory.
 */
async function measure(child: Child): Promise<boolean> {
  // Let the process finish starting before the clock starts.
  await Bun.sleep(2000)
  if (child.exitCode !== null) {
    const err = (await new Response(child.stderr).text()).trim()
    console.error(`Binary exited immediately (code ${child.exitCode}).`)
    if (err) console.error(err)
    return false
  }

  await Bun.sleep(idle * 1000)

  const mb = await rssMb(child.pid)
  if (mb === null) {
    console.error(
      "Could not read RSS — process gone, or ps/powershell unavailable.",
    )
    return false
  }

  const rounded = mb.toFixed(1)
  const peak = await peakRssMb(child.pid)
  if (peak !== null) {
    console.log(
      `INFO  peak RSS since start ${peak.toFixed(1)}MB — boot and idle only, not gated. ` +
        'Sign-in and deploys raise it; every deploy logs the lifetime peak as peakRssMb ("deploy finished").',
    )
  }
  const split = await rssSplitMb(child.pid)
  if (split !== null) {
    console.log(
      `INFO  idle RSS is ${split.anon.toFixed(1)}MB anonymous + ${split.file.toFixed(1)}MB file-backed ` +
        "(the mapped binary, reclaimable) — not gated; the gate judges the total.",
    )
  }
  if (mb > ceiling) {
    console.error(
      `FAIL  idle RSS ${rounded}MB exceeds the ${ceiling}MB ceiling.`,
    )
    console.error(
      "The ceiling does not move to accommodate a new component without an explicit, justified decision recorded in docs/DECISIONS.md.",
    )
    return false
  }
  console.log(`PASS  idle RSS ${rounded}MB (ceiling ${ceiling}MB).`)
  console.log(
    // Measured on the 1 GB RamNode host (docs/RUNNING.md, host size), the
    // same figures CLAUDE.md quotes. BuildKit grows during a build, up to
    // its cap, which is transient and outside this idle number.
    "Sidecars are extra and reported separately: Caddy ~50–70MB, BuildKit idle ~66MB.",
  )
  return true
}

let passed = false
try {
  env.MUSDASH_PORT = String(freePort())
  proc = Bun.spawn([BINARY], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    env,
  })
  passed = await measure(proc)
} finally {
  await cleanUp()
}

process.exit(passed ? 0 : 1)
