import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { MIGRATIONS, runMigrations } from "./migrations.ts"

/**
 * 0006 runs on installs that already have deployments. Applies 0001–0005,
 * inserts a row as an existing install would have it, then runs the full
 * shipped list through the real runner against `:memory:` (never ./index.ts,
 * which would open data/musdash.db).
 */
test("0006 applies to a database that already has 0001–0005, leaving old rows null", () => {
  const db = new Database(":memory:")
  const upTo0005 = MIGRATIONS.slice(0, 5)
  expect(upTo0005.at(-1)?.name).toBe("0005_deploy_history")
  runMigrations(db, upTo0005)

  // The row belongs to a resource that does not exist here; the foreign key
  // is not what is under test.
  db.exec("PRAGMA foreign_keys = OFF")
  db.run(
    "INSERT INTO deployments (id, resource_id, status, image, trigger, created_at) VALUES ('d1', 'r1', 'succeeded', 'nginx:1', 'manual', '2026-01-01T00:00:00.000Z')",
  )

  expect(runMigrations(db, MIGRATIONS.slice(0, 6))).toEqual([
    "0006_auto_webpack",
  ])

  const row = db
    .query<{ auto_webpack_cap_mib: unknown }, []>(
      "SELECT auto_webpack_cap_mib FROM deployments WHERE id = 'd1'",
    )
    .get()
  expect(row).toEqual({ auto_webpack_cap_mib: null })

  // STRICT table: the column takes the integer the build job records.
  db.run("UPDATE deployments SET auto_webpack_cap_mib = 960 WHERE id = 'd1'")
  expect(
    db
      .query<{ auto_webpack_cap_mib: unknown }, []>(
        "SELECT auto_webpack_cap_mib FROM deployments WHERE id = 'd1'",
      )
      .get(),
  ).toEqual({ auto_webpack_cap_mib: 960 })

  // A second boot applies nothing it has not already applied.
  expect(runMigrations(db, MIGRATIONS.slice(0, 6))).toEqual([])
})
