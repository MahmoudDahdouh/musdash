import { Eta } from "eta"

// Templates and assets are imported statically as text, NOT read from disk at
// render time.
//
// `bun build --compile` embeds statically imported assets and drops anything
// resolved at runtime. Eta's default file loader would work perfectly under
// `bun run dev` and then 500 on every page in the shipped binary, because
// src/views/ does not exist inside it. Same for public/. This is trap 6, and it
// is invisible until someone runs the release artifact.
import layoutSrc from "./layout.eta" with { type: "text" }
import deploymentSrc from "./pages/deployment.eta" with { type: "text" }
import loginSrc from "./pages/login.eta" with { type: "text" }
import projectSrc from "./pages/project.eta" with { type: "text" }
import projectsSrc from "./pages/projects.eta" with { type: "text" }
import resourceSrc from "./pages/resource.eta" with { type: "text" }
import setupSrc from "./pages/setup.eta" with { type: "text" }
import appCss from "../../public/app.css" with { type: "text" }
import appJs from "../../public/app.js" with { type: "text" }
import alpineJs from "../../public/alpine.js" with { type: "text" }

const eta = new Eta({ autoEscape: true, cache: true })

const PAGES = {
  setup: setupSrc,
  login: loginSrc,
  projects: projectsSrc,
  project: projectSrc,
  resource: resourceSrc,
  deployment: deploymentSrc,
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

export interface LayoutData {
  title: string
  user?: { email: string } | null
  csrf?: string
  flash?: { kind: "ok" | "error"; text: string } | null
  wide?: boolean
}

export function renderPage(
  page: PageName,
  data: Record<string, unknown>,
  layout: LayoutData,
): string {
  const body = eta.renderString(PAGES[page], data)
  return eta.renderString(layoutSrc, {
    ...layout,
    user: layout.user ?? null,
    csrf: layout.csrf ?? "",
    flash: layout.flash ?? null,
    wide: layout.wide ?? false,
    body,
  })
}
