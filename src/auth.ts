import { and, eq, lt } from "drizzle-orm"
import { orm } from "./db/drizzle.ts"
import { sessions, users, type User } from "./db/schema.ts"
import { randomToken, safeEqual } from "./crypto.ts"
import { nowIso, ulid } from "./ids.ts"
import { config } from "./config.ts"
import { logger } from "./log.ts"
import { hashPassword, needsRehash, verifyPassword } from "./password.ts"

/**
 * Sessions in SQLite, not JWT: logout must actually revoke, and a stateless
 * token cannot be revoked without inventing a denylist — which is a session
 * table with extra steps.
 */

const SESSION_DAYS = 30
export const SESSION_COOKIE = "musdash_session"

export interface SessionUser {
  id: string
  email: string
  sessionId: string
  csrfToken: string
}

export function userCount(): number {
  return orm.select().from(users).all().length
}

export function hasAdminUser(): boolean {
  return userCount() > 0
}

/** May throw GateBusyError (src/password.ts); the route answers 503. */
export async function createUser(
  email: string,
  password: string,
): Promise<User> {
  const user: User = {
    id: ulid(),
    email: email.toLowerCase().trim(),
    passwordHash: await hashPassword(password),
    createdAt: nowIso(),
  }
  orm.insert(users).values(user).run()
  return user
}

/**
 * May throw GateBusyError (src/password.ts) on either path; the route answers
 * 503. Each path takes the argon2 gate exactly once before returning null.
 */
export async function verifyCredentials(
  email: string,
  password: string,
): Promise<User | null> {
  const user = orm
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase().trim()))
    .get()

  if (!user) {
    // Hash anyway so a missing account and a wrong password take similar time:
    // after the rehash both are one argon2 operation at the same parameters in
    // the same queue. No .catch here — a swallowed GateBusyError would answer
    // an unknown email "incorrect" instantly while a busy known email got a
    // 503, and that difference says which emails exist.
    await hashPassword(password)
    return null
  }
  const ok = await verifyPassword(password, user.passwordHash)
  if (!ok) return null
  if (needsRehash(user.passwordHash)) await upgradeHash(user, password)
  return user
}

/**
 * Replaces a hash made at older parameters (Bun's default m=65536, 64 MiB per
 * verify) the first time its owner signs in, which is the only moment the
 * plaintext is available. Best effort: a failure — the gate being full
 * included — must not turn a correct password into a failed sign-in; the next
 * sign-in simply tries again.
 */
async function upgradeHash(user: User, password: string): Promise<void> {
  try {
    const next = await hashPassword(password)
    // Conditional on the hash just verified, so a change that landed while
    // this one waited in the gate is never overwritten with a stale password.
    orm
      .update(users)
      .set({ passwordHash: next })
      .where(
        and(eq(users.id, user.id), eq(users.passwordHash, user.passwordHash)),
      )
      .run()
  } catch (err) {
    // The error's class name and nothing else. NEVER add `err` or its message:
    // drizzle 0.45's DrizzleQueryError message can embed the query params —
    // here, the new hash and the old one — and a hash in the journal is an
    // offline cracking target. The SQLite errors seen so far carry no params,
    // but the rule has to hold for every path that might.
    logger.warn(
      {
        userId: user.id,
        errorName: err instanceof Error ? err.name : typeof err,
      },
      "password rehash failed; will retry at next sign-in",
    )
  }
}

export function createSession(userId: string): {
  id: string
  csrfToken: string
  expiresAt: Date
} {
  const id = randomToken(32)
  const csrfToken = randomToken(32)
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400 * 1000)

  orm
    .insert(sessions)
    .values({
      id,
      userId,
      csrfToken,
      expiresAt: expiresAt.toISOString(),
      createdAt: nowIso(),
    })
    .run()

  return { id, csrfToken, expiresAt }
}

export function resolveSession(
  sessionId: string | undefined,
): SessionUser | null {
  if (!sessionId) return null

  const row = orm
    .select({
      sessionId: sessions.id,
      csrfToken: sessions.csrfToken,
      expiresAt: sessions.expiresAt,
      userId: users.id,
      email: users.email,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.id, sessionId))
    .get()

  if (!row) return null
  if (new Date(row.expiresAt).getTime() < Date.now()) {
    destroySession(sessionId)
    return null
  }
  return {
    id: row.userId,
    email: row.email,
    sessionId: row.sessionId,
    csrfToken: row.csrfToken,
  }
}

export function destroySession(sessionId: string): void {
  orm.delete(sessions).where(eq(sessions.id, sessionId)).run()
}

export function purgeExpiredSessions(): number {
  const stale = orm
    .select({ id: sessions.id })
    .from(sessions)
    .where(lt(sessions.expiresAt, nowIso()))
    .all()
  if (stale.length > 0) {
    orm.delete(sessions).where(lt(sessions.expiresAt, nowIso())).run()
  }
  return stale.length
}

export function verifyCsrf(session: SessionUser, submitted: unknown): boolean {
  if (typeof submitted !== "string" || submitted.length === 0) return false
  return safeEqual(session.csrfToken, submitted)
}

export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    // `secure` would make the cookie unusable over plain HTTP, which is how
    // development runs and how the very first login happens before Caddy has a
    // certificate. Production is behind Caddy, so it is set there.
    secure: config.isProduction,
    sameSite: "lax" as const,
    path: "/",
    expires: expiresAt,
  }
}
