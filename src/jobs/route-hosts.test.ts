import { expect, spyOn, test } from "bun:test"
import type { Domain } from "../db/schema.ts"

// routeHosts reads rows only: an automatic hostname is stored once and never
// recomputed from names (D66). The spies keep the real database out of it.
test("routeHosts is the resource's rows minus the dashboard host", async () => {
  const queries = await import("../db/queries.ts")
  const settings = await import("../settings.ts")
  const { routeHosts } = await import("./routes.ts")
  const row = (host: string, isAuto: number): Domain => ({
    id: host,
    resourceId: "r1",
    host,
    isAuto,
    createdAt: "2026-01-01T00:00:00.000Z",
  })
  const spies = [
    spyOn(queries, "listDomains").mockImplementation(() => [
      row("brave-otter.1.2.3.4.sslip.io", 1),
      row("app.example.com", 0),
      row("mus.example.com", 0),
    ]),
    spyOn(settings, "getDashboardHost").mockImplementation(
      () => "mus.example.com",
    ),
  ]
  try {
    expect(routeHosts("r1")).toEqual([
      "brave-otter.1.2.3.4.sslip.io",
      "app.example.com",
    ])
  } finally {
    for (const s of spies) s.mockRestore()
  }
})
