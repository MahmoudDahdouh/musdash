import { expect, test } from "bun:test"
import { type LayoutData, type NavSection, renderPage } from "./render.ts"

/**
 * The sidebar is Home, Projects and Settings and nothing else (D69, D70):
 * exactly one link is marked current, and it is the right one. Every <use>
 * must also name a symbol the sprite defines, or an icon renders empty.
 */
function render(section: NavSection | undefined, activeProjectId?: string) {
  const layout: LayoutData = {
    title: "t",
    user: { email: "a@example.test" },
    csrf: "c",
    section,
    activeProjectId,
  }
  return renderPage("status", { status: 404 }, layout)
}

function sidebar(html: string): string {
  const start = html.indexOf('<nav\n          class="sidebar-nav"')
  return html.slice(start, html.indexOf("</nav>", start))
}

function current(html: string): string[] {
  return [
    ...sidebar(html).matchAll(
      /<a[^>]*href="([^"]+)"[^>]*aria-current="(\w+)"/g,
    ),
  ].map((m) => `${m[1]} ${m[2]}`)
}

test("the sidebar holds exactly the three places", () => {
  const links = [
    ...sidebar(render("home")).matchAll(/<a[^>]*href="([^"]+)"/g),
  ].map((m) => m[1])
  expect(links).toEqual(["/", "/projects", "/settings"])
})

test("one current link per place", () => {
  expect(current(render("home"))).toEqual(["/ page"])
  expect(current(render("projects"))).toEqual(["/projects page"])
  expect(current(render("settings"))).toEqual(["/settings page"])
  // Inside a project, Projects is current but is not the page itself.
  expect(current(render("projects", "p1"))).toEqual(["/projects true"])
})

test("every icon reference resolves to a symbol in the sprite", () => {
  const html = render("home")
  const symbols = new Set(
    [...html.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]),
  )
  const uses = [...html.matchAll(/<use href="#([^"]+)"/g)].map((m) => m[1])
  expect(uses.length).toBeGreaterThan(0)
  for (const id of uses) expect(symbols.has(id)).toBe(true)
})
