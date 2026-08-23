import { eq, lt } from "drizzle-orm"
import { orm } from "./db/drizzle.ts"
import { sessions, users, type User } from "./db/schema.ts"
import { randomToken, safeEqual } from "./crypto.ts"
import { nowIso, ulid } from "./ids.ts"
import { config } from "./config.ts"

/**
 * Sessions in SQLite, not JWT: logout must actually revoke, and a stateless
 * token cannot be revoked without inventing a denylist — which is a session
 * table with extra steps.
 */

const SESSION_DAYS = 30
export const SESSION_COOKIE = "mosdash_session"

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

export async function createUser(
  email: string,
  password: string,
): Promise<User> {
  const user: User = {
    id: ulid(),
    email: email.toLowerCase().trim(),
    passwordHash: await Bun.password.hash(password, "argon2id"),
    createdAt: nowIso(),
  }
  orm.insert(users).values(user).run()
  return user
}

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
    // Hash anyway so a missing account and a wrong password take similar time.
    await Bun.password.hash(password, "argon2id").catch(() => "")
    return null
  }
  const ok = await Bun.password.verify(password, user.passwordHash)
  return ok ? user : null
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
