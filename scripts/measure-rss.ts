#!/usr/bin/env bun
/**
 * The RAM gate. Boots the compiled binary, idles, measures RSS, fails above the
 * ceiling.
 *
 * CLAUDE.md: "Every release build boots the binary, idles 60 seconds, measures
 * RSS, and fails the build if it exceeds 100MB. Without that gate the number
 * drifts silently and the product loses its reason to exist."
 *
 * Cross-platform because this is a Windows dev machine and a Linux CI/VPS:
 * `ps -o rss=` does not exist on Windows, so PowerShell is used there.
 *
 *   bun run gate:rss                 build, then measure
 *   bun run rss -- --idle 5          shorter idle while iterating
 *   bun run rss -- --ceiling 120     temporary ceiling (must be justified)
 */

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

const ceiling = arg("--ceiling", CEILING_MB)
const idle = arg("--idle", IDLE_SEC)

if (!(await Bun.file(BINARY).exists())) {
  console.error(`No binary at ${BINARY}. Run \`bun run build\` first.`)
  process.exit(1)
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

console.log(`Booting ${BINARY}, idling ${idle}s, ceiling ${ceiling}MB...`)

const proc = Bun.spawn([BINARY], {
  stdout: "ignore",
  stderr: "pipe",
  env: { ...process.env, NODE_ENV: "production" },
})

let failed = false
try {
  // Let the process finish starting before the clock starts.
  await Bun.sleep(2000)
  if (proc.exitCode !== null) {
    const err = (await new Response(proc.stderr).text()).trim()
    console.error(`Binary exited immediately (code ${proc.exitCode}).`)
    if (err) console.error(err)
    process.exit(1)
  }

  await Bun.sleep(idle * 1000)

  const mb = await rssMb(proc.pid)
  if (mb === null) {
    console.error(
      "Could not read RSS — process gone, or ps/powershell unavailable.",
    )
    process.exit(1)
  }

  const rounded = mb.toFixed(1)
  if (mb > ceiling) {
    console.error(
      `FAIL  idle RSS ${rounded}MB exceeds the ${ceiling}MB ceiling.`,
    )
    console.error(
      "The ceiling does not move to accommodate a new component without an explicit, justified decision recorded in docs/DECISIONS.md.",
    )
    failed = true
  } else {
    console.log(`PASS  idle RSS ${rounded}MB (ceiling ${ceiling}MB).`)
    console.log(
      // BuildKit's figure is measured, not the ~30MB estimated in PHASES §30:
      // moby/buildkit v0.27.0 idles at 12MB with a warm cache volume. It grows
      // during a build, which is transient and outside this idle number.
      "Sidecars are extra and reported separately: Caddy ~50MB, BuildKit idle ~12MB.",
    )
  }
} finally {
  proc.kill()
}

process.exit(failed ? 1 : 0)
