import { describe, expect, test } from "bun:test"
import { assetResponse, assets, assetUrl, renderPage } from "./render.ts"

/**
 * The dashboard's script and stylesheet change with every release that touches
 * them, and were served at a fixed URL cached for an hour. After an upgrade the
 * browser ran the old script against the new pages — the 1GB re-test's P-4 fix
 * looked broken until the cache entry was refreshed by hand (R-1). A versioned
 * URL makes a new release a new URL; these pin that down.
 */

const sha = (body: string) =>
  new Bun.CryptoHasher("sha256").update(body).digest("hex")

describe("asset URLs", () => {
  test("carry a version taken from the asset's content", () => {
    for (const name of Object.keys(assets) as (keyof typeof assets)[]) {
      const url = assetUrl(name)
      const v = new URL(url, "http://x").searchParams.get("v") ?? ""
      expect(url.startsWith(`/assets/${name}?v=`)).toBe(true)
      expect(v.length).toBeGreaterThanOrEqual(8)
      expect(sha(assets[name].body).startsWith(v)).toBe(true)
    }
  })

  test("are the ones every page links to", () => {
    const html = renderPage("login", { csrf: "", error: null }, { title: "t" })
    expect(html).toContain(`href="${assetUrl("app.css")}"`)
    expect(html).toContain(`src="${assetUrl("alpine.js")}"`)
  })
})

describe("assetResponse", () => {
  const v = (name: keyof typeof assets) =>
    new URL(assetUrl(name), "http://x").searchParams.get("v") ?? undefined

  test("a request for the current version may be cached for good", () => {
    const res = assetResponse("alpine.js", v("alpine.js"))
    expect(res?.headers.get("cache-control")).toContain("immutable")
  })

  test("an unversioned or outdated request is never served from cache", () => {
    for (const version of [undefined, "0123456789"]) {
      const res = assetResponse("alpine.js", version)
      expect(res?.status).toBe(200)
      expect(res?.headers.get("cache-control")).toBe("no-cache")
    }
  })

  test("an unknown name is not an asset, prototype keys included", () => {
    for (const name of ["nope.js", "constructor", "toString", "__proto__"]) {
      expect(assetResponse(name, undefined)).toBeNull()
    }
  })
})
