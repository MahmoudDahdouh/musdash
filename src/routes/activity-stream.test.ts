import { expect, spyOn, test } from "bun:test"
import type { ActiveDeployment } from "../db/queries.ts"

/**
 * GET /events feeds the layout's activity toast (D68). It must refuse an
 * anonymous request, send the whole list on connect and after each deployment
 * transition, and stop listening when the client goes away — a leaked
 * listener per closed tab is how idle RSS drifts (trap 5). The session and
 * the query are spies, so no database is read.
 */
test("the activity stream snapshots on connect and on change, and lets go", async () => {
  const auth = await import("../auth.ts")
  const queries = await import("../db/queries.ts")
  const { publishDeployment } = await import("../events.ts")
  const { sseRoutes } = await import("./sse.ts")

  const anonymous = await sseRoutes.handle(
    new Request("http://localhost/events"),
  )
  expect(anonymous.status).toBe(401)

  let list: ActiveDeployment[] = []
  const spies = [
    spyOn(auth, "resolveSession").mockImplementation(() => ({
      id: "u1",
      email: "a@example.test",
      sessionId: "s1",
      csrfToken: "t",
    })),
    spyOn(queries, "activeDeployments").mockImplementation(() => list),
  ]
  try {
    const res = await sseRoutes.handle(
      new Request("http://localhost/events", {
        headers: { cookie: `${auth.SESSION_COOKIE}=s1` },
      }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    const next = async () => decoder.decode((await reader.read()).value)

    expect(await next()).toBe("event: active\ndata: []\n\n")

    list = [
      { id: "d1", status: "running", resourceId: "r1", name: "Shop / Web" },
    ]
    publishDeployment({
      deploymentId: "d1",
      resourceId: "r1",
      status: "running",
    })
    expect(await next()).toBe(
      `event: active\ndata: ${JSON.stringify(list)}\n\n`,
    )

    // After the client leaves, an event reaches no query.
    await reader.cancel()
    const calls = spies[1]?.mock.calls.length
    publishDeployment({
      deploymentId: "d1",
      resourceId: "r1",
      status: "succeeded",
    })
    expect(spies[1]?.mock.calls.length).toBe(calls)
  } finally {
    for (const s of spies) s.mockRestore()
  }
})
