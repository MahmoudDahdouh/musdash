import { expect, spyOn, test } from "bun:test"
import type { Environment, Project, Resource } from "../db/schema.ts"

/**
 * D67: a project's containers and routes are gone before any of its rows, and
 * the rows go child first. Every database and Docker call is a spy, so this
 * runs the real job against an in-memory model, never data/musdash.db or a
 * daemon.
 */
test("remove_project tears down every resource before deleting any parent row", async () => {
  const queries = await import("../db/queries.ts")
  const { docker } = await import("../docker/impl.ts")
  const { caddy } = await import("../caddy/client.ts")
  const { handlers } = await import("./index.ts")

  const project = { id: "p1", name: "Shop" } as Project
  const envs = new Map<string, Environment>([
    ["e1", { id: "e1", projectId: "p1", name: "production" } as Environment],
    ["e2", { id: "e2", projectId: "p1", name: "staging" } as Environment],
  ])
  const resources = new Map<string, Resource>(
    [
      ["r1", "e1"],
      ["r2", "e1"],
      ["r3", "e2"],
    ].map(([id, environmentId]) => [
      id as string,
      { id, environmentId, containerId: `c-${id}` } as Resource,
    ]),
  )
  let projectExists = true
  const log: string[] = []

  const spies = [
    spyOn(queries, "getProject").mockImplementation((id) =>
      projectExists && id === "p1" ? project : undefined,
    ),
    spyOn(queries, "listEnvironments").mockImplementation(() => [
      ...envs.values(),
    ]),
    spyOn(queries, "getEnvironment").mockImplementation((id) => envs.get(id)),
    spyOn(queries, "listResources").mockImplementation((envId) =>
      [...resources.values()].filter((r) => r.environmentId === envId),
    ),
    spyOn(queries, "getResource").mockImplementation((id) => resources.get(id)),
    spyOn(queries, "listDomains").mockImplementation(() => []),
    spyOn(queries, "queuedDeploymentIds").mockImplementation(() => []),
    spyOn(queries, "deleteResource").mockImplementation((id) => {
      log.push(`row resource ${id}`)
      resources.delete(id)
    }),
    spyOn(queries, "deleteEnvironment").mockImplementation((id) => {
      log.push(`row environment ${id}`)
      envs.delete(id)
    }),
    spyOn(queries, "deleteProject").mockImplementation((id) => {
      log.push(`row project ${id}`)
      projectExists = false
    }),
    spyOn(docker, "stopContainer").mockImplementation(async () => {}),
    spyOn(docker, "removeContainer").mockImplementation((id) => {
      log.push(`container ${id}`)
      return Promise.resolve()
    }),
    spyOn(docker, "listManagedContainers").mockImplementation(async () => []),
    spyOn(caddy, "deleteRoute").mockImplementation((id) => {
      log.push(`route ${id}`)
      return Promise.resolve()
    }),
  ]
  try {
    const run = handlers.remove_project
    expect(run).toBeDefined()
    await run?.({ projectId: "p1" })

    // Each resource: container, then route, then its row.
    for (const id of ["r1", "r2", "r3"]) {
      const container = log.indexOf(`container c-${id}`)
      const route = log.indexOf(`route musdash-${id}`)
      const row = log.indexOf(`row resource ${id}`)
      expect(container).toBeGreaterThanOrEqual(0)
      expect(container).toBeLessThan(route)
      expect(route).toBeLessThan(row)
    }
    // An environment's row after its resources', the project's last.
    expect(log.indexOf("row resource r2")).toBeLessThan(
      log.indexOf("row environment e1"),
    )
    expect(log.indexOf("row resource r3")).toBeLessThan(
      log.indexOf("row environment e2"),
    )
    expect(log.at(-1)).toBe("row project p1")

    // Run again, as lease recovery would after a crash: nothing left to do.
    const before = log.length
    await run?.({ projectId: "p1" })
    expect(log.length).toBe(before)
  } finally {
    for (const s of spies) s.mockRestore()
  }
})
