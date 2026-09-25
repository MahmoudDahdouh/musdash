#!/usr/bin/env bun
/**
 * Reproduces D35's request-body measurements (B-1) against a compiled binary.
 *
 * N-14: a verification claim has to be something anyone can rerun. This boots
 * the binary on a fresh data directory, creates a throwaway admin, sends the
 * scenario's requests with curl, and samples the process's RSS every 100 ms.
 *
 *   bun run build
 *   bun scripts/measure-body-limits.ts dist/musdash 18431 c10   # 3 x 100 MiB /login
 *   bun scripts/measure-body-limits.ts dist/musdash 18431 c11   # 50 x 1000 KiB /login and webhook
 *   bun scripts/measure-body-limits.ts dist/musdash 18431 c12   # chunked 2 MiB, keep-alive
 *
 * For the "before" row, build a binary from a commit before D35 and pass its
 * path. RSS comes from `ps`, so figures on macOS and Linux are comparable only
 * in shape; the VPS figure is the one that counts. Needs curl on PATH.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const [binary = "", portArg = "", scenario = ""] = process.argv.slice(2)
if (!binary || !portArg || !["c10", "c11", "c12"].includes(scenario)) {
  console.error(
    "usage: bun scripts/measure-body-limits.ts <binary> <port> <c10|c11|c12>",
  )
  process.exit(1)
}
const base = `http://127.0.0.1:${Number(portArg)}`
const work = mkdtempSync(join(tmpdir(), "musdash-b1-"))
const logFile = join(work, "musdash.log")

/** A payload file of exactly `bytes` bytes, starting with `prefix`. */
function payload(name: string, bytes: number, prefix = "a="): string {
  const path = join(work, name)
  writeFileSync(path, prefix + "x".repeat(bytes - prefix.length))
  return path
}

const log = Bun.file(logFile).writer()
const proc = Bun.spawn([binary], {
  env: {
    ...process.env,
    NODE_ENV: "production",
    MUSDASH_DATA_DIR: join(work, "data"),
    MUSDASH_PORT: portArg,
    MUSDASH_LOG_LEVEL: "debug",
  },
  stdout: "pipe",
  stderr: "pipe",
})
async function pump(stream: ReadableStream<Uint8Array>): Promise<void> {
  for await (const chunk of stream) log.write(chunk)
}
void pump(proc.stdout)
void pump(proc.stderr)

async function rssKb(): Promise<number> {
  const ps = Bun.spawn(["ps", "-o", "rss=", "-p", String(proc.pid)], {
    stdout: "pipe",
  })
  return Number((await new Response(ps.stdout).text()).trim())
}

/** The HTTP status curl saw, as a string ("000" when the request failed). */
async function curl(args: string[]): Promise<string> {
  const c = Bun.spawn(
    ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", ...args],
    { stdout: "pipe", stderr: "pipe" },
  )
  return (await new Response(c.stdout).text()).trim()
}

/** Runs `n` requests at once and prints the status histogram and RSS growth. */
async function measure(
  label: string,
  n: number,
  args: () => string[],
): Promise<void> {
  await Bun.sleep(1500)
  const idle: number[] = []
  for (let i = 0; i < 10; i++) {
    idle.push(await rssKb())
    await Bun.sleep(100)
  }
  const before = Math.max(...idle)
  let peak = before
  const run: { sampling: boolean } = { sampling: true }
  const sampler = (async () => {
    while (run.sampling) {
      peak = Math.max(peak, await rssKb())
      await Bun.sleep(100)
    }
  })()
  const codes = await Promise.all(Array.from({ length: n }, () => curl(args())))
  await Bun.sleep(500)
  run.sampling = false
  await sampler
  const histogram: Record<string, number> = {}
  for (const code of codes) histogram[code] = (histogram[code] ?? 0) + 1
  const mib = (kb: number) => (kb / 1024).toFixed(1)
  console.log(
    `${label}: codes=${JSON.stringify(histogram)} idle=${mib(before)}MiB peak=${mib(peak)}MiB growth=${mib(peak - before)}MiB`,
  )
}

const form = ["-H", "content-type: application/x-www-form-urlencoded"]
const webhook = [
  "-H",
  "content-type: application/json",
  "-H",
  "x-github-event: push",
]

try {
  for (let i = 0; i < 100; i++) {
    const up = await fetch(`${base}/health`).then(
      (r) => r.ok,
      () => false,
    )
    if (up) break
    await Bun.sleep(100)
  }
  const setup = await curl([
    "-X",
    "POST",
    `${base}/setup`,
    "--data-urlencode",
    "email=admin@example.test",
    "--data-urlencode",
    "password=throwaway-password-123",
  ])
  console.log(`setup: POST /setup -> ${setup}`)

  if (scenario === "c10") {
    const big = payload("100mib.bin", 100 * 1024 * 1024)
    await measure("3 x 100 MiB POST /login", 3, () => [
      "-X",
      "POST",
      `${base}/login`,
      ...form,
      "--data-binary",
      `@${big}`,
    ])
  }

  if (scenario === "c11") {
    const body = payload("1000kib.bin", 1000 * 1024)
    await measure("50 x 1000 KiB POST /login", 50, () => [
      "-X",
      "POST",
      `${base}/login`,
      ...form,
      "--data-binary",
      `@${body}`,
    ])
    const json = payload("1000kib.json", 1000 * 1024, '{"a":"')
    await measure(
      "50 x 1000 KiB POST /webhooks/github, bad signature",
      50,
      () => [
        "-X",
        "POST",
        `${base}/webhooks/github`,
        ...webhook,
        "-H",
        "x-hub-signature-256: sha256=00",
        "--data-binary",
        `@${json}`,
      ],
    )
  }

  if (scenario === "c12") {
    const two = payload("2mib.bin", 2 * 1024 * 1024)
    const chunked = [
      "-H",
      "transfer-encoding: chunked",
      "--data-binary",
      `@${two}`,
    ]
    const login = await curl([
      "-X",
      "POST",
      `${base}/login`,
      ...form,
      ...chunked,
    ])
    console.log(`chunked 2 MiB POST /login -> ${login}`)
    const hook = await curl([
      "-X",
      "POST",
      `${base}/webhooks/github`,
      ...webhook,
      ...chunked,
    ])
    console.log(`chunked 2 MiB POST /webhooks/github -> ${hook}`)
    const k300 = payload("300kib.bin", 300 * 1024)
    const reuse = Bun.spawn(
      [
        "curl",
        "-s",
        "-o",
        "/dev/null",
        "-w",
        "code=%{http_code} new_connections=%{num_connects}\\n",
        "-X",
        "POST",
        ...form,
        "--data-binary",
        `@${k300}`,
        `${base}/login`,
        "--next",
        "-s",
        "-w",
        "code=%{http_code} new_connections=%{num_connects}\\n",
        `${base}/health`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    console.log(
      `300 KiB POST /login, then GET /health on the same connection:\n${(await new Response(reuse.stdout).text()).trim()}`,
    )
  }
} finally {
  proc.kill()
  await proc.exited
  await log.end()
  console.log(`server log: ${logFile}`)
  // Payloads and the data directory go; the log stays for inspection.
  for (const f of [
    "data",
    "100mib.bin",
    "1000kib.bin",
    "1000kib.json",
    "2mib.bin",
    "300kib.bin",
  ]) {
    rmSync(join(work, f), { recursive: true, force: true })
  }
}
