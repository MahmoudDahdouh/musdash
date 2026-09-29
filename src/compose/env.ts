import type { Reference } from "./types.ts"

/**
 * Stage B of the Compose pipeline (docs/PHASE-3-PLAN.md §3.2, §3.5): the
 * environment `docker compose config` interpolates the file with.
 *
 * Resolved variables are the file's interpolation environment, not something
 * injected into every service — a service gets what the file gives it, so a
 * secret reaches only the services that name it. And only the variables the
 * file REFERENCES are passed at all (`${X}`, `$X`, a pass-through
 * `environment: [X]`, a secret's `environment: X`): anything else would sit
 * in the `config` process's environment for no reason, where the CLI or a
 * library it loads may read it.
 *
 * Keys that steer that process are withheld even when referenced (D65 items 9
 * and 14):
 *   - `COMPOSE_*`, `DOCKER_*`, `BUILDKIT_*`: `COMPOSE_FILE` can redirect
 *     Compose and `DOCKER_HOST` point it at another daemon;
 *   - `PATH`, `HOME`, `TMPDIR`, `XDG_*`: where binaries, plugins, config and
 *     scratch files are looked up;
 *   - `LD_*`: /usr/bin/docker is dynamically linked, so `LD_PRELOAD` is code
 *     execution as root;
 *   - `GODEBUG`, `GOTRACEBACK`, `GOMAXPROCS`, `GOFLAGS`: the Go runtime's own
 *     switches (the Compose plugin is Go);
 *   - `SSL_CERT_FILE`, `SSL_CERT_DIR` and every `*_PROXY` in either case:
 *     who the registry connection trusts, and where it goes.
 *
 * The caller logs each dropped NAME; this module never sees a logger, and
 * never returns a value outside `env`.
 *
 * Pure.
 */

export const RESERVED_ENV =
  /^(?:PATH|HOME|TMPDIR|GODEBUG|GOTRACEBACK|GOMAXPROCS|GOFLAGS|SSL_CERT_FILE|SSL_CERT_DIR|(?:COMPOSE|DOCKER|BUILDKIT|LD|XDG)_.*|.*_[Pp][Rr][Oo][Xx][Yy])$/

export function interpolationEnv(
  resolved: Readonly<Record<string, string>>,
  references: readonly Reference[],
): {
  /** The referenced, resolved, non-reserved variables. */
  env: Record<string, string>
  /** Referenced with no default and not in `env`, sorted. */
  missing: string[]
  /** Referenced and set, but withheld because reserved, sorted. */
  dropped: string[]
} {
  const kept: [string, string][] = []
  const dropped = new Set<string>()
  const missing = new Set<string>()
  for (const ref of references) {
    const value = Object.hasOwn(resolved, ref.name)
      ? resolved[ref.name]
      : undefined
    const reserved = RESERVED_ENV.test(ref.name)
    if (value !== undefined && reserved) dropped.add(ref.name)
    if (value !== undefined && !reserved) {
      kept.push([ref.name, value])
    } else if (!ref.hasDefault) {
      // A reference Compose would fill with a blank (D65 item 3) fails the
      // deploy by name instead (D13). A dropped key counts as unset, because
      // it is: the user's value never reaches Compose.
      missing.add(ref.name)
    }
  }
  return {
    // fromEntries defines own properties, so even a key named `__proto__`
    // survives rather than silently becoming a prototype assignment.
    env: Object.fromEntries(kept),
    missing: [...missing].sort(byCodeUnit),
    dropped: [...dropped].sort(byCodeUnit),
  }
}

/** Plain code-unit order: the same on every host, unlike a locale compare. */
function byCodeUnit(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}
