import { describe, expect, test } from "bun:test"
import {
  branchNotFound,
  describeFailure,
  ghPaginate,
  GitHubError,
  mapTimeout,
  sanitizePath,
} from "./api.ts"
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

/**
 * Each failure message names its cause so the user knows which fix to reach
 * for. Canned Responses rather than a server: these branches read only the
 * status, the headers and one boolean from the body, and `now` is injected so
 * the clock-dependent ones are exact.
 */
describe("describeFailure", () => {
  // A whole second, so a Date header (one-second resolution) represents
  // now ± N seconds exactly.
  const now = Date.parse("2026-01-01T00:00:00Z")
  const httpDate = (ms: number): string => new Date(ms).toUTCString()
  const defaultUnauthorized =
    "GitHub rejected musdash's credentials — the App may have been deleted or its key rotated. Reconnect GitHub in Settings."
  const secondaryPrefix = "GitHub's secondary rate limit was hit for "

  test("B1: a 401 on an App JWT names the clock skew only when it is large", async () => {
    const path = "/app/installations/123/access_tokens"
    const unauthorized = (headers: Record<string, string>): Response =>
      new Response("Bad credentials", { status: 401, headers })

    const ahead = await describeFailure(
      unauthorized({ date: httpDate(now - 120_000) }),
      path,
      "app",
      now,
    )
    expect(ahead.status).toBe(401)
    expect(ahead.message).toBe(
      "GitHub rejected musdash's credentials — this server's clock is 120 seconds ahead of GitHub. Sync the clock with NTP; if that does not help, the App's key may have been rotated — reconnect GitHub in Settings.",
    )

    // Behind only breaks the JWT once its 480s expiry is in GitHub's past.
    const behind = await describeFailure(
      unauthorized({ date: httpDate(now + 600_000) }),
      path,
      "app",
      now,
    )
    expect(behind.message).toContain("600 seconds behind GitHub")
    expect(behind.message).toContain("NTP")
    expect(behind.message).toContain("reconnect GitHub in Settings")

    // Skew under the threshold, no Date header, an unparseable one, and an
    // installation token (which carries no timestamps) all keep today's text.
    // So does a clock 120s behind: the JWT it signs is still inside its window.
    for (const [headers, kind] of [
      [{ date: httpDate(now - 30_000) }, "app"],
      [{ date: httpDate(now + 120_000) }, "app"],
      [{}, "app"],
      [{ date: "not a date" }, "app"],
      [{ date: httpDate(now - 120_000) }, "installation"],
    ] as const) {
      const err = await describeFailure(unauthorized(headers), path, kind, now)
      expect(err.status).toBe(401)
      expect(err.message).toBe(defaultUnauthorized)
    }
  })

  test("B2: a 422 on a commits lookup says the branch or commit was not found", async () => {
    const commits = await describeFailure(
      new Response("{}", { status: 422 }),
      "/repos/o/r/commits/main",
      "installation",
      now,
    )
    expect(commits.status).toBe(422)
    expect(commits.message).toBe(
      "GitHub returned 422 for /repos/*/*/commits/* — the branch or commit was not found",
    )

    const elsewhere = await describeFailure(
      new Response("{}", { status: 422 }),
      "/repos/o/r/tarball/main",
      "installation",
      now,
    )
    expect(elsewhere.message).toBe(
      "GitHub returned 422 for /repos/*/*/tarball/*",
    )

    const restated = branchNotFound(
      new GitHubError("GitHub returned 422", 422),
      "octocat/demo",
      "feature/x",
    )
    expect(restated).toBeInstanceOf(GitHubError)
    expect(restated?.status).toBe(422)
    expect(restated?.message).toBe(
      "Branch `feature/x` not found in `octocat/demo`.",
    )

    expect(
      branchNotFound(new GitHubError("nope", 404), "octocat/demo", "main"),
    ).toBeNull()
    expect(branchNotFound(new Error("boom"), "octocat/demo", "main")).toBeNull()
    expect(branchNotFound("422", "octocat/demo", "main")).toBeNull()
  })

  test("B3: a 403 whose body says suspended names the suspension, not the body", async () => {
    const suspended = await describeFailure(
      new Response(
        '{"message":"This installation has been suspended","token":"ghs_plantedsecret123"}',
        { status: 403 },
      ),
      "/installation/repositories",
      "installation",
      now,
    )
    expect(suspended.status).toBe(403)
    expect(suspended.message).toBe(
      "The GitHub App installation is suspended — unsuspend it in GitHub settings (/installation/repositories)",
    )
    expect(suspended.message).not.toContain("ghs_")

    const other = await describeFailure(
      new Response('{"message":"Resource not accessible by integration"}', {
        status: 403,
      }),
      "/repos/o/r/commits/main",
      "installation",
      now,
    )
    expect(other.message).toBe("GitHub returned 403 for /repos/*/*/commits/*")
  })

  test("B4: a secondary rate limit says when to retry", async () => {
    const path = "/repos/o/r/commits/main"
    const shape = "/repos/*/*/commits/*"
    const limited = (
      status: number,
      headers: Record<string, string>,
    ): Promise<GitHubError> =>
      describeFailure(
        new Response("{}", { status, headers }),
        path,
        "installation",
        now,
      )

    const seconds = await limited(403, { "retry-after": "30" })
    expect(seconds.status).toBe(403)
    expect(seconds.message).toBe(
      `${secondaryPrefix}${shape}; retry after ${new Date(now + 30_000).toISOString()}`,
    )

    const dated = await limited(429, {
      "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT",
    })
    expect(dated.status).toBe(429)
    expect(dated.message).toBe(
      `${secondaryPrefix}${shape}; retry after 2026-10-21T07:28:00.000Z`,
    )

    const bare = await limited(429, {})
    expect(bare.message).toBe(
      `${secondaryPrefix}${shape}; retry in a minute or two`,
    )

    const vague = await limited(403, { "retry-after": "soon" })
    expect(vague.message).toBe(
      `${secondaryPrefix}${shape}; retry in a minute or two`,
    )

    // A delta too large for a Date must not throw a RangeError instead.
    const huge = await limited(429, { "retry-after": "99999999999999" })
    expect(huge.message).toBe(
      `${secondaryPrefix}${shape}; retry in a minute or two`,
    )

    for (const err of [seconds, dated, bare, vague, huge]) {
      expect(err.message.startsWith(secondaryPrefix)).toBe(true)
    }

    // An exhausted primary quota wins even when Retry-After is also present:
    // its reset time is the more precise answer.
    const reset = Math.floor(now / 1000) + 600
    const primary = await limited(403, {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(reset),
      "retry-after": "30",
    })
    expect(primary.message).toBe(
      `GitHub's rate limit is exhausted; it resets at ${new Date(reset * 1000).toISOString()}`,
    )
  })

  test("B5: a timeout becomes status 0 with the route shape and nothing else", () => {
    const timeout = new DOMException("The operation timed out.", "TimeoutError")
    const err = mapTimeout(timeout, "/repos/o/r/commits/main")

    expect(err).toBeInstanceOf(GitHubError)
    expect(err?.status).toBe(0)
    expect(err?.message).toBe(
      "GitHub did not respond within 15s (/repos/*/*/commits/*)",
    )
    expect(err?.message).not.toContain("o/r")
    expect(err?.message).not.toContain("main")
    expect(err?.message).not.toContain("timed out")
    expect(err?.cause).toBeUndefined()

    expect(mapTimeout(new Error("boom"), "/x")).toBeNull()
    expect(
      mapTimeout(new DOMException("aborted", "AbortError"), "/x"),
    ).toBeNull()
  })

  test("B5 runtime pin: a body that stalls past the signal rejects res.json() with name TimeoutError", async () => {
    // ghJson and ghPaginate map timeouts around res.json() too, which only
    // works if a stalled body rejects with the same name as a stalled fetch.
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("{"))
            },
          }),
        ),
    })
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/`, {
        signal: AbortSignal.timeout(100),
      })
      const rejection = await res.json().then(
        () => null,
        (err: unknown) => err,
      )
      expect(
        typeof rejection === "object" &&
          rejection !== null &&
          "name" in rejection
          ? rejection.name
          : undefined,
      ).toBe("TimeoutError")
    } finally {
      server.stop(true)
    }
  })

  test("B5 runtime pin: an AbortSignal timeout rejects fetch with name TimeoutError", async () => {
    // mapTimeout keys on the rejection's name. If a Bun upgrade changed what
    // fetch rejects with on a timed-out signal, every timeout would silently
    // fall back to the raw runtime error; this pins the contract.
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Promise<Response>(() => undefined),
    })
    try {
      const rejection = await fetch(`http://127.0.0.1:${server.port}/`, {
        signal: AbortSignal.timeout(50),
      }).then(
        () => null,
        (err: unknown) => err,
      )
      expect(rejection).not.toBeNull()
      expect(
        typeof rejection === "object" &&
          rejection !== null &&
          "name" in rejection
          ? rejection.name
          : undefined,
      ).toBe("TimeoutError")
    } finally {
      server.stop(true)
    }
  })

  test("B6: a 404 keeps its access wording and masks the path", async () => {
    const err = await describeFailure(
      new Response("Not Found", { status: 404 }),
      "/app/installations/123/access_tokens",
      "app",
      now,
    )
    expect(err.status).toBe(404)
    expect(err.message).toBe(
      "GitHub returned 404 for /app/installations/*/access_tokens — the installation may no longer grant access to it",
    )
  })
})
