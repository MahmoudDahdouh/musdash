import { Database } from "bun:sqlite"
import { config } from "../config.ts"

/**
 * The single write connection for the whole process.
 *
 * WAL solves reader/writer contention, not writer/writer — two connections
 * writing concurrently still produce SQLITE_BUSY. Since the HTTP handlers and
 * the job worker both write, there is exactly one connection here and no
 * factory function that could accidentally produce a second. `busy_timeout`
 * covers the remaining case of an external process (a CLI, a backup) holding
 * the lock briefly.
 */
export const db = new Database(config.dbPath, { create: true })

db.exec("PRAGMA journal_mode = WAL")
db.exec("PRAGMA synchronous = NORMAL")
// Per-connection, not persisted in the file — it must be set here, not in a
// migration, or foreign keys are silently unenforced.
db.exec("PRAGMA foreign_keys = ON")
db.exec("PRAGMA busy_timeout = 5000")

export function closeDb(): void {
  db.close(false)
}
