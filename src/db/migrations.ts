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
import singleUser0004 from "../../migrations/0004_single_user.sql" with { type: "text" }
import { logger } from "../log.ts"

/**
 * The migration list and its runner, with no database of their own: the caller
 * passes the connection. That is what lets src/db/single-user.test.ts apply the
 * real, full list to `:memory:` without opening data/musdash.db — importing
 * ./index.ts would open it.
 */

export interface Migration {
  name: string
  sql: string
  /**
   * Runs inside the migration's transaction, before `sql`. It may return a
   * function the runner calls only after the transaction commits — so nothing
   * it reports is logged for a migration that then rolled back. That function
   * must not throw: the migration is already committed and recorded, so a
   * throw stops startup and the next boot will not run the hook again.
   */
  before?: (database: Database) => (() => void) | undefined
}

export const MIGRATIONS: readonly Migration[] = [
  { name: "0001_init", sql: init0001 },
  { name: "0002_github", sql: github0002 },
  { name: "0003_shared_env", sql: sharedEnv0003 },
  {
    name: "0004_single_user",
    sql: singleUser0004,
    before: reportExtraAccounts,
  },
]

export function runMigrations(
  database: Database,
  migrations: readonly Migration[] = MIGRATIONS,
): string[] {
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
  for (const m of migrations) {
    if (applied.has(m.name)) continue
    let afterCommit: (() => void) | undefined
    // Each migration is one transaction: a crash halfway leaves no partial
    // schema for the next boot to trip over.
    const tx = database.transaction(() => {
      afterCommit = m.before?.(database)
      database.exec(m.sql)
      database.run("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)", [
        m.name,
        new Date().toISOString(),
      ])
    })
    tx()
    ran.push(m.name)
    logger.info({ migration: m.name }, "applied migration")
    afterCommit?.()
  }
  return ran
}

interface AccountRow {
  id: string
  email: string
  created_at: string
}

/**
 * 0004's hook: names the accounts its SQL is about to keep and move, so an
 * owner whose install had two accounts learns which one survived. Selects no
 * password_hash — it must never reach a log line (D34). The ORDER BY is the
 * migration's own, so "kept" here is the row the SQL keeps.
 *
 * Never throws: a failure to report must not block the migration, and with it
 * startup. If the SELECT itself fails, the SQL that follows would fail on the
 * same table and roll back anyway.
 */
function reportExtraAccounts(database: Database): (() => void) | undefined {
  let rows: AccountRow[]
  try {
    rows = database
      .query<AccountRow, []>(
        "SELECT id, email, created_at FROM users ORDER BY created_at, id",
      )
      .all()
  } catch (err) {
    const errorName = err instanceof Error ? err.name : typeof err
    return () => {
      logger.warn({ errorName }, "could not list accounts before 0004")
    }
  }

  const [kept, ...moved] = rows
  if (!kept || moved.length === 0) return undefined
  return () => {
    logger.error(
      {
        kept: { id: kept.id, email: kept.email },
        moved: moved.map((r) => ({ id: r.id, email: r.email })),
        table: "users_removed_0004",
      },
      "more than one account existed; kept the oldest and moved the rest to users_removed_0004 — if the kept address is not yours, reinstall",
    )
  }
}
