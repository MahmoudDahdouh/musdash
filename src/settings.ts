import { config } from "./config.ts"
import { deleteSetting, getSetting, setSetting } from "./db/queries.ts"

/**
 * Operator settings that live in the database rather than the environment.
 *
 * The `settings` table is a key/value store, so the keys are the vocabulary and
 * they belong in one place. They were module-private strings until a second key
 * appeared, which is the point at which two modules inventing their own strings
 * becomes a collision waiting to happen. This module owns the names, the typed
 * accessors, and nothing else — `src/db/queries.ts` owns SQL, not vocabulary.
 *
 * The Settings page view model lives in settings-view.ts rather than here: it
 * needs restart.ts, which reaches the reconciler, which reaches the Caddy
 * bootstrap, which reads a setting. Keeping this module free of that chain
 * keeps it importable from anywhere.
 */

/** The dashboard's own hostname. Shadows MUSDASH_DASHBOARD_HOST when present. */
export const SETTING_DASHBOARD_HOST = "dashboard_host"

/** The last hostname the apply job successfully pushed to Caddy. */
export const SETTING_DASHBOARD_HOST_APPLIED = "dashboard_host_applied"

/** JSON: the DNS and reachability probe results from the last apply. */
export const SETTING_DASHBOARD_CHECK = "dashboard_check"

/** The manifest-flow nonce, held here so a restart cannot strand it. */
export const SETTING_GITHUB_MANIFEST_STATE = "github_manifest_state"

/**
 * The dashboard hostname, database first.
 *
 * Precedence is deliberate. Env-wins would make this feature a no-op for every
 * existing install, since they all already carry the value in musdash.env.
 * Seeding the row from the env at first boot would instead make "clear the
 * hostname" impossible — the next boot re-seeds it from a line the operator
 * cannot edit from the UI. Read-through has neither problem, and "explicitly
 * none" is expressed by deleting the row.
 */
export function getDashboardHost(): string | undefined {
  const row = getSetting(SETTING_DASHBOARD_HOST)
  if (row !== undefined) return row === "" ? undefined : row
  return config.dashboardHost
}

export function setDashboardHost(host: string): void {
  setSetting(SETTING_DASHBOARD_HOST, host.toLowerCase())
}

/**
 * Where this instance is reachable from the public internet.
 *
 * Derived, not configured. It is by definition `https://` + the dashboard's own
 * hostname: GitHub's registration callback and webhooks have to arrive at this
 * dashboard, and the dashboard is served at that name. Asking the operator to
 * set the same domain twice — once bare for the Caddy matcher, once with a
 * scheme for GitHub — is two chances to get it wrong for no information gained,
 * and getting it wrong fails silently.
 *
 * Derivation wins over MUSDASH_PUBLIC_URL rather than the reverse. Env-wins
 * would leave every existing install carrying a value that goes stale the
 * moment the domain is changed from the Settings page, which is the same
 * silent-breakage this derivation exists to remove. The env var survives as the
 * fallback for the case derivation cannot express: something else fronting
 * musdash on a different name — a tunnel, an external load balancer — where no
 * dashboard host is set at all.
 */
export function getPublicUrl(): string | undefined {
  const host = getDashboardHost()
  if (host !== undefined) return `https://${host}`
  return config.publicUrl
}

/**
 * Reverts to the catch-all-only route.
 *
 * Deletion rather than an empty string: an absent row falls through to the
 * environment, which is what an install that never used this page expects. An
 * operator who clears the field from the UI wants the env value ignored too, so
 * the handler writes an empty row instead of calling this — see clearing in
 * routes/app.ts. This exists for tests and for a future reset action.
 */
export function forgetDashboardHost(): void {
  deleteSetting(SETTING_DASHBOARD_HOST)
}

export function getAppliedHost(): string | undefined {
  const row = getSetting(SETTING_DASHBOARD_HOST_APPLIED)
  return row === "" ? undefined : row
}

export function setAppliedHost(host: string | undefined): void {
  setSetting(SETTING_DASHBOARD_HOST_APPLIED, host ?? "")
}

/** What the apply job learned about DNS and about Caddy's path to the dashboard. */
export interface DashboardCheck {
  /** "ok" when an A/AAAA record points at one of this box's addresses. */
  dns: "ok" | "mismatch" | "unresolved" | "skipped"
  resolved: string[]
  local: string[]
  /** Whether a request through Caddy reached this process. */
  reachable: boolean
  /** Why not, when it did not. */
  reachError?: string
  at: string
}

export function getDashboardCheck(): DashboardCheck | null {
  const raw = getSetting(SETTING_DASHBOARD_CHECK)
  if (!raw) return null
  try {
    return JSON.parse(raw) as DashboardCheck
  } catch {
    // A malformed row is a rendering hazard, not a reason to fail the page.
    return null
  }
}

export function setDashboardCheck(check: DashboardCheck): void {
  setSetting(SETTING_DASHBOARD_CHECK, JSON.stringify(check))
}
