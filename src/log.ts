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

/** Redacts any occurrence of a secret value inside free text (log lines). */
export function redactValues(text: string, secrets: Iterable<string>): string {
  let out = text
  for (const s of secrets) {
    if (s.length < 4) continue // too short to match meaningfully
    out = out.split(s).join(REDACTED)
  }
  return out
}
