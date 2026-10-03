import { prescanCompose, type PrescanResult } from "../compose/prescan.ts"
import type { Refusal } from "../compose/types.ts"
import { addResourceEnvVars, resolveEnvKeys } from "../db/queries.ts"
import { placeholderVars } from "../jobs/compose-plan.ts"
import { parseContainerPort } from "./container-port.ts"

/**
 * The checks the create and settings forms share for a Compose file
 * (docs/PHASE-3-PLAN.md §3.2 "form time"): the prescan — pure, milliseconds,
 * no subprocess — so a pasted `privileged: true` is refused on the form. The
 * deploy job runs the whole pipeline, and its validation is the authority.
 */

export interface ComposeFormBody {
  composeFile: string
  publicService?: string
  publicPort?: string
  healthPath?: string
}

export type ComposeFormCheck =
  | {
      ok: true
      scan: PrescanResult
      publicService: string | null
      publicPort: number | null
      healthPath: string | null
    }
  /** The file itself was refused; the draft carries the first refusal. */
  | { ok: false; error: "compose-refused"; refusal: Refusal }
  | { ok: false; error: "compose-public-unknown" | "compose-port-required" }
  /** A port the form's own min/max refuses: a hand-made request. */
  | { ok: false; error: "bad-port" }

export function checkComposeForm(body: ComposeFormBody): ComposeFormCheck {
  const scan = prescanCompose(body.composeFile)
  const first = scan.refusals[0]
  if (first !== undefined) {
    return { ok: false, error: "compose-refused", refusal: first }
  }

  const service = body.publicService?.trim() ?? ""
  if (service === "") {
    // No public service means no route, so a port on its own means nothing.
    return {
      ok: true,
      scan,
      publicService: null,
      publicPort: null,
      healthPath: body.healthPath?.trim() || null,
    }
  }
  if (!scan.services.includes(service)) {
    return { ok: false, error: "compose-public-unknown" }
  }
  const port = parseContainerPort(body.publicPort)
  if (!port.ok) return { ok: false, error: "bad-port" }
  if (port.port === null) return { ok: false, error: "compose-port-required" }
  return {
    ok: true,
    scan,
    publicService: service,
    publicPort: port.port,
    healthPath: body.healthPath?.trim() || null,
  }
}

/**
 * Generates the placeholders the file references that nothing resolves yet
 * (§3.5), and stores them as encrypted resource variables, scope runtime.
 * `route` is given at create only: then SERVICE_FQDN_/SERVICE_URL_ of the
 * public service are filled from the auto domain. Returns how many were made.
 *
 * Never logs a value: the generated secrets go straight to the encrypted
 * column, and from there into the deploy's redaction set.
 */
export function generatePlaceholders(
  resourceId: string,
  scan: PrescanResult,
  route: {
    publicService: string | null
    publicPort: number | null
    autoHost: string | null
  } | null,
): number {
  const resolvable = new Set(resolveEnvKeys(resourceId).map((k) => k.key))
  const vars = placeholderVars(scan.references, resolvable, route)
  addResourceEnvVars(
    resourceId,
    vars.map((v) => ({ key: v.key, value: v.value, scope: "runtime" })),
  )
  return vars.length
}
