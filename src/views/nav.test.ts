import { expect, test } from "bun:test"
import { type LayoutData, type NavSection, renderPage } from "./render.ts"

/**
 * The sidebar's three places (D69): exactly one link says aria-current="page",
 * and it is the right one. Inside a project the tree's own link is current, so
 * the Projects link is highlighted but not "the page". Every <use> must also
 * name a symbol the sprite defines, or an icon silently renders empty.
 */
const nav = [{ id: "p1", name: "Shop", environments: [] }]

function render(section: NavSection | undefined, activeProjectId?: string) {
  const layout: LayoutData = {
    title: "t",
    user: { email: "a@example.test" },
    csrf: "c",
    nav,
    section,
    activeProjectId,
  }
  return renderPage("status", { status: 404 }, layout)
}

function currentPages(html: string): string[] {
  return [
    ...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*aria-current="page"/g),
  ].map((m) => m[1] as string)
}

test("one current link per place", () => {
  expect(currentPages(render("home"))).toEqual(["/"])
  expect(currentPages(render("projects"))).toEqual(["/projects"])
  expect(currentPages(render("settings"))).toEqual(["/settings"])
})

test("inside a project, the project is current rather than the Projects page", () => {
  const html = render("projects", "p1")
  expect(currentPages(html)).toEqual([])
  expect(html).toMatch(/href="\/p\/p1"\s+aria-current="true"/)
  expect(html).toMatch(/class="nav-top active"\s+href="\/projects"/)
})

test("every icon reference resolves to a symbol in the sprite", () => {
  const html = render("home")
  const symbols = new Set(
    [...html.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]),
  )
  const uses = [...html.matchAll(/<use href="#([^"]+)"/g)].map((m) => m[1])
  expect(uses.length).toBeGreaterThan(0)
  for (const id of uses) expect(symbols.has(id)).toBe(true)
  for (const id of ["i-home", "i-folder", "i-settings"]) {
    expect(symbols.has(id)).toBe(true)
  }
})
