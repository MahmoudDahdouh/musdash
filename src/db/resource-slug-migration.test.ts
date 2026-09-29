import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { MIGRATIONS, runMigrations } from "./migrations.ts"

/**
 * 0007 runs on installs that already have resources, whose names were all
 * slugs until now. Applies 0001–0006 to `:memory:`, inserts resources as an
 * existing install would have them, then runs the rest of the shipped list.
 */
test("0007 backfills slug from name and makes it unique per environment", () => {
  const db = new Database(":memory:")
  const upTo0006 = MIGRATIONS.slice(0, 6)
  expect(upTo0006.at(-1)?.name).toBe("0006_auto_webpack")
  runMigrations(db, upTo0006)

  db.run(
    "INSERT INTO projects (id, name, created_at) VALUES ('p1', 'Shop', '2026-01-01T00:00:00.000Z')",
  )
  db.run(
    "INSERT INTO environments (id, project_id, name, created_at) VALUES ('e1', 'p1', 'production', '2026-01-01T00:00:00.000Z'), ('e2', 'p1', 'staging', '2026-01-01T00:00:00.000Z')",
  )
  const existing: [string, string, string][] = [
    ["r1", "e1", "web"],
    ["r2", "e1", "api"],
    ["r3", "e2", "web"],
  ]
  for (const [id, env, name] of existing) {
    db.run(
      "INSERT INTO resources (id, environment_id, name, kind, source_json, desired_state, created_at) VALUES (?, ?, ?, 'image', '{\"image\":\"nginx\"}', 'stopped', '2026-01-01T00:00:00.000Z')",
      [id, env, name],
    )
  }

  expect(runMigrations(db)).toContain("0007_resource_slug")

  const rows = db
    .query<{ id: string; slug: string }, []>(
      "SELECT id, slug FROM resources ORDER BY id",
    )
    .all()
  expect(rows).toEqual([
    { id: "r1", slug: "web" },
    { id: "r2", slug: "api" },
    { id: "r3", slug: "web" },
  ])

  // One slug per environment, the same slug across environments.
  expect(() =>
    db.run(
      "INSERT INTO resources (id, environment_id, name, slug, kind, source_json, desired_state, created_at) VALUES ('r4', 'e1', 'Web', 'web', 'image', '{}', 'stopped', '2026-01-01T00:00:00.000Z')",
    ),
  ).toThrow()
})
