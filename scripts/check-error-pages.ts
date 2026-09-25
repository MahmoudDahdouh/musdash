#!/usr/bin/env bun
/**
 * Reproduces V-4's acceptance criteria 1–9 (D37) against a compiled binary.
 *
 * N-14: a verification claim has to be something anyone can rerun. This boots
 * the binary on a fresh data directory, creates a throwaway admin and a
 * project / environment / resource through the real forms, then sends every
 * refusal in the brief's inventory and checks what comes back: the keyed 303s
 * and the notice their Location renders, the signed-in 400/403/404 pages, and
 * that nothing a refused form carried — the sentinel below — reaches a
 * Location, a page or the server log.
 *
 *   bun run build
 *   bun scripts/check-error-pages.ts dist/musdash 18433
 *
 * Prints one PASS/FAIL line per case and exits non-zero on any failure.
 *
 * The database is only ever READ while the binary runs, through a read-only
 * handle, so musdash stays its only writer. Three refusals need rows no form
 * can create — a connected GitHub installation (the repo and branch checks
 * behind it) and an image resource with no image (the deploy guard) — so the
 * script stops the binary, seeds them with a separate writable handle, closes
 * it, and boots again (V-4 amendment A2). The seeded App's key material is
 * junk, so the project page's repository picker fails closed without touching
 * the network.
 *
 * Docker is pointed at a socket that does not exist, so the jobs a successful
 * form enqueues fail harmlessly instead of touching the host's daemon.
 */
import { Database } from "bun:sqlite"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Subprocess } from "bun"
import { ERROR_KEYS, type ErrorKey } from "../src/routes/errors.ts"

const [binary = "", portArg = ""] = process.argv.slice(2)
if (!binary || !/^\d+$/.test(portArg)) {
  console.error("usage: bun scripts/check-error-pages.ts <binary> <port>")
  process.exit(1)
}
const base = `http://127.0.0.1:${Number(portArg)}`
const work = mkdtempSync(join(tmpdir(), "musdash-v4-"))
const dataDir = join(work, "data")
const dbPath = join(dataDir, "musdash.db")
const logFile = join(work, "musdash.log")

/** Planted in every free-text field of every refused form (criterion 3). */
const SENTINEL = "S3NT1NEL"
const SENTINEL_RE = /s3nt1nel/i
const BOGUS = "00000000000000000000000000"

/**
 * The approved brief's sentences, copied here rather than read from the
 * partial: the check is against the spec, so a typo in the template fails.
 */
const SENTENCES: Record<ErrorKey, string> = {
  "image-invalid":
    "That is not a valid image reference. Use a name like nginx:alpine or ghcr.io/owner/app:1.2.",
  "resource-name-taken":
    "A resource with that name already exists in this environment. Choose another name.",
  "repo-required":
    "Choose a repository, or enter a local path, before creating the resource.",
  "branch-invalid":
    'That is not a valid branch name. Branch names cannot contain spaces, "..", or any of ~ ^ : ? * [ \\',
  "env-name-taken":
    "This project already has an environment with that name. Choose another name.",
  "domain-invalid":
    "That does not look like a hostname. Enter a name such as app.example.com, without https:// or a path.",
  "domain-taken":
    "That domain is already attached to a resource. Remove it there first, or choose another name.",
  "domain-dashboard":
    "That is the dashboard's own address, so a resource cannot use it. Choose another name, or change the dashboard address under Settings.",
  "env-invalid-line":
    "Nothing was saved. Every line must be NAME=value, and each name must use letters, digits and underscores, not start with a digit, and appear once per box. Fix the line and paste the variables again.",
  "env-scope-duplicate":
    "Nothing was saved. A name appears in more than one box. Keep it only in the box where it is needed and paste the variables again.",
  "github-no-domain":
    "GitHub needs a public HTTPS address for this dashboard. Set one under Dashboard address, then connect GitHub.",
  "github-no-flow":
    "There is no GitHub connection in progress. Press Connect GitHub to start again.",
  "github-state-mismatch":
    "That GitHub callback did not come from a connection started here. Press Connect GitHub to start again.",
  "github-no-code":
    "GitHub did not return a registration code. Press Connect GitHub to start again.",
  "github-confirm":
    "GitHub was not disconnected, because the request was not confirmed. Press Disconnect GitHub and confirm.",
}

const FORBIDDEN_SENTENCE =
  "Nothing was saved. Go back, reload that page, then try again."
const HTML_TYPE = "text/html; charset=utf-8"
const BACK_LINK = '<a class="btn" href="/">Back to projects</a>'
const SIDEBAR = '<aside class="sidebar"'
/** The tables a refused form must leave exactly as they were (criterion 1). */
const TABLES = [
  "projects",
  "environments",
  "resources",
  "domains",
  "env_vars",
  "shared_env_vars",
]

// ------------------------------------------------------------ bookkeeping

let failures = 0
function report(ok: boolean, label: string, detail: string): void {
  if (!ok) failures++
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`,
  )
}
/** Records a case whose problems list is empty on success. */
function verdict(label: string, problems: string[], ok: string): void {
  report(problems.length === 0, label, problems.join("; ") || ok)
}

const exercised = new Set<ErrorKey>()
/** Every response whose Location or body carried the sentinel. */
const exposures: string[] = []

/** Eta's escape map, so a sentence can be found in the rendered page. */
function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function count(haystack: string, needle: RegExp): number {
  return haystack.match(needle)?.length ?? 0
}

// ----------------------------------------------------------------- server

const log = Bun.file(logFile).writer()
const server: {
  proc: Subprocess<"ignore", "pipe", "pipe"> | null
  pumps: Promise<void>[]
} = { proc: null, pumps: [] }

async function pump(stream: ReadableStream<Uint8Array>): Promise<void> {
  for await (const chunk of stream) log.write(chunk)
}

async function boot(): Promise<void> {
  // Nothing MUSDASH_* from the caller's shell: a stray MUSDASH_PUBLIC_URL
  // would make github-no-domain unreachable.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("MUSDASH_")),
  )
  const proc = Bun.spawn([binary], {
    env: {
      ...inherited,
      NODE_ENV: "production",
      MUSDASH_DATA_DIR: dataDir,
      MUSDASH_PORT: portArg,
      MUSDASH_LOG_LEVEL: "debug",
      MUSDASH_DOCKER_SOCKET: join(work, "no-docker.sock"),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  server.proc = proc
  server.pumps = [pump(proc.stdout), pump(proc.stderr)]
  for (let i = 0; i < 100; i++) {
    const up = await fetch(`${base}/health`).then(
      (r) => r.ok,
      () => false,
    )
    if (up) return
    await Bun.sleep(100)
  }
  throw new Error("the binary did not answer /health within 10 s")
}

async function stop(): Promise<void> {
  const { proc } = server
  if (!proc) return
  proc.kill()
  await proc.exited
  await Promise.all(server.pumps)
  server.proc = null
  server.pumps = []
}

/** The server log so far. The sleep lets the pipes drain first. */
async function logText(): Promise<string> {
  await Bun.sleep(250)
  await log.flush()
  return readFileSync(logFile, "utf8")
}

// ------------------------------------------------------------------- http

interface Reply {
  status: number
  type: string
  location: string
  /** The first Set-Cookie pair, `name=value`, or "". */
  cookie: string
  body: string
}

const session = { cookie: "", csrf: "" }

async function send(
  method: "GET" | "POST",
  path: string,
  form?: Record<string, string>,
  opts: { anonymous?: boolean } = {},
): Promise<Reply> {
  const headers: Record<string, string> = {}
  if (!opts.anonymous && session.cookie) headers.cookie = session.cookie
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: form ? new URLSearchParams(form) : undefined,
    redirect: "manual",
  })
  const reply = {
    status: res.status,
    type: res.headers.get("content-type") ?? "",
    location: res.headers.get("location") ?? "",
    cookie: res.headers.getSetCookie()[0]?.split(";")[0] ?? "",
    body: await res.text(),
  }
  if (SENTINEL_RE.test(reply.location) || SENTINEL_RE.test(reply.body)) {
    exposures.push(`${method} ${path} -> ${reply.status}`)
  }
  return reply
}

/** A form body with the session's CSRF token added. */
function withCsrf(form: Record<string, string>): Record<string, string> {
  return { ...form, csrf: session.csrf }
}

// --------------------------------------------------------------- database

/** Every row of the guarded tables, read through a read-only handle. */
function snapshot(): { rows: string; counts: string } {
  const db = new Database(dbPath, { readonly: true })
  try {
    const rows: string[] = []
    const counts: string[] = []
    for (const table of TABLES) {
      const all = db.query(`SELECT * FROM ${table} ORDER BY id`).all()
      rows.push(`${table}:${JSON.stringify(all)}`)
      counts.push(`${table}=${all.length}`)
    }
    return { rows: rows.join("\n"), counts: counts.join(" ") }
  } finally {
    db.close()
  }
}

function readOne(sql: string, ...params: string[]): string {
  const db = new Database(dbPath, { readonly: true })
  try {
    const row = db.query(sql).get(...params) as { id?: unknown } | null
    return typeof row?.id === "string" ? row.id : ""
  } finally {
    db.close()
  }
}

// ------------------------------------------------------------------ checks

/** Problems with the layout's error notice on a followed page (criterion 2). */
function noticeProblems(body: string, key: ErrorKey): string[] {
  const problems: string[] = []
  // The repository picker renders one hidden notice per failing installation,
  // tagged data-installation; it is not the layout's notice.
  const picker = count(
    body,
    /class="notice notice-error"\s+role="alert"\s+data-installation=/g,
  )
  const total = count(body, /notice-error/g) - picker
  if (total !== 1) problems.push(`${total} notice-error elements, want 1`)
  // The layout's notice: an icon, then the text in its own <div>. Compared
  // exactly, so an extra word or a double-escaped quote fails too.
  const notice =
    /<div\s+class="notice notice-error"\s+role="alert"\s*>\s*<svg[\s\S]*?<\/svg>\s*<div>([\s\S]*?)<\/div>\s*<\/div>/.exec(
      body,
    )
  if (!notice) problems.push('no notice-error with role="alert"')
  else if (notice[1] !== escapeHtml(SENTENCES[key])) {
    problems.push(
      `notice text ${JSON.stringify(notice[1])} is not the ${key} sentence`,
    )
  }
  return problems
}

/**
 * A keyed refusal: 303 to exactly `expected`, no guarded row changed, and the
 * page at that Location shows the key's sentence once (criteria 1 and 2).
 */
async function keyed(
  label: string,
  key: ErrorKey,
  method: "GET" | "POST",
  path: string,
  form: Record<string, string> | undefined,
  expected: string,
): Promise<Reply> {
  exercised.add(key)
  const before = snapshot()
  const r = await send(method, path, form)
  const after = snapshot()
  const problems: string[] = []
  if (r.status !== 303) problems.push(`status ${r.status}, want 303`)
  if (r.location !== expected) {
    problems.push(`Location ${JSON.stringify(r.location)}, want ${expected}`)
  }
  if (before.rows !== after.rows) {
    problems.push(`rows changed: ${before.counts} -> ${after.counts}`)
  }
  if (r.location.startsWith("/")) {
    const page = await send("GET", r.location)
    if (page.status !== 200) problems.push(`followed: status ${page.status}`)
    if (!page.type.startsWith("text/html")) {
      problems.push(`followed: content-type ${page.type}`)
    }
    problems.push(
      ...noticeProblems(page.body, key).map((p) => `followed: ${p}`),
    )
  }
  verdict(`[1,2] ${label}`, problems, `303 ${r.location}, ${after.counts}`)
  return r
}

/** A status page inside the signed-in or signed-out frame (criteria 6–9). */
function statusProblems(
  r: Reply,
  status: 400 | 403 | 404,
  signedIn: boolean,
): string[] {
  const heading = {
    400: "That request was not valid",
    403: "This page had expired",
    404: "Not found",
  }[status]
  const problems: string[] = []
  if (r.status !== status) problems.push(`status ${r.status}, want ${status}`)
  if (r.type !== HTML_TYPE)
    problems.push(`content-type ${JSON.stringify(r.type)}`)
  if (signedIn && !r.body.includes(SIDEBAR)) problems.push("no sidebar")
  if (!signedIn && r.body.includes('class="sidebar"')) {
    problems.push("sidebar on a signed-out page")
  }
  if (!r.body.includes(`<h1>${heading}</h1>`)) problems.push(`no "${heading}"`)
  if (!r.body.includes(BACK_LINK)) problems.push('no href="/" back link')
  return problems
}

async function statusCase(
  label: string,
  status: 400 | 404,
  method: "GET" | "POST",
  path: string,
  form?: Record<string, string>,
): Promise<void> {
  const before = snapshot()
  const r = await send(method, path, form ? withCsrf(form) : undefined)
  const after = snapshot()
  const problems = statusProblems(r, status, true)
  if (before.rows !== after.rows) problems.push("rows changed")
  verdict(label, problems, `${status} ${HTML_TYPE}, signed-in`)
}

// ------------------------------------------------------------------- run

try {
  await boot()

  // ---- fixture, through the real forms
  const setup = await send("POST", "/setup", {
    email: "admin@example.test",
    password: "throwaway-password-123",
  })
  session.cookie = setup.cookie
  if (setup.status !== 303 || !session.cookie) {
    throw new Error(`setup failed: ${setup.status}`)
  }
  const home = await send("GET", "/")
  session.csrf = /name="csrf"\s+value="([^"]+)"/.exec(home.body)?.[1] ?? ""
  if (home.status !== 200 || !session.csrf) {
    throw new Error(`no CSRF token on / (status ${home.status})`)
  }

  const created = await send("POST", "/projects", withCsrf({ name: "Fixture" }))
  const pid = /^\/p\/([^/?#]+)$/.exec(created.location)?.[1] ?? ""
  const eid = readOne(
    "SELECT id FROM environments WHERE project_id = ? AND name = 'production'",
    pid,
  )
  const res = await send(
    "POST",
    `/e/${eid}/resources`,
    withCsrf({ name: "web", image: "nginx:alpine" }),
  )
  const rid = /^\/r\/([^/?#]+)$/.exec(res.location)?.[1] ?? ""
  const dom = await send(
    "POST",
    `/r/${rid}/domains`,
    withCsrf({ host: "taken.example.test" }),
  )
  if (!pid || !eid || !rid || dom.status !== 303) {
    throw new Error(
      `fixture failed: project=${pid} env=${eid} resource=${rid} domain=${dom.status}`,
    )
  }
  console.log(`fixture: project ${pid}, environment ${eid}, resource ${rid}`)

  // ---- keyed redirects (criteria 1, 2, 3)
  const p = `/p/${pid}`
  const r = `/r/${rid}`
  await keyed(
    "image invalid on create (314)",
    "image-invalid",
    "POST",
    `/e/${eid}/resources`,
    withCsrf({
      name: "imgnew",
      image: `${SENTINEL} image!`,
      healthPath: SENTINEL,
    }),
    `${p}?error=image-invalid`,
  )
  await keyed(
    "duplicate resource name, image (317)",
    "resource-name-taken",
    "POST",
    `/e/${eid}/resources`,
    withCsrf({ name: "web", image: "nginx:alpine", healthPath: SENTINEL }),
    `${p}?error=resource-name-taken`,
  )
  await keyed(
    "duplicate resource name, git (369)",
    "resource-name-taken",
    "POST",
    `/e/${eid}/resources/git`,
    withCsrf({
      name: "web",
      repo: SENTINEL,
      branch: SENTINEL,
      dockerfilePath: SENTINEL,
      buildContext: SENTINEL,
      healthPath: SENTINEL,
    }),
    `${p}?error=resource-name-taken`,
  )
  await keyed(
    "no repository (373)",
    "repo-required",
    "POST",
    `/e/${eid}/resources/git`,
    withCsrf({
      name: "gitnew",
      repo: "   ",
      branch: SENTINEL,
      dockerfilePath: SENTINEL,
      buildContext: SENTINEL,
      healthPath: SENTINEL,
    }),
    `${p}?error=repo-required`,
  )

  // Criterion 4: the duplicate environment is a notice, not a 500.
  const mark4 = (await logText()).length
  await keyed(
    "duplicate environment name (new, ≈295)",
    "env-name-taken",
    "POST",
    `${p}/environments`,
    withCsrf({ name: "production" }),
    `${p}?error=env-name-taken`,
  )
  const slice4 = (await logText()).slice(mark4)
  report(
    !slice4.includes("request failed"),
    "[4] env-name-taken logs no 'request failed'",
    "",
  )

  await keyed(
    "invalid hostname (601)",
    "domain-invalid",
    "POST",
    `${r}/domains`,
    withCsrf({ host: `https://${SENTINEL}.example.com/path` }),
    `${r}?tab=domains&error=domain-invalid`,
  )
  await keyed(
    "domain in use (604)",
    "domain-taken",
    "POST",
    `${r}/domains`,
    withCsrf({ host: "TAKEN.example.test" }),
    `${r}?tab=domains&error=domain-taken`,
  )
  await keyed(
    "image invalid in settings (643)",
    "image-invalid",
    "POST",
    `${r}/settings`,
    withCsrf({ image: `${SENTINEL} bad`, healthPath: SENTINEL }),
    `${r}?tab=settings&error=image-invalid`,
  )

  // Env forms: the sentinel as a line with no `=`, and as a valid line's value.
  const badLine = { runtime: SENTINEL, build: `GOOD_KEY=${SENTINEL}` }
  const dupe = { runtime: `DUP=${SENTINEL}`, both: `DUP=${SENTINEL}` }
  for (const [label, path, back] of [
    ["resource env (542)", `${r}/env`, `${r}?tab=env`],
    ["project env (557)", `${p}/env`, `${p}?tab=env`],
    ["environment env (583)", `/e/${eid}/env`, `${p}?tab=env`],
  ] as const) {
    await keyed(
      `${label}, bad line`,
      "env-invalid-line",
      "POST",
      path,
      withCsrf(badLine),
      `${back}&error=env-invalid-line`,
    )
    await keyed(
      `${label}, name in two boxes`,
      "env-scope-duplicate",
      "POST",
      path,
      withCsrf(dupe),
      `${back}&error=env-scope-duplicate`,
    )
  }

  await keyed(
    "callback with no flow (917)",
    "github-no-flow",
    "GET",
    `/settings/github/callback?state=${SENTINEL}&code=${SENTINEL}`,
    undefined,
    "/settings?error=github-no-flow",
  )
  // Before any dashboard host exists: the manifest cannot be built.
  await keyed(
    "connect with no dashboard address (893)",
    "github-no-domain",
    "POST",
    "/settings/github/connect",
    withCsrf({}),
    "/settings?error=github-no-domain",
  )

  const host = await send(
    "POST",
    "/settings/dashboard-host",
    withCsrf({ host: "dash.example.test" }),
  )
  if (host.status !== 303) throw new Error(`dashboard host: ${host.status}`)
  await keyed(
    "dashboard's own address (609)",
    "domain-dashboard",
    "POST",
    `${r}/domains`,
    withCsrf({ host: "dash.example.test" }),
    `${r}?tab=domains&error=domain-dashboard`,
  )

  // With a host set, connect starts a flow; its state is in the form action.
  const connect = await send("POST", "/settings/github/connect", withCsrf({}))
  const state = /[?&]state=([^"&]+)/.exec(connect.body)?.[1] ?? ""
  if (connect.status !== 200 || !state) {
    throw new Error(`connect did not start a flow: ${connect.status}`)
  }
  await keyed(
    "callback state mismatch (921)",
    "github-state-mismatch",
    "GET",
    `/settings/github/callback?state=${SENTINEL}&code=${SENTINEL}`,
    undefined,
    "/settings?error=github-state-mismatch",
  )
  await keyed(
    "callback with no code (928)",
    "github-no-code",
    "GET",
    `/settings/github/callback?state=${state}`,
    undefined,
    "/settings?error=github-no-code",
  )
  await keyed(
    "disconnect not confirmed (999)",
    "github-confirm",
    "POST",
    "/settings/github/disconnect",
    withCsrf({ confirm: SENTINEL }),
    "/settings?error=github-confirm",
  )

  // ---- criterion 5: unknown keys render nothing and echo nothing
  for (const page of [p, r, "/settings"]) {
    for (const value of [
      "__proto__",
      "constructor",
      "toString",
      "<b>x</b>",
      "nope",
    ]) {
      const g = await send(
        "GET",
        `${page}?${new URLSearchParams({ error: value })}`,
      )
      const problems: string[] = []
      if (g.status !== 200) problems.push(`status ${g.status}`)
      if (g.body.includes("notice-error"))
        problems.push("notice-error rendered")
      if (g.body.includes(value) || g.body.includes(escapeHtml(value))) {
        problems.push("value echoed")
      }
      verdict(`[5] ${page}?error=${value}`, problems, "200, no notice, no echo")
    }
  }
  {
    const g = await send("GET", `${r}?tab=env&envError=${SENTINEL}`)
    const problems: string[] = []
    if (g.status !== 200) problems.push(`status ${g.status}`)
    if (g.body.includes("notice-error")) problems.push("notice-error rendered")
    if (SENTINEL_RE.test(g.body)) problems.push("sentinel echoed")
    verdict(
      `[5] ${r}?tab=env&envError=${SENTINEL}`,
      problems,
      "no notice, no echo",
    )
  }

  // ---- criterion 6: the 16 not-found sites
  const env = { runtime: "A=1" }
  const notFound: [string, "GET" | "POST", string, Record<string, string>?][] =
    [
      ["243 GET /p/:id", "GET", `/p/${BOGUS}`],
      [
        "291 environments",
        "POST",
        `/p/${BOGUS}/environments`,
        { name: "staging" },
      ],
      [
        "307 resources",
        "POST",
        `/e/${BOGUS}/resources`,
        { name: "x", image: "nginx:alpine" },
      ],
      [
        "363 resources/git",
        "POST",
        `/e/${BOGUS}/resources/git`,
        { name: "x", repo: "owner/app", branch: "main" },
      ],
      ["441 GET /r/:id", "GET", `/r/${BOGUS}`],
      ["487 deploy", "POST", `/r/${BOGUS}/deploy`, {}],
      ["513 rollback", "POST", `/r/${BOGUS}/rollback`, {}],
      ["528 stop", "POST", `/r/${BOGUS}/stop`, {}],
      ["539 resource env", "POST", `/r/${BOGUS}/env`, env],
      ["555 project env", "POST", `/p/${BOGUS}/env`, env],
      ["576 environment env", "POST", `/e/${BOGUS}/env`, env],
      [
        "597 domains",
        "POST",
        `/r/${BOGUS}/domains`,
        { host: "a.example.test" },
      ],
      [
        "635 settings",
        "POST",
        `/r/${BOGUS}/settings`,
        { image: "nginx:alpine" },
      ],
      ["680 auto-deploy", "POST", `/r/${BOGUS}/auto-deploy`, { enabled: "on" }],
      ["699 delete", "POST", `/r/${BOGUS}/delete`, {}],
      ["713 GET /d/:id", "GET", `/d/${BOGUS}`],
    ]
  for (const [label, method, path, form] of notFound) {
    await statusCase(`[6] 404 ${label}`, 404, method, path, form)
  }

  // ---- criterion 7: the 400 sites reachable without seeding
  await statusCase(
    "[7] 400 env name invalid (293)",
    400,
    "POST",
    `${p}/environments`,
    {
      name: SENTINEL,
    },
  )
  await statusCase(
    "[7] 400 resource name invalid (311)",
    400,
    "POST",
    `/e/${eid}/resources`,
    {
      name: SENTINEL,
      image: "nginx:alpine",
    },
  )
  await statusCase(
    "[7] 400 git name invalid (366)",
    400,
    "POST",
    `/e/${eid}/resources/git`,
    {
      name: SENTINEL,
      repo: SENTINEL,
      branch: "main",
    },
  )
  await statusCase(
    "[7] 400 installation id not digits (381)",
    400,
    "POST",
    `/e/${eid}/resources/git`,
    {
      name: "gitx",
      repo: "owner/app",
      branch: "main",
      installationId: SENTINEL,
    },
  )
  await statusCase(
    "[7] 400 installation not connected (389)",
    400,
    "POST",
    `/e/${eid}/resources/git`,
    {
      name: "gitx",
      repo: "owner/app",
      branch: "main",
      installationId: "999999",
    },
  )
  await statusCase(
    "[7] 400 no previous image (516)",
    400,
    "POST",
    `${r}/rollback`,
    {},
  )
  await statusCase(
    "[7] 400 auto-deploy on an image resource (682)",
    400,
    "POST",
    `${r}/auto-deploy`,
    {
      enabled: "on",
    },
  )

  // ---- criterion 8: a stale CSRF token gets the signed-in 403 page
  for (const [label, path, form] of [
    ["app.ts POST /projects", "/projects", { name: "Nope" }],
    ["auth.ts POST /logout", "/logout", {}],
  ] as const) {
    const mark = (await logText()).length
    const before = snapshot()
    const f = await send("POST", path, { ...form, csrf: `wrong-${SENTINEL}` })
    const after = snapshot()
    const slice = (await logText()).slice(mark)
    const problems = statusProblems(f, 403, true)
    if (!f.body.includes(escapeHtml(FORBIDDEN_SENTENCE))) {
      problems.push("no 'Go back, reload' sentence")
    }
    if (f.body.includes(`wrong-${SENTINEL}`))
      problems.push("submitted token echoed")
    if (before.rows !== after.rows) problems.push("rows changed")
    const warned = slice
      .split("\n")
      .some(
        (line) =>
          line.includes('"level":40') &&
          line.includes("CSRF check failed") &&
          line.includes(`"path":"${path}"`),
      )
    if (!warned) problems.push("no warn-level 'CSRF check failed' line")
    verdict(
      `[8] 403 ${label}`,
      problems,
      "403 signed-in, token not echoed, warned",
    )
  }
  {
    const still = await send("GET", "/")
    report(
      still.status === 200 && still.body.includes(SIDEBAR),
      "[8] session survives the refused logout",
      `GET / -> ${still.status}`,
    )
  }

  // ---- criterion 9: signed-out 404, free-text settings flash untouched
  {
    const n = await send("GET", "/nonexistent", undefined, { anonymous: true })
    verdict(
      "[9] GET /nonexistent signed out",
      statusProblems(n, 404, false),
      "404 signed-out",
    )
    const flash = await send("GET", "/settings?flash=error&msg=flash-text-x")
    const ok =
      flash.status === 200 &&
      /class="notice notice-error"\s+role="alert"\s*>[\s\S]*?<div>flash-text-x<\/div>/.test(
        flash.body,
      )
    report(
      ok,
      "[9] /settings?flash=error&msg=… still shows the text",
      `status ${flash.status}`,
    )
  }

  // ---- A2: seed what no form can create, with the binary stopped
  await stop()
  const now = new Date().toISOString()
  const noImage = "01V4SEEDEDNOIMAGE000000000"
  {
    const db = new Database(dbPath)
    try {
      const junk = new Uint8Array([0])
      db.query(
        `INSERT INTO github_apps (id, app_id, slug, client_id, client_secret_enc,
           private_key_enc, webhook_secret_enc, created_at)
         VALUES (?, 1, 'v4-fixture', 'Iv1.fixture', ?, ?, ?, ?)`,
      ).run("01V4SEEDEDAPP0000000000000", junk, junk, junk, now)
      db.query(
        `INSERT INTO github_installations (id, app_id, installation_id,
           account_login, created_at) VALUES (?, ?, 4242, 'octo-fixture', ?)`,
      ).run("01V4SEEDEDINSTALL000000000", "01V4SEEDEDAPP0000000000000", now)
      db.query(
        `INSERT INTO resources (id, environment_id, name, kind, source_json,
           desired_state, memory_limit_mb, created_at)
         VALUES (?, ?, 'noimage', 'image', '{}', 'stopped', 512, ?)`,
      ).run(noImage, eid, now)
    } finally {
      db.close()
    }
  }
  console.log("seeded: GitHub installation 4242, image resource with no image")
  await boot()

  await statusCase(
    "[7] 400 repo not owner/name (392, seeded)",
    400,
    "POST",
    `/e/${eid}/resources/git`,
    {
      name: "gitx",
      repo: SENTINEL,
      branch: "main",
      installationId: "4242",
    },
  )
  await keyed(
    "invalid branch (395, seeded)",
    "branch-invalid",
    "POST",
    `/e/${eid}/resources/git`,
    withCsrf({
      name: "gitx",
      repo: "owner/app",
      branch: `${SENTINEL} x`,
      installationId: "4242",
      dockerfilePath: SENTINEL,
      buildContext: SENTINEL,
      healthPath: SENTINEL,
    }),
    `${p}?error=branch-invalid`,
  )
  await statusCase(
    "[7] 400 deploy with no image (495, seeded)",
    400,
    "POST",
    `/r/${noImage}/deploy`,
    {},
  )

  // ---- whole-run checks
  const missing = ERROR_KEYS.filter((k) => !exercised.has(k))
  report(
    missing.length === 0,
    "[2] every ERROR_KEYS key exercised",
    missing.length
      ? `missing: ${missing.join(", ")}`
      : `${ERROR_KEYS.length} keys`,
  )
  report(
    exposures.length === 0,
    "[3] sentinel in no Location or page",
    exposures.join("; "),
  )
  const full = await logText()
  const leaked = full.split("\n").filter((line) => SENTINEL_RE.test(line))
  report(
    leaked.length === 0,
    "[3] sentinel in no server log line",
    leaked.length ? `${leaked.length} line(s), first: ${leaked[0]}` : "",
  )
  report(
    !full.includes("request failed"),
    "[4] no 'request failed' anywhere in the log",
    "",
  )
} catch (err) {
  failures++
  console.log(`FAIL  aborted: ${(err as Error).message}`)
} finally {
  await stop()
  await log.end()
  rmSync(dataDir, { recursive: true, force: true })
  console.log(`server log: ${logFile}`)
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
