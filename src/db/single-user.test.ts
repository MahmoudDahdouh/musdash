import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { MIGRATIONS, runMigrations } from "./migrations.ts"

/**
 * "Exactly one account" is a database constraint (migrations/0004, D36), and
 * two things can silently undo it: a later migration that rebuilds `users` and
 * drops idx_users_single — which only a setup race would reveal — and the
 * one-time dedup of installs that already have two accounts, which runs on a
 * handful of real databases with no chance to watch it first.
 *
 * Runs the real, full shipped migration list through the real runner against
 * `:memory:`. Imports ./migrations.ts and never ./index.ts, so data/musdash.db
 * is never opened.
 */

const BEFORE_0004 = MIGRATIONS.slice(0, 3)

function open(foreignKeys: boolean): Database {
  const db = new Database(":memory:")
  db.exec(`PRAGMA foreign_keys = ${foreignKeys ? "ON" : "OFF"}`)
  return db
}

function insertUser(
  db: Database,
  id: string,
  email: string,
  createdAt: string,
): void {
  db.run(
    "INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)",
    [id, email, `hash-of-${id}`, createdAt],
  )
}

function insertSession(db: Database, id: string, userId: string): void {
  db.run(
    "INSERT INTO sessions (id, user_id, csrf_token, expires_at, created_at) VALUES (?, ?, 'csrf', '2999-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    [id, userId],
  )
}

/** The `code` of whatever `fn` throws, or "did not throw". */
function thrownCode(fn: () => void): unknown {
  try {
    fn()
  } catch (err) {
    return err instanceof Error && "code" in err ? err.code : "no code"
  }
  return "did not throw"
}

function count(db: Database, table: string): number {
  const row = db
    .query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`)
    .get()
  return row?.n ?? -1
}

function hasIndex(db: Database): boolean {
  return (
    db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_users_single'",
      )
      .get() !== null
  )
}

describe("the full shipped migration list", () => {
  test("a second user with a different email is refused", () => {
    const db = open(true)
    runMigrations(db)
    expect(hasIndex(db)).toBe(true)
    insertUser(db, "01A", "owner@example.com", "2026-01-01T00:00:00.000Z")

    expect(
      thrownCode(() =>
        insertUser(db, "01B", "other@example.com", "2026-01-02T00:00:00.000Z"),
      ),
    ).toBe("SQLITE_CONSTRAINT_UNIQUE")
    expect(count(db, "users")).toBe(1)
  })

  test("a second user with the same email is refused with the same code", () => {
    const db = open(true)
    runMigrations(db)
    insertUser(db, "01A", "owner@example.com", "2026-01-01T00:00:00.000Z")

    expect(
      thrownCode(() =>
        insertUser(db, "01B", "owner@example.com", "2026-01-02T00:00:00.000Z"),
      ),
    ).toBe("SQLITE_CONSTRAINT_UNIQUE")
    expect(count(db, "users")).toBe(1)
  })
})

describe("0004 on an install that already has two accounts", () => {
  for (const foreignKeys of [true, false]) {
    test(`keeps the oldest and moves the other (foreign_keys ${foreignKeys ? "ON" : "OFF"})`, () => {
      const db = open(foreignKeys)
      runMigrations(db, BEFORE_0004)
      // The newer account is inserted first, so "oldest" has to come from
      // created_at and not from insertion order.
      insertUser(db, "01B", "second@example.com", "2026-01-02T00:00:00.000Z")
      insertUser(db, "01A", "first@example.com", "2026-01-01T00:00:00.000Z")
      insertSession(db, "s-first", "01A")
      insertSession(db, "s-second", "01B")

      expect(runMigrations(db)).toContain("0004_single_user")

      expect(db.query("SELECT id, email FROM users").all()).toEqual([
        { id: "01A", email: "first@example.com" },
      ])
      expect(db.query("SELECT id, user_id FROM sessions").all()).toEqual([
        { id: "s-first", user_id: "01A" },
      ])
      expect(db.query("SELECT * FROM users_removed_0004").all()).toEqual([
        {
          id: "01B",
          email: "second@example.com",
          password_hash: "hash-of-01B",
          created_at: "2026-01-02T00:00:00.000Z",
        },
      ])
      expect(hasIndex(db)).toBe(true)
    })
  }
})

describe("0004 on an install with zero or one account", () => {
  test("zero accounts: nothing changes", () => {
    const db = open(true)
    runMigrations(db, BEFORE_0004)
    expect(runMigrations(db)).toContain("0004_single_user")
    expect(count(db, "users")).toBe(0)
    expect(count(db, "users_removed_0004")).toBe(0)
  })

  test("one account: it and its session stay", () => {
    const db = open(true)
    runMigrations(db, BEFORE_0004)
    insertUser(db, "01A", "owner@example.com", "2026-01-01T00:00:00.000Z")
    insertSession(db, "s-owner", "01A")

    expect(runMigrations(db)).toContain("0004_single_user")
    expect(db.query("SELECT * FROM users").all()).toEqual([
      {
        id: "01A",
        email: "owner@example.com",
        password_hash: "hash-of-01A",
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ])
    expect(count(db, "sessions")).toBe(1)
    expect(count(db, "users_removed_0004")).toBe(0)
  })
})
