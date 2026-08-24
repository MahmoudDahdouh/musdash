import {
  clearGitLinkage,
  deleteGithubApp,
  deleteInstallation,
  getGithubApp,
  insertGithubApp,
  listGithubInstallations,
  upsertInstallation,
} from "../db/queries.ts"
import { logger } from "../log.ts"
import { ghJson } from "./api.ts"
import { listInstallations } from "./repos.ts"

/**
 * The second half of the manifest flow: code in, credentials out.
 *
 * NOTHING in this file may log a credential, and the usual backstop does not
 * apply here. redactGithub() (log.ts:38-39) matches `gh*_` tokens, codeload
 * URLs and PEM headers — it does not match `client_secret` or `webhook_secret`,
 * which are plain hex-ish strings. A careless log line here prints them
 * verbatim, so the rule is that the converted object never reaches a logger
 * argument at all, not even as a field count.
 */

export interface ConvertedApp {
  appId: number
  slug: string
  clientId: string
  clientSecret: string
  privateKey: string
  webhookSecret: string
}

/** GitHub's field names, which are not ours. Mapped, never spread. */
interface ConversionResponse {
  id: number
  slug: string
  client_id: string
  client_secret: string
  pem: string
  webhook_secret: string
}

/**
 * Exchanges a manifest code for the App's credentials.
 *
 * Auth is {kind:"none"} — the code IS the credential, and it is single-use and
 * expires within the hour. There is no App yet to authenticate as, which is the
 * whole point of this endpoint.
 */
export async function convertManifestCode(code: string): Promise<ConvertedApp> {
  const body = await ghJson<ConversionResponse>(
    `/app-manifests/${encodeURIComponent(code)}/conversions`,
    { kind: "none" },
    { method: "POST" },
  )

  // Mapped field by field rather than spread. A spread would carry GitHub's
  // snake_case keys into a shape typed as camelCase, so `privateKey` would be
  // undefined and every later JWT signature would fail with "Bad credentials"
  // — far from here, and with nothing pointing back at this line.
  return {
    appId: body.id,
    slug: body.slug,
    clientId: body.client_id,
    clientSecret: body.client_secret,
    privateKey: body.pem,
    webhookSecret: body.webhook_secret,
  }
}

/**
 * Reconciles local installations against GitHub's list. Returns the count.
 *
 * RECONCILES rather than merely upserts, and that difference is the point.
 * The `installation` webhook is the only other deleter, so a delivery that was
 * missed, unverified, or never arrived leaves a PHANTOM installation behind
 * forever: it shows in Settings and the account picker, and minting a token for
 * it 404s at deploy time. Since webhook delivery is not yet verified against
 * real GitHub, that is the expected state rather than an edge case — and "Sync
 * installations" is precisely the button the UI points the user at to fix it.
 * An upsert-only sync cannot fix it, which made the button a placebo.
 *
 * Called after registration and from that button — the "Install" step happens
 * on github.com, and nothing tells mosdash about it except the webhook.
 *
 * `appRowId` is the App's ULID row id from getGithubApp(); `installationId` is
 * GitHub's integer. They are different values and only the second one mints a
 * token.
 */
export async function syncInstallations(): Promise<number> {
  const app = getGithubApp()
  if (!app) return 0

  // Throws on an API failure rather than returning an empty list, which is what
  // makes the removal below safe: a transient 500 or a timeout propagates to
  // the caller and no local row is touched. Only an authoritative, successful
  // answer from GitHub can delete anything.
  const installations = await listInstallations()

  for (const installation of installations) {
    upsertInstallation({
      appRowId: app.id,
      installationId: installation.installationId,
      accountLogin: installation.accountLogin,
    })
  }

  const live = new Set(installations.map((i) => i.installationId))
  let removed = 0
  for (const local of listGithubInstallations()) {
    if (live.has(local.installationId)) continue

    // Unlink before deleting, for the same reason the disconnect path does it:
    // there is no foreign key from resources.git_installation_id
    // (0002_github.sql:37), so deleting the row alone would leave resources
    // holding an id that resolves to nothing. That does not fail here — it
    // fails as a 404 from GitHub at the next deploy, long after the uninstall
    // that caused it. Clearing it surfaces as "no installation selected" in the
    // UI, which is a state the user can act on.
    //
    // The column holds GitHub's integer as a decimal string.
    const unlinked = clearGitLinkage(String(local.installationId))
    deleteInstallation(local.installationId)
    removed++
    logger.info(
      { installationId: local.installationId, unlinked },
      "removed an installation GitHub no longer reports",
    )
  }

  logger.info(
    { count: installations.length, removed },
    "synced GitHub installations",
  )
  return installations.length
}

/**
 * Stores a converted App, replacing one already registered.
 *
 * insertGithubApp throws rather than overwriting, because a second App would
 * orphan every installation whose app_id points at the first. Re-registering is
 * a legitimate thing to do — a user who deleted the App on GitHub's side has no
 * other way back — so that refusal is handled here instead of reaching the 500
 * handler as "a GitHub App is already registered".
 *
 * The caller is responsible for clearTokenCache(): tokens are cached by
 * installation id, and a new App mints tokens that the old cache would shadow
 * for up to an hour. It lives at the call site rather than here so that
 * disconnect, which does not insert anything, cannot forget it by a different
 * route.
 */
export function replaceGithubApp(converted: ConvertedApp): void {
  const existing = getGithubApp()
  if (existing) {
    deleteGithubApp(existing.id)
    logger.info({ appId: existing.appId }, "replaced the registered GitHub App")
  }
  insertGithubApp(converted)
}
