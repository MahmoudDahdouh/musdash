import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { MIGRATIONS, runMigrations } from "./migrations.ts"

/**
 * 0007 runs on installs that already have deployments and domains. Applies
 * 0001–0006, inserts rows as an existing install would have them, then runs
 * the full shipped list through the real runner against `:memory:` (never
 * ./index.ts, which would open data/musdash.db).
 */
test("0007 applies to a database that already has 0001–0006, leaving old rows null", () => {
  const db = new Database(":memory:")
  const upTo0006 = MIGRATIONS.slice(0, 6)
  // Up to 0007, not the whole list, so a later migration does not change
  // what this test is about.
  const upTo0007 = MIGRATIONS.slice(0, 7)
  expect(upTo0006.at(-1)?.name).toBe("0006_auto_webpack")
  expect(upTo0007.at(-1)?.name).toBe("0007_compose")
  runMigrations(db, upTo0006)

  // The rows belong to a resource that does not exist here; the foreign key
  // is not what is under test.
  db.exec("PRAGMA foreign_keys = OFF")
  db.run(
    "INSERT INTO deployments (id, resource_id, status, image, trigger, created_at) VALUES ('d1', 'r1', 'succeeded', 'nginx:1', 'manual', '2026-01-01T00:00:00.000Z')",
  )
  db.run(
    "INSERT INTO domains (id, resource_id, host, is_auto, created_at) VALUES ('m1', 'r1', 'a.example.test', 1, '2026-01-01T00:00:00.000Z')",
  )

  expect(runMigrations(db, upTo0007)).toEqual(["0007_compose"])

  expect(
    db
      .query<{ compose_file: unknown }, []>(
        "SELECT compose_file FROM deployments WHERE id = 'd1'",
      )
      .get(),
  ).toEqual({ compose_file: null })
  expect(
    db
      .query<{ service_name: unknown; container_port: unknown }, []>(
        "SELECT service_name, container_port FROM domains WHERE id = 'm1'",
      )
      .get(),
  ).toEqual({ service_name: null, container_port: null })

  // The columns take what a compose deploy and its auto domain write.
  db.run("UPDATE deployments SET compose_file = 'services: {}' WHERE id = 'd1'")
  db.run(
    "UPDATE domains SET service_name = 'web', container_port = 8080 WHERE id = 'm1'",
  )
  expect(
    db
      .query<{ compose_file: unknown }, []>(
        "SELECT compose_file FROM deployments WHERE id = 'd1'",
      )
      .get(),
  ).toEqual({ compose_file: "services: {}" })
  expect(
    db
      .query<{ service_name: unknown; container_port: unknown }, []>(
        "SELECT service_name, container_port FROM domains WHERE id = 'm1'",
      )
      .get(),
  ).toEqual({ service_name: "web", container_port: 8080 })

  // A second boot applies nothing.
  expect(runMigrations(db, upTo0007)).toEqual([])
})
