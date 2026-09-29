import type { Database } from "bun:sqlite"
import { persistLegacyAutoDomains } from "../domains/auto.ts"
import { db as defaultDb } from "./index.ts"
import { runMigrations } from "./migrations.ts"

/**
 * Applies the shipped migrations to the process's one connection. The list and
 * the runner live in ./migrations.ts, which opens no database, so a test can run
 * them against `:memory:`.
 */
export function migrate(database: Database = defaultDb): string[] {
  const applied = runMigrations(database)
  // A one-time data step that needs config, which SQL cannot see (D66). Only
  // on the process's own connection: queries.ts writes through that one.
  if (database === defaultDb) persistLegacyAutoDomains()
  return applied
}
