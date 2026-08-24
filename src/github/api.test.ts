import { describe, expect, test } from "bun:test"
import { ghPaginate, GitHubError, sanitizePath } from "./api.ts"
import { isValidGitRef, isValidRepoRef } from "./repos.ts"

/**
 * Pagination against a real local server rather than a mocked fetch: the Link
 * header parsing is the part that breaks, and a mock that returns what the
 * parser expects proves nothing.
 */

describe("ghPaginate", () => {
  test("follows rel=next to the last page and unwraps an envelope", async () => {
    // /installation/repositories wraps its items in { total_count,
    // repositories } rather than returning a bare array. Accumulating the body
    // itself would yield envelopes, not repositories.
    //
    // The base URL is captured after the server binds: referencing server.port
    // inside its own fetch handler makes the binding self-referential.
    let base = ""
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req): Response {
        const page = new URL(req.url).searchParams.get("page") ?? "1"
        if (page === "1") {
          return Response.json(
            { total_count: 3, repositories: [{ full_name: "a/one" }] },
            { headers: { link: `<${base}?page=2>; rel="next"` } },
          )
        }
        if (page === "2") {
          return Response.json(
            { total_count: 3, repositories: [{ full_name: "a/two" }] },
            { headers: { link: `<${base}?page=3>; rel="next"` } },
          )
        }
        return Response.json({
          total_count: 3,
          repositories: [{ full_name: "a/three" }],
        })
      },
    })
    base = `http://127.0.0.1:${server.port}/installation/repositories`

    try {
      const all = await ghPaginate<{ full_name: string }>(
        base,
        { kind: "none" },
        (body) =>
          (body as { repositories: { full_name: string }[] }).repositories,
      )
      expect(all.map((r) => r.full_name)).toEqual(["a/one", "a/two", "a/three"])
    } finally {
      server.stop(true)
    }
  })

  test("stops at a single page with no Link header", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.json([{ id: 1 }]),
    })
    try {
      const all = await ghPaginate<{ id: number }>(
        `http://127.0.0.1:${server.port}/app/installations`,
        { kind: "none" },
        (body) => body as { id: number }[],
      )
      expect(all).toHaveLength(1)
    } finally {
      server.stop(true)
    }
  })

  test("an error status throws without leaking the response body", async () => {
    // A 401 body can echo fragments of the credential that failed, and this
    // message reaches the deploy log.
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response("token ghs_supersecretvalue is bad", { status: 401 }),
    })
    try {
      const promise = ghPaginate(
        `http://127.0.0.1:${server.port}/x`,
        { kind: "none" },
        (b) => b as unknown[],
      )
      await expect(promise).rejects.toBeInstanceOf(GitHubError)
      await promise.catch((err: unknown) => {
        expect((err as Error).message).not.toContain("ghs_supersecret")
      })
    } finally {
      server.stop(true)
    }
  })
})

describe("reference validation", () => {
  test("accepts real repository names", () => {
    expect(isValidRepoRef("MahmoudDahdouh/musdash")).toBe(true)
    expect(isValidRepoRef("octocat/Hello-World")).toBe(true)
    expect(isValidRepoRef("a_b/c.d")).toBe(true)
  })

  test("rejects anything that could escape the URL path", () => {
    for (const bad of [
      "",
      "noslash",
      "a/b/c",
      "../etc/passwd",
      "a/../../b",
      "a b/c",
      "a/c?x=1",
      "https://evil.com/x/y",
    ]) {
      expect(isValidRepoRef(bad)).toBe(false)
    }
  })

  test("accepts ordinary git refs", () => {
    for (const ok of ["main", "feature/x", "v1.2.3", "release-2024"]) {
      expect(isValidGitRef(ok)).toBe(true)
    }
  })

  test("rejects refs with traversal, whitespace or control characters", () => {
    for (const bad of [
      "",
      "/main",
      "a..b",
      "ma in",
      "main\n",
      "a~1",
      "a^",
      "a:b",
      "a\b",
    ]) {
      expect(isValidGitRef(bad)).toBe(false)
    }
  })
})

/**
 * An error message from a failed request reaches the deploy log, so a path
 * segment that IS a credential must not survive into it. The manifest
 * registration code is the case that motivated this: it exchanges in one call
 * for the App's client_secret, private key and webhook secret, and replaying an
 * expired one lands on the 404 branch that interpolates the path.
 */
describe("sanitizePath", () => {
  test("masks the manifest registration code", () => {
    const code = "a1b2c3d4e5f6a1b2c3d4e5f6"
    const shaped = sanitizePath(`/app-manifests/${code}/conversions`)

    expect(shaped).not.toContain(code)
    expect(shaped).toBe("/app-manifests/*/conversions")
  })

  test("keeps the route shape while masking every variable segment", () => {
    expect(sanitizePath("/app/installations/12345678/access_tokens")).toBe(
      "/app/installations/*/access_tokens",
    )
    expect(sanitizePath("/repos/octocat/hello-world/commits/main")).toBe(
      "/repos/*/*/commits/*",
    )
    expect(sanitizePath("/repos/octocat/hello-world/tarball/deadbeef")).toBe(
      "/repos/*/*/tarball/*",
    )
  })

  test("leaves a path that is entirely route keywords intact", () => {
    expect(sanitizePath("/app/installations")).toBe("/app/installations")
    expect(sanitizePath("/installation/repositories")).toBe(
      "/installation/repositories",
    )
  })

  test("drops the query string of an absolute pagination URL", () => {
    expect(
      sanitizePath(
        "https://api.github.com/installation/repositories?per_page=100&page=2",
      ),
    ).toBe("/installation/repositories")
  })

  test("drops the query string of a relative path too", () => {
    // A separate branch from the absolute-URL case above: that one gets its
    // query dropped by URL.pathname, this one by an explicit truncation. Pinned
    // separately so a refactor that collapses the two cannot quietly lose it.
    expect(sanitizePath("/installation/repositories?per_page=100")).toBe(
      "/installation/repositories",
    )
    expect(sanitizePath("/repos/octocat/demo/commits/main#frag")).toBe(
      "/repos/*/*/commits/*",
    )
  })

  test("fails closed on an unknown endpoint rather than printing its data", () => {
    // The allow-list direction is the point: an endpoint nobody taught this
    // about has its segments masked instead of logged.
    expect(sanitizePath("/some/new/endpoint/secret-value")).toBe("/*/*/*/*")
  })
})
