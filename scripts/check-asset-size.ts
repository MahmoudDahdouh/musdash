#!/usr/bin/env bun
/**
 * The asset gate. Fails CI when the dashboard's own CSS or JS outgrows its
 * byte budget.
 *
 * docs/UI-UX-PLAN.md §2: the "lightweight" promise has to be a gate rather
 * than a hope. Both files are embedded in the binary and downloaded by every
 * browser that opens the dashboard, and a stylesheet grows one reasonable
 * rule at a time — without a number to hit, nobody notices until it is three
 * times the size. Sizes are
 * the unminified bytes on disk; .gitattributes forces LF, so the count is the
 * same on Windows and Linux. The vendored alpine.js is not ours to trim.
 *
 *   bun run gate:assets
 *   bun run scripts/check-asset-size.ts --root <dir>   check another tree
 */

const BUDGETS: ReadonlyArray<{ path: string; bytes: number }> = [
  { path: "public/app.css", bytes: 32 * 1024 },
  { path: "public/app.js", bytes: 16 * 1024 },
]

function rootDir(): string {
  const i = process.argv.indexOf("--root")
  if (i === -1) return `${import.meta.dir}/..`
  const given = process.argv[i + 1]
  // A mistyped override must not quietly check the real tree and pass.
  if (!given || given.startsWith("--")) {
    console.error("FAIL  --root needs a directory")
    process.exit(1)
  }
  return given
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`

const root = rootDir()
let failed = false

for (const { path, bytes: budget } of BUDGETS) {
  const file = Bun.file(`${root}/${path}`)
  if (!(await file.exists())) {
    console.error(`FAIL  ${path}  not found`)
    failed = true
    continue
  }
  if (file.size > budget) {
    console.error(
      `FAIL  ${path}  ${file.size} bytes exceeds the ${budget}-byte (${kb(budget)}) budget ` +
        "(docs/UI-UX-PLAN.md §2). The budget does not move without a recorded decision.",
    )
    failed = true
    continue
  }
  console.log(`PASS  ${path}  ${kb(file.size)} of ${kb(budget)}`)
}

process.exit(failed ? 1 : 0)
