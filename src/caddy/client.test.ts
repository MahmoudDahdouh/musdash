import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { CaddyClient, DASHBOARD_ROUTE_ID } from "./client.ts"

/**
 * The route-order and transport guarantees, against a fake admin API on a unix
 * socket.
 *
 * The fake implements only the admin semantics the client relies on, as the
 * Caddy API documentation states them: POST to an array appends, PUT at an
 * index inserts, PATCH on /id/<id> replaces in place, and a GET re-encodes the
 * stored JSON with sorted keys. It cannot prove Caddy behaves that way — only
 * the VPS re-run can — but it does pin the client to that contract, which is
 * where C-1 came from: a new route was POSTed behind the dashboard's catch-all.
 */

interface Route {
  "@id": string
  [key: string]: unknown
}

const dir = mkdtempSync(join(tmpdir(), "musdash-caddy-"))
const socket = join(dir, "admin.sock")

let routes: Route[] = []
let writes: string[] = []
let hosts: (string | null)[] = []

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(o)
        .sort()
        .map((k) => [k, sortKeys(o[k])]),
    )
  }
  return v
}

const server = Bun.serve({
  unix: socket,
  async fetch(req) {
    const path = new URL(req.url).pathname
    const method = req.method
    hosts.push(req.headers.get("host"))
    if (method !== "GET") writes.push(`${method} ${path}`)
    const body =
      method === "GET" || method === "DELETE"
        ? null
        : ((await req.json()) as Route)

    const byId = /^\/id\/(.+)$/.exec(path)
    if (byId) {
      const id = decodeURIComponent(byId[1] ?? "")
      const i = routes.findIndex((r) => r["@id"] === id)
      if (i < 0) return new Response("unknown id", { status: 404 })
      if (method === "GET") return Response.json(sortKeys(routes[i]))
      if (method === "PATCH" && body) routes[i] = body
      if (method === "DELETE") routes.splice(i, 1)
      return new Response("")
    }
    const list = "/config/apps/http/servers/srv0/routes"
    if (path === list && method === "GET") return Response.json(routes)
    if (path === `${list}/` && method === "POST" && body) {
      routes.push(body)
      return new Response("")
    }
    if (path === `${list}/0` && method === "PUT" && body) {
      routes.unshift(body)
      return new Response("")
    }
    return new Response(`unhandled ${method} ${path}`, { status: 400 })
  },
})

afterAll(() => {
  server.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  routes = []
  writes = []
  hosts = []
})

const client = new CaddyClient(socket)
const ids = () => routes.map((r) => r["@id"])

describe("route order (C-1)", () => {
  test("a new resource route lands ahead of the dashboard catch-all", async () => {
    await client.appendRoute({
      id: DASHBOARD_ROUTE_ID,
      hosts: [],
      upstream: "musdash-host:8000",
    })
    await client.upsertRoute({
      id: "musdash-a",
      hosts: ["a.example.com"],
      upstream: "172.18.0.5:80",
    })
    await client.upsertRoute({
      id: "musdash-b",
      hosts: ["b.example.com"],
      upstream: "172.18.0.6:80",
    })
    expect(ids().at(-1)).toBe(DASHBOARD_ROUTE_ID)
    expect(ids()).toEqual(["musdash-b", "musdash-a", DASHBOARD_ROUTE_ID])
  })

  test("a redeploy patches in place and keeps the position", async () => {
    await client.appendRoute({
      id: DASHBOARD_ROUTE_ID,
      hosts: [],
      upstream: "musdash-host:8000",
    })
    await client.upsertRoute({
      id: "musdash-a",
      hosts: ["a.example.com"],
      upstream: "172.18.0.5:80",
    })
    writes = []
    await client.upsertRoute({
      id: "musdash-a",
      hosts: ["a.example.com"],
      upstream: "172.18.0.9:80",
    })
    expect(writes).toEqual(["PATCH /id/musdash-a"])
    expect(ids()).toEqual(["musdash-a", DASHBOARD_ROUTE_ID])
  })
})

describe("ensureRoute", () => {
  const spec = {
    id: "musdash-a",
    hosts: ["a.example.com"],
    upstream: "172.18.0.5:80",
  }

  test("writes nothing when the stored route already matches", async () => {
    await client.upsertRoute(spec)
    writes = []
    expect(await client.ensureRoute(spec)).toBe(false)
    expect(writes).toEqual([])
  })

  test("patches when the upstream changed", async () => {
    await client.upsertRoute(spec)
    writes = []
    const moved = { ...spec, upstream: "172.18.0.7:80" }
    expect(await client.ensureRoute(moved)).toBe(true)
    expect(writes).toEqual(["PATCH /id/musdash-a"])
  })
})

describe("transport", () => {
  test("sends Host 127.0.0.1, which Caddy 2.9 and earlier accept on a unix socket", async () => {
    await client.listRouteIds()
    expect(hosts).toEqual(["127.0.0.1"])
  })

  test("listRouteIds returns the ids in order", async () => {
    await client.upsertRoute({
      id: "musdash-a",
      hosts: ["a.example.com"],
      upstream: "172.18.0.5:80",
    })
    await client.appendRoute({
      id: DASHBOARD_ROUTE_ID,
      hosts: [],
      upstream: "musdash-host:8000",
    })
    expect(await client.listRouteIds()).toEqual([
      "musdash-a",
      DASHBOARD_ROUTE_ID,
    ])
  })
})
