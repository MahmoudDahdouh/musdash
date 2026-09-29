import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { MIGRATIONS, runMigrations } from "./migrations.ts"

/**
 * D67 relies on the schema's cascades for everything that is only rows: once
 * the job has removed each resource, deleting the environment (or project)
 * must take its shared variables with it, and a project its environments.
 */
test("deleting a project cascades to environments, resources and their rows", () => {
  const db = new Database(":memory:")
  db.exec("PRAGMA foreign_keys = ON")
  runMigrations(db, MIGRATIONS)
  const at = "2026-01-01T00:00:00.000Z"
  db.run(
    `INSERT INTO projects (id, name, created_at) VALUES ('p1', 'Shop', '${at}')`,
  )
  db.run(
    `INSERT INTO environments (id, project_id, name, created_at) VALUES ('e1', 'p1', 'production', '${at}')`,
  )
  db.run(
    `INSERT INTO resources (id, environment_id, name, slug, kind, source_json, desired_state, created_at) VALUES ('r1', 'e1', 'Web', 'web', 'image', '{}', 'stopped', '${at}')`,
  )
  db.run(
    `INSERT INTO deployments (id, resource_id, status, image, trigger, created_at) VALUES ('d1', 'r1', 'succeeded', 'nginx', 'manual', '${at}')`,
  )
  db.run(
    `INSERT INTO domains (id, resource_id, host, is_auto, created_at) VALUES ('m1', 'r1', 'brave-otter.1.2.3.4.sslip.io', 1, '${at}')`,
  )
  db.run(
    `INSERT INTO shared_env_vars (id, project_id, environment_id, key, value_encrypted, scope, created_at) VALUES ('s1', NULL, 'e1', 'A', x'00', 'runtime', '${at}'), ('s2', 'p1', NULL, 'B', x'00', 'runtime', '${at}')`,
  )

  db.run("DELETE FROM environments WHERE id = 'e1'")
  const count = (table: string) =>
    db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n
  expect(count("resources")).toBe(0)
  expect(count("deployments")).toBe(0)
  expect(count("domains")).toBe(0)
  expect(count("shared_env_vars")).toBe(1)

  db.run("DELETE FROM projects WHERE id = 'p1'")
  expect(count("shared_env_vars")).toBe(0)
  expect(count("environments")).toBe(0)
})
