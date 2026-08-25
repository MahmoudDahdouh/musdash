import { config } from "../config.ts"
import {
  countLinkedGitResources,
  getGithubApp,
  listGithubInstallations,
} from "../db/queries.ts"

/**
 * The data the Settings page renders.
 *
 * Lives here rather than in the route so the rendering handler — which belongs
 * to the UI-Builder — imports a shape instead of reassembling one. The critical
 * part is what is NOT here.
 */

export interface SettingsGithubApp {
  slug: string
  appId: number
}

export interface SettingsInstallation {
  /** This table's ULID row id. */
  id: string
  /** GitHub's integer. The only one that mints a token. */
  installationId: number
  accountLogin: string
}

export interface SettingsView {
  csrf: string
  /** undefined renders the "set MUSDASH_PUBLIC_URL" warning. */
  publicUrl: string | undefined
  app: SettingsGithubApp | null
  installations: SettingsInstallation[]
  linkedResourceCount: number
  flash: { kind: "ok" | "error"; text: string } | null
}

/**
 * Turns `?flash=ok&msg=...` into a flash, or null.
 *
 * The core handlers redirect with those two params (see flashUrl in
 * routes/app.ts), matching the envError convention rather than adding a
 * server-side flash store. Anything other than "ok" or "error" is dropped: the
 * value reaches a CSS class name in the template.
 */
export function flashFromQuery(
  flash: unknown,
  msg: unknown,
): { kind: "ok" | "error"; text: string } | null {
  if (flash !== "ok" && flash !== "error") return null
  const text = typeof msg === "string" ? msg : ""
  return text ? { kind: flash, text } : null
}

export function settingsViewModel(args: {
  csrf: string
  flash?: { kind: "ok" | "error"; text: string } | null
}): SettingsView {
  const row = getGithubApp()

  return {
    csrf: args.csrf,
    publicUrl: config.publicUrl,
    // Built field by field, NEVER spread. The row carries clientSecretEnc,
    // privateKeyEnc and webhookSecretEnc; a spread would hand three ciphertext
    // buffers to a template and render them into the page. They are encrypted,
    // but publishing ciphertext is still handing an attacker the thing they
    // need the key for.
    app: row ? { slug: row.slug, appId: row.appId } : null,
    installations: listGithubInstallations().map((i) => ({
      id: i.id,
      installationId: i.installationId,
      accountLogin: i.accountLogin,
    })),
    linkedResourceCount: countLinkedGitResources(),
    flash: args.flash ?? null,
  }
}
