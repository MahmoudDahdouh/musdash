import type { Database } from "bun:sqlite"
// Static text import, NOT a runtime readdir of ./migrations.
//
// `bun build --compile` embeds statically imported assets and drops anything
// resolved dynamically. A migration runner that scanned the directory would
// work perfectly under `bun run dev` and then fail on every fresh install of
// the shipped binary, because that directory does not exist inside it. This is
// trap 6, and it is invisible until someone runs the release artifact.
import init0001 from "../../migrations/0001_init.sql" with { type: "text" }
import github0002 from "../../migrations/0002_github.sql" with { type: "text" }
import sharedEnv0003 from "../../migrations/0003_shared_env.sql" with { type: "text" }
import { db as defaultDb } from "./index.ts"
import { logger } from "../log.ts"

interface Migration {
  name: string
  sql: string
}

const MIGRATIONS: Migration[] = [
  { name: "0001_init", sql: init0001 },
  { name: "0002_github", sql: github0002 },
  { name: "0003_shared_env", sql: sharedEnv0003 },
]

export function migrate(database: Database = defaultDb): string[] {
  database.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT
  `)

  const applied = new Set(
    database
      .query<{ name: string }, []>("SELECT name FROM _migrations")
      .all()
      .map((r) => r.name),
  )

  const ran: string[] = []
  for (const m of MIGRATIONS) {
    if (applied.has(m.name)) continue
    // Each migration is one transaction: a crash halfway leaves no partial
    // schema for the next boot to trip over.
    const tx = database.transaction(() => {
      database.exec(m.sql)
      database.run("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)", [
        m.name,
        new Date().toISOString(),
      ])
    })
    tx()
    ran.push(m.name)
    logger.info({ migration: m.name }, "applied migration")
  }
  return ran
}
