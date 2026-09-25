import type { Database } from "bun:sqlite"
import { db as defaultDb } from "./index.ts"
import { runMigrations } from "./migrations.ts"

/**
 * Applies the shipped migrations to the process's one connection. The list and
 * the runner live in ./migrations.ts, which opens no database, so a test can run
 * them against `:memory:`.
 */
export function migrate(database: Database = defaultDb): string[] {
  return runMigrations(database)
}
