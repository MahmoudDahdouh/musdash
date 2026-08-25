/**
 * Expands `${VAR}` references after the three levels have merged.
 *
 * Deliberate behaviours, each of which has a test:
 *   - ONE pass, no recursion. If `A=${B}` and `B=${C}`, `A` becomes the literal
 *     text of B, which is `"${C}"`. Recursion would need cycle detection, and a
 *     cycle is a user error that would otherwise hang the deploy worker — job
 *     concurrency is exactly 1, so a hang is a total outage rather than one
 *     slow deploy.
 *   - References read the INPUT map, never the partially built output, so the
 *     result does not depend on key iteration order.
 *   - An unresolvable `${VAR}` throws. Substituting `""` is how a container
 *     boots with `DATABASE_URL=postgres://user:@/` and corrupts data quietly;
 *     failing the deploy is loud and reversible.
 *   - `$$` yields a literal `$`, so `$${HOME}` produces the seven characters
 *     `${HOME}`. NOT backslash: `parseEnvText` runs first and `unescapeDouble`
 *     consumes a backslash inside a double-quoted value, so `\${FOO}` reaches
 *     us as a bare `${FOO}` and is indistinguishable from a real reference.
 *     `$$` survives every quoting form the parser accepts.
 *   - A bare `$` not followed by `{` or `$` is literal, so `pa$word` is
 *     untouched.
 *   - A self-reference throws rather than producing a doubled value. See
 *     EnvSelfReferenceError.
 */

/** Thrown when a value references a name defined at no level. */
export class EnvInterpolationError extends Error {
  override readonly name = "EnvInterpolationError"

  constructor(
    readonly key: string,
    readonly missing: string,
  ) {
    // Names only, never values: this message reaches the deploy log.
    super(
      `${key} references \${${missing}}, which is not defined at any level ` +
        `(project, environment or resource). Define it, or write ` +
        `$$\{${missing}} for a literal.`,
    )
  }
}

/**
 * Thrown when a value references itself.
 *
 * Worth its own error because the shell habit `PATH=$PATH:/x` is exactly the
 * thing people type, and here it cannot mean what they intend: there is no
 * outer environment to inherit from, so the name resolves to its own literal
 * text and yields a doubled value like `${PATH}:/x:/x`. Silently shipping that
 * is worse than refusing it.
 */
export class EnvSelfReferenceError extends Error {
  override readonly name = "EnvSelfReferenceError"

  constructor(readonly key: string) {
    super(
      `${key} references itself. There is no inherited value to extend — ` +
        `set the full value, or reference a different variable.`,
    )
  }
}

/** `$$` (the escape) or `${NAME}`. Nothing else is special. */
const REF_RE = /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

export function interpolate(
  vars: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(vars)) {
    out[key] = raw.replace(REF_RE, (_match, name?: string) => {
      if (name === undefined) return "$" // the $$ escape
      if (name === key) throw new EnvSelfReferenceError(key)
      // Read from `vars`, not `out`. Reading the partially built output would
      // make a value resolve differently depending on which keys happened to
      // be processed first, so an unrelated edit could change an unrelated
      // variable.
      const value = vars[name]
      if (value === undefined) throw new EnvInterpolationError(key, name)
      return value
    })
  }
  return out
}
