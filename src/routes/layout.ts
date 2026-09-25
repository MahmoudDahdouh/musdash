import type { SessionUser } from "../auth.ts"
import { navTree } from "../db/queries.ts"
import { statusPage } from "../http.ts"
import type { LayoutData } from "../views/render.ts"
import type { ErrorKey } from "./errors.ts"

/**
 * The signed-in page frame, shared by every router that renders one.
 *
 * Its own module so routes/auth.ts can render a signed-in status page without
 * importing routes/app.ts. Depends only downward (http.ts → views/render.ts),
 * so nothing here can close an import cycle back into the routers.
 */

export interface LayoutOptions {
  activeProjectId?: string
  activeEnvironmentId?: string
  activeSettings?: boolean
  wide?: boolean
  /** A key from a refused form's redirect; the layout shows its sentence. */
  errorKey?: ErrorKey | null
}

export function layout(
  session: SessionUser | null,
  title: string,
  options: LayoutOptions = {},
): LayoutData {
  return {
    title,
    user: session ? { email: session.email } : null,
    csrf: session?.csrfToken ?? "",
    // Built per request and never retained — see navTree()'s comment. Guarded
    // on the session because the layout only draws the sidebar for a signed-in
    // user, so an anonymous render would query for nothing.
    nav: session ? navTree() : [],
    activeProjectId: options.activeProjectId,
    activeEnvironmentId: options.activeEnvironmentId,
    activeSettings: options.activeSettings,
    wide: options.wide,
    errorKey: options.errorKey ?? null,
    // Read fresh on every render and never stored: the sidebar instrument is a
    // spot reading, and a cached one would report a number that is not true.
    // MiB, the unit scripts/measure-rss.ts gates on, so the two never disagree.
    rssMb: session
      ? Math.round(process.memoryUsage.rss() / 1048576)
      : undefined,
  }
}

/**
 * A status page inside the signed-in frame, with the sidebar and a way back.
 *
 * For refusals a user cannot fix from the form they came from: a missing id, a
 * hand-made or stale request, an expired CSRF token. The words are in
 * pages/status.eta. The layout's logout form carries the session's CURRENT
 * token; nothing the request submitted is rendered.
 */
export function statusFor(
  session: SessionUser | null,
  status: 400 | 403 | 404,
): Response {
  return statusPage(status, {}, layout(session, String(status)))
}
