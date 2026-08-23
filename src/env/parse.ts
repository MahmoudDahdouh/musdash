/**
 * Parses the bulk `KEY=value` textarea from the resource Env tab.
 *
 * Deliberate behaviours, each of which has a test:
 *   - split on the FIRST `=` only, so values may contain `=` (base64, DSNs)
 *   - `export KEY=value` is accepted; people paste straight from a shell file
 *   - matching single or double quotes are stripped; escapes are honoured only
 *     inside double quotes, matching shell intuition
 *   - `#` starts a comment on its own line, and after a value only when the
 *     value was not quoted
 *   - a line with no `=` is an error rather than a silent drop, because
 *     silently losing a variable is worse than a visible complaint
 */

export interface ParsedEnv {
  vars: Record<string, string>
  errors: string[]
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export function parseEnvText(text: string): ParsedEnv {
  const vars: Record<string, string> = {}
  const errors: string[] = []

  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] as string
    const line = raw.trim()

    if (line === "" || line.startsWith("#")) continue

    const withoutExport = line.startsWith("export ")
      ? line.slice("export ".length).trim()
      : line

    const eq = withoutExport.indexOf("=")
    if (eq === -1) {
      errors.push(`line ${i + 1}: expected KEY=value, got "${line}"`)
      continue
    }

    const key = withoutExport.slice(0, eq).trim()
    if (!KEY_RE.test(key)) {
      errors.push(
        `line ${i + 1}: "${key}" is not a valid variable name (letters, digits, underscore; not starting with a digit)`,
      )
      continue
    }

    const value = parseValue(withoutExport.slice(eq + 1))
    if (key in vars) {
      // Last wins, matching shell behaviour, but say so — a duplicate is
      // usually a mistake.
      errors.push(`line ${i + 1}: "${key}" appears more than once; last wins`)
    }
    vars[key] = value
  }

  return { vars, errors }
}

function parseValue(rest: string): string {
  const trimmed = rest.trim()
  if (trimmed === "") return ""

  const quote = trimmed[0]
  if (quote === '"' || quote === "'") {
    const closing = findClosingQuote(trimmed, quote)
    if (closing === -1) {
      // Unterminated quote: treat the remainder literally rather than losing it.
      return trimmed.slice(1)
    }
    const inner = trimmed.slice(1, closing)
    return quote === '"' ? unescapeDouble(inner) : inner
  }

  // Unquoted: an inline `#` starts a comment.
  const hash = trimmed.indexOf(" #")
  const value = hash === -1 ? trimmed : trimmed.slice(0, hash)
  return value.trim()
}

function findClosingQuote(s: string, quote: string): number {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === "\\" && quote === '"') {
      i++ // skip the escaped char
      continue
    }
    if (s[i] === quote) return i
  }
  return -1
}

function unescapeDouble(s: string): string {
  return s.replace(/\\(.)/g, (_, ch: string) => {
    switch (ch) {
      case "n":
        return "\n"
      case "t":
        return "\t"
      case "r":
        return "\r"
      case "\\":
        return "\\"
      case '"':
        return '"'
      default:
        return `\\${ch}`
    }
  })
}

/** Renders vars back into textarea form, for the edit view. */
export function formatEnvText(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([k, v]) => `${k}=${needsQuoting(v) ? JSON.stringify(v) : v}`)
    .join("\n")
}

function needsQuoting(v: string): boolean {
  return v === "" ? false : /[\s"'#\\]/.test(v)
}
