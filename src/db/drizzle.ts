import { drizzle } from "drizzle-orm/bun-sqlite"
import { db as sqlite } from "./index.ts"
import * as schema from "./schema.ts"

/**
 * Drizzle wraps the one `bun:sqlite` connection from ./index.ts. It does not
 * open its own — a second writer is exactly what the single-connection
 * invariant forbids.
 */
export const orm = drizzle(sqlite, { schema })
export { schema }
