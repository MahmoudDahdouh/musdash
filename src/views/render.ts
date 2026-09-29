import { Eta } from "eta"
import type { ResourceState } from "../events.ts"
import type { ActiveDeployment } from "../db/queries.ts"

// Templates and assets are imported statically as text, NOT read from disk at
// render time.
//
// `bun build --compile` embeds statically imported assets and drops anything
// resolved at runtime. Eta's default file loader would work perfectly under
// `bun run dev` and then 500 on every page in the shipped binary, because
// src/views/ does not exist inside it. Same for public/. This is trap 6, and it
// is invisible until someone runs the release artifact.
import forbiddenSrc from "./forbidden.eta" with { type: "text" }
import layoutSrc from "./layout.eta" with { type: "text" }
import deploymentSrc from "./pages/deployment.eta" with { type: "text" }
import loginSrc from "./pages/login.eta" with { type: "text" }
import projectSrc from "./pages/project.eta" with { type: "text" }
import projectsSrc from "./pages/projects.eta" with { type: "text" }
import resourceSrc from "./pages/resource.eta" with { type: "text" }
import settingsSrc from "./pages/settings.eta" with { type: "text" }
import setupSrc from "./pages/setup.eta" with { type: "text" }
import statusSrc from "./pages/status.eta" with { type: "text" }
import deployImagePartialSrc from "./partials/deploy-image.eta" with { type: "text" }
import errorsPartialSrc from "./partials/errors.eta" with { type: "text" }
import statusPartialSrc from "./partials/status.eta" with { type: "text" }
import appCss from "../../public/app.css" with { type: "text" }
import appJs from "../../public/app.js" with { type: "text" }
import alpineJs from "../../public/alpine.js" with { type: "text" }
// Inlined by `bun build --compile` like the imports above, so the binary
// reports the version it was built from, not whatever package.json says later.
import { version as musdashVersion } from "../../package.json"

const eta = new Eta({ autoEscape: true, cache: true })
// Registered by name so pages can `include("@status", …)`. An "@" name never
// reaches Eta's file loader, which is what keeps it working in the binary.
eta.loadTemplate("@status", statusPartialSrc)
eta.loadTemplate("@errors", errorsPartialSrc)
eta.loadTemplate("@deploy-image", deployImagePartialSrc)

const PAGES = {
  setup: setupSrc,
  login: loginSrc,
  projects: projectsSrc,
  project: projectSrc,
  resource: resourceSrc,
  deployment: deploymentSrc,
  settings: settingsSrc,
  status: statusSrc,
} as const

export type PageName = keyof typeof PAGES

export const assets = {
  "app.css": { body: appCss, type: "text/css; charset=utf-8" },
  // Alpine and our own behaviours are served as one file so a page makes a
  // single request and there is no ordering hazard.
  "alpine.js": {
    body: `${alpineJs}\n;${appJs}`,
    type: "text/javascript; charset=utf-8",
  },
} as const

export interface NavEnvironment {
  id: string
  name: string
  /** The worst state among its resources; null when it has none. */
  state: ResourceState | null
}

/**
 * Structurally identical to the data layer's NavProject, but declared here so
 * the view layer keeps its independence from src/db — render.ts imports
 * nothing from there today, and the shapes stay assignable without a cast.
 */
export interface NavProjectView {
  id: string
  name: string
  environments: NavEnvironment[]
}

export interface LayoutData {
  title: string
  user?: { email: string } | null
  csrf?: string
  flash?: { kind: "ok" | "error"; text: string } | null
  /** Shown as an error notice, over `flash`. Words for it live in @errors. */
  errorKey?: string | null
  wide?: boolean
  nav?: NavProjectView[]
  activeProjectId?: string
  activeEnvironmentId?: string
  /** Highlights the sidebar's Settings link. */
  activeSettings?: boolean
  /** This process's resident memory in MiB. Set only for a signed-in render. */
  rssMb?: number
  /** Queued and running deployments, for the activity toast. */
  active?: ActiveDeployment[]
}

export function renderPage(
  page: PageName,
  data: Record<string, unknown>,
  layout: LayoutData,
): string {
  const body = eta.renderString(PAGES[page], data)
  // An unknown key renders nothing, so it falls through to the ordinary flash.
  const errorText = layout.errorKey
    ? eta.render("@errors", { key: layout.errorKey }).trim()
    : ""
  return eta.renderString(layoutSrc, {
    ...layout,
    user: layout.user ?? null,
    csrf: layout.csrf ?? "",
    flash: errorText
      ? { kind: "error", text: errorText }
      : (layout.flash ?? null),
    wide: layout.wide ?? false,
    nav: layout.nav ?? [],
    active: layout.active ?? [],
    // Empty string rather than undefined: an id comparison in the template can
    // then never accidentally match a missing value.
    activeProjectId: layout.activeProjectId ?? "",
    activeEnvironmentId: layout.activeEnvironmentId ?? "",
    activeSettings: layout.activeSettings ?? false,
    version: musdashVersion,
    assetUrl,
    body,
  })
}

/**
 * The page a public peer gets on the dashboard port (D31). A whole document
 * with its styles inline, because that peer is refused /assets as well.
 */
export function renderForbidden(): string {
  return eta.renderString(forbiddenSrc, {})
}

/**
 * Each asset's version: the start of its content's SHA-256, computed once.
 *
 * In the URL so that a release that changes an asset is a new URL. At a fixed
 * URL cached for an hour, an upgrade left the browser running the old script
 * against the new pages until the entry expired (R-1).
 */
const ASSET_VERSIONS = Object.fromEntries(
  Object.entries(assets).map(([name, asset]) => [
    name,
    new Bun.CryptoHasher("sha256")
      .update(asset.body)
      .digest("hex")
      .slice(0, 12),
  ]),
) as Record<keyof typeof assets, string>

/** Where a page links to an asset. */
export function assetUrl(name: keyof typeof assets): string {
  return `/assets/${name}?v=${ASSET_VERSIONS[name]}`
}

/**
 * Serves an embedded asset, or null when the name is not one.
 *
 * Lives here rather than in the entry point because the asset table is this
 * module's, and src/index.ts wires modules together rather than holding route
 * bodies. Returning null instead of a 404 keeps the HTTP shape at the caller.
 *
 * The current version may be cached for good: its URL changes with its
 * content. Anything else — no version, or a page from before an upgrade asking
 * for the old one — gets today's body and must be revalidated, so a stale page
 * cannot pin a stale script.
 */
export function assetResponse(
  name: string,
  version: string | undefined,
): Response | null {
  if (!Object.hasOwn(assets, name)) return null
  const key = name as keyof typeof assets
  const current = version === ASSET_VERSIONS[key]
  return new Response(assets[key].body, {
    headers: {
      "content-type": assets[key].type,
      "cache-control": current
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    },
  })
}
