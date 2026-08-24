import pino from "pino"
import { config } from "./config.ts"

/**
 * Pino in its plain synchronous-to-stdout mode. No transports and no pretty
 * printer: a transport spawns a worker thread, and "one long-running process"
 * is an architectural invariant, not a preference.
 */
export const logger = pino({
  level: config.logLevel,
  base: undefined, // drop pid/hostname — noise for a single-process app
  timestamp: pino.stdTimeFunctions.isoTime,
})

const REDACTED = "[redacted]"

/**
 * Env var values are secrets. They must never reach a log line, including on
 * the error paths, so anything carrying them goes through here first.
 */
export function redactEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of Object.keys(env)) out[key] = REDACTED
  return out
}

/**
 * GitHub credentials, which redactValues() structurally cannot catch.
 *
 * redactValues works by substring match against a known set — the decrypted env
 * vars of the resource being deployed. An installation token is minted at
 * runtime and belongs to no such set, so it would print verbatim. Same for the
 * signed archive URL, which is itself a bearer credential.
 *
 * This is a backstop, not the defence. The defence is never constructing a log
 * line that contains one; see src/github/api.ts.
 */
const GITHUB_SECRET_RE =
  /gh[pousr]_[A-Za-z0-9]{20,}|https:\/\/codeload\.github\.com\/\S+|-----BEGIN[^-]*PRIVATE KEY-----/g

export function redactGithub(text: string): string {
  return text.replace(GITHUB_SECRET_RE, REDACTED)
}

/** Redacts any occurrence of a secret value inside free text (log lines). */
export function redactValues(text: string, secrets: Iterable<string>): string {
  let out = text
  for (const s of secrets) {
    if (s.length < 4) continue // too short to match meaningfully
    out = out.split(s).join(REDACTED)
  }
  return out
}
