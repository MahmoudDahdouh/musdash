import { bindHostname, config } from "./config.ts"
import { getSetting } from "./db/queries.ts"
import { restartBlockedReason, restartCapability } from "./restart.ts"
import {
  type DashboardCheck,
  getAppliedHost,
  getDashboardCheck,
  getDashboardHost,
  SETTING_DASHBOARD_HOST,
} from "./settings.ts"

export interface DashboardHostView {
  host: string | undefined
  source: "database" | "environment" | "unset"
  /** The env var is set but a database row overrides it. */
  envHostShadowed: boolean
  /** Saved but not yet pushed to Caddy — normally true for about a second. */
  applyPending: boolean
  bindAddress: string
  check: DashboardCheck | null
  restart: {
    available: boolean
    blockedReason: string | null
    command: string
  }
}

/**
 * The Settings page's dashboard-address data.
 *
 * A sibling of the GitHub view model rather than an extension of it: that shape
 * carries the rule about never spreading the github_apps row, and nothing here
 * should ever be able to touch it.
 */
export function dashboardHostView(): DashboardHostView {
  const row = getSetting(SETTING_DASHBOARD_HOST)
  const host = getDashboardHost()
  const source =
    row !== undefined && row !== ""
      ? "database"
      : host !== undefined
        ? "environment"
        : "unset"

  return {
    host,
    source,
    envHostShadowed: config.dashboardHost !== undefined && row !== undefined,
    applyPending: host !== getAppliedHost(),
    bindAddress: `${bindHostname()}:${config.port}`,
    check: getDashboardCheck(),
    restart: {
      available: restartCapability() === "systemd",
      blockedReason: restartBlockedReason(),
      command: "systemctl restart musdash",
    },
  }
}
