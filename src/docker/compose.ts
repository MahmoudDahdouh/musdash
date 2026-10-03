import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { config } from "../config.ts"
import { SpawnError, spawnStreaming } from "../proc/stream.ts"
import type { DockerClient } from "./client.ts"

/**
 * The `docker compose` CLI, behind the Docker seam (docs/PHASE-3-PLAN.md
 * §3.2). This is the ONLY code that spawns it. Compose is shelled out to,
 * never reimplemented: it is the substrate for every multi-container
 * resource, and its memory is a subprocess's — transient, not resident.
 *
 * Two rules hold for every invocation, because they are what stop a user's
 * variable or file from steering the CLI itself (D65 items 9 and 14):
 *
 * - `-p <project>` always, and `-f <file> --project-directory <dir>` whenever
 *   there is a file. Explicit flags beat COMPOSE_PROJECT_NAME / COMPOSE_FILE;
 *   without them an env value could redirect Compose entirely.
 * - The environment is exactly PATH, HOME and DOCKER_HOST — never
 *   process.env, which carries musdash's own MUSDASH_* settings and, on a
 *   host whose `docker` is dynamically linked, would let an inherited LD_*
 *   variable load code into it. Only `config` additionally sees the user's
 *   variables, already filtered by interpolationEnv, and ours win over theirs.
 *
 * Arguments are arrays handed to Bun.spawn, never a shell string, so nothing
 * here can be injected into.
 */

export interface ComposeInvocation {
  /** `musdash-<resourceId lowercased>`. */
  project: string
  /** The temporary directory the file lives in; the project directory. */
  dir: string
  /** Absolute path of the Compose file. */
  file: string
}

export interface ComposeCli {
  /**
   * `config --format json`: Compose's own normalised model, parsed. `env` is
   * the file's interpolation environment, already filtered.
   */
  config(p: ComposeInvocation, env: Record<string, string>): Promise<unknown>
  pull(p: ComposeInvocation, onLog: (line: string) => void): Promise<void>
  /** `up -d --remove-orphans --no-build`. Never `-V`: volumes survive. */
  up(p: ComposeInvocation, onLog: (line: string) => void): Promise<void>
  /** `stop`, from labels alone (D65 item 10). */
  stop(project: string, onLog: (line: string) => void): Promise<void>
  /** `down --remove-orphans`, from labels alone. NEVER `--volumes`. */
  down(project: string, onLog: (line: string) => void): Promise<void>
}

/**
 * A Compose failure, with a message fit to show: a fixed sentence for the
 * failures musdash recognises, otherwise the CLI's own last error line. It
 * never adds a variable's value; the caller still redacts it, because the
 * CLI's line may quote the already-interpolated file.
 */
export class ComposeError extends Error {
  override readonly name = "ComposeError"
}

/** The PATH every Compose process gets — the usual system directories. */
export const COMPOSE_PATH =
  "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

const PROJECT_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/

const CONFIG_TIMEOUT_MS = 30_000
const CONFIG_MAX_STDOUT = 4 * 1024 * 1024
const CONFIG_MAX_STDERR = 64 * 1024
/** A pull or up that runs longer than this is stopped. */
const LONG_TIMEOUT_MS = 15 * 60 * 1000
/** A stop or down that runs longer than this is stopped. */
const SHORT_TIMEOUT_MS = 2 * 60 * 1000
/** SIGTERM, then SIGKILL after this, for config — which streams nothing. */
const CONFIG_KILL_GRACE_MS = 10_000

export const MSG_NOT_INSTALLED =
  "Docker Compose is not installed on this server. Install the docker-compose-plugin package, then deploy again."
export const MSG_ADDRESS_POOLS =
  "Docker has run out of network address pools for new stacks (about 30 fit on a default install). Delete an unused stack, or widen default-address-pools in /etc/docker/daemon.json."

/**
 * The argv of one invocation. Pure, so the flags every call must carry are
 * testable without a daemon.
 */
export function composeArgv(
  project: string,
  target: { file: string; dir: string } | null,
  args: readonly string[],
): string[] {
  if (!PROJECT_RE.test(project)) {
    throw new ComposeError(`invalid Compose project name ${project}`)
  }
  const argv = [
    "docker",
    "compose",
    // Line-shaped output with no escape codes (D65 item 11).
    "--ansi",
    "never",
    "--progress",
    "plain",
    "-p",
    project,
  ]
  if (target !== null) {
    argv.push("-f", target.file, "--project-directory", target.dir)
  }
  argv.push(...args)
  return argv
}

/**
 * The whole environment of one invocation: PATH, HOME and DOCKER_HOST, plus
 * — for `config` only — the user's filtered variables UNDER them, so a
 * variable named DOCKER_HOST or PATH can never replace ours. Pure.
 */
export function composeEnv(
  home: string,
  dockerHost: string,
  user?: Readonly<Record<string, string>>,
): Record<string, string> {
  // fromEntries defines own properties, so a user key `__proto__` stays an
  // ordinary (and harmless) variable rather than a prototype assignment.
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(user ?? {}),
  )
  env.PATH = COMPOSE_PATH
  env.HOME = home
  env.DOCKER_HOST = dockerHost
  return env
}

/**
 * The CLI's logrus wrapper, `time="…" level=error msg="…"`, around the part a
 * person wants to read.
 */
const LOGRUS_LINE = /^time="[^"]*"\s+level=[a-z]+\s+msg="((?:[^"\\]|\\.)*)"/

const ADDRESS_POOLS =
  /all predefined address pools have been fully subnetted|could not find an available, non-overlapping IPv4 address pool/i
const NOT_A_COMMAND =
  /'compose' is not a docker command|unknown command:? "?docker compose|unknown shorthand flag: 'p' in -p/i

/**
 * The message for a failed invocation, from the CLI's stderr. Pure.
 *
 * Recognised failures get a fixed sentence saying what to do. Anything else
 * is the last non-empty stderr line with the logrus wrapper removed, or the
 * exit code when there is none.
 */
export function composeErrorMessage(
  action: string,
  stderrLines: readonly string[],
  exitCode: number | null,
): string {
  if (stderrLines.some((l) => ADDRESS_POOLS.test(l))) return MSG_ADDRESS_POOLS
  if (stderrLines.some((l) => NOT_A_COMMAND.test(l))) return MSG_NOT_INSTALLED
  for (let i = stderrLines.length - 1; i >= 0; i--) {
    const line = (stderrLines[i] ?? "").trim()
    if (line === "") continue
    const wrapped = LOGRUS_LINE.exec(line)?.[1]
    const text =
      wrapped === undefined ? line : wrapped.replace(/\\(["\\])/g, "$1").trim()
    if (text !== "") return text
  }
  return exitCode === null
    ? `docker compose ${action} failed`
    : `docker compose ${action} exited with code ${exitCode}`
}

/** Whether a spawn failure means the `docker` binary itself is missing. */
function isNotInstalled(err: unknown): boolean {
  return err instanceof SpawnError && err.code === "ENOENT"
}

/** The HOME every Compose process gets: an empty directory musdash owns. */
export function composeHome(): string {
  return resolve(config.dataDir, "compose", "home")
}

/**
 * Creates HOME if it is missing, before every spawn: a missing working
 * directory makes the spawn fail with ENOENT, which would otherwise read as
 * "Compose is not installed". 0700 — the CLI may write its own config there.
 */
function ensureHome(home: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 })
}

type Reader = {
  read(): Promise<{ done: true } | { done: false; value: Uint8Array }>
  cancel(): Promise<void>
}

/**
 * The stream's text, or null once it passes `maxBytes` (`keep: "head"`), or
 * its last `maxBytes` (`keep: "tail"`) — stderr is wanted for its last line.
 */
async function readCapped(
  reader: Reader,
  maxBytes: number,
  keep: "head" | "tail",
): Promise<string | null> {
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    chunks.push(chunk.value)
    total += chunk.value.byteLength
    if (total > maxBytes) {
      if (keep === "head") return null
      while (
        chunks.length > 1 &&
        total - (chunks[0]?.byteLength ?? 0) >= maxBytes
      ) {
        total -= chunks.shift()?.byteLength ?? 0
      }
    }
  }
  return Buffer.concat(chunks).toString("utf8")
}

export function composeCli(docker: DockerClient): ComposeCli {
  const home = composeHome()

  /** pull, up, stop and down: streamed through the shared pump. */
  const streamed = async (
    action: string,
    project: string,
    target: ComposeInvocation | null,
    args: string[],
    timeoutMs: number,
    onLog: (line: string) => void,
  ): Promise<void> => {
    const argv = composeArgv(project, target, args)
    ensureHome(home)
    let result: Awaited<ReturnType<typeof spawnStreaming>>
    try {
      result = await spawnStreaming({
        argv,
        cwd: target?.dir ?? home,
        env: composeEnv(home, docker.composeHost()),
        timeoutMs,
        onLine: onLog,
      })
    } catch (err) {
      if (isNotInstalled(err)) throw new ComposeError(MSG_NOT_INSTALLED)
      throw err
    }
    if (result.stopped === "timeout") {
      throw new ComposeError(
        `docker compose ${action} did not finish within ${Math.round(timeoutMs / 60_000)} minutes and was stopped`,
      )
    }
    if (result.exitCode !== 0) {
      throw new ComposeError(
        composeErrorMessage(action, result.stderrTail, result.exitCode),
      )
    }
  }

  return {
    async config(p, env) {
      const argv = composeArgv(p.project, p, ["config", "--format", "json"])
      ensureHome(home)
      let proc: Bun.Subprocess<"ignore", "pipe", "pipe">
      try {
        proc = Bun.spawn(argv, {
          cwd: p.dir,
          env: composeEnv(home, docker.composeHost(), env),
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        })
      } catch (err) {
        if (codeOf(err) === "ENOENT") throw new ComposeError(MSG_NOT_INSTALLED)
        throw new ComposeError("docker compose config could not be started")
      }

      const stdoutReader = proc.stdout.getReader()
      const stderrReader = proc.stderr.getReader()
      let killTimer: Timer | undefined
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        proc.kill()
        killTimer = setTimeout(() => proc.kill("SIGKILL"), CONFIG_KILL_GRACE_MS)
      }, CONFIG_TIMEOUT_MS)
      try {
        const [out, err] = await Promise.all([
          // Killed the moment stdout overflows: otherwise Compose blocks on
          // the unread pipe, and stderr's read waits for the timeout.
          readCapped(stdoutReader, CONFIG_MAX_STDOUT, "head").then((text) => {
            if (text === null) proc.kill("SIGKILL")
            return text
          }),
          readCapped(stderrReader, CONFIG_MAX_STDERR, "tail"),
        ])
        if (out === null) {
          throw new ComposeError(
            "docker compose config printed more than 4 MiB; the file is too large to deploy",
          )
        }
        const code = await proc.exited
        if (timedOut) {
          throw new ComposeError(
            "docker compose config did not finish within 30 seconds",
          )
        }
        if (code !== 0) {
          throw new ComposeError(
            composeErrorMessage("config", (err ?? "").split("\n"), code),
          )
        }
        try {
          const model: unknown = JSON.parse(out)
          return model
        } catch {
          throw new ComposeError("docker compose config did not print JSON")
        }
      } finally {
        clearTimeout(timer)
        if (killTimer) clearTimeout(killTimer)
        void stdoutReader.cancel().catch(() => {})
        void stderrReader.cancel().catch(() => {})
      }
    },

    pull(p, onLog) {
      return streamed("pull", p.project, p, ["pull"], LONG_TIMEOUT_MS, onLog)
    },

    up(p, onLog) {
      return streamed(
        "up",
        p.project,
        p,
        ["up", "-d", "--remove-orphans", "--no-build"],
        LONG_TIMEOUT_MS,
        onLog,
      )
    },

    stop(project, onLog) {
      return streamed("stop", project, null, ["stop"], SHORT_TIMEOUT_MS, onLog)
    },

    down(project, onLog) {
      // Never --volumes / -v: a stack's named volumes hold its data, and
      // deleting them is a separate, explicit choice (§3.7, S4).
      return streamed(
        "down",
        project,
        null,
        ["down", "--remove-orphans"],
        SHORT_TIMEOUT_MS,
        onLog,
      )
    },
  }
}

function codeOf(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined
  const code: unknown = Reflect.get(err, "code")
  return typeof code === "string" ? code : undefined
}
