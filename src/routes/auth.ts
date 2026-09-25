import { Elysia, t } from "elysia"
import {
  AccountExistsError,
  createSession,
  createUser,
  destroySession,
  hasAdminUser,
  resolveSession,
  SESSION_COOKIE,
  sessionCookieOptions,
  verifyCredentials,
  verifyCsrf,
} from "../auth.ts"
import type { User } from "../db/schema.ts"
import { logger } from "../log.ts"
import { GateBusyError } from "../password.ts"
import { renderPage } from "../views/render.ts"

const credentials = t.Object({
  email: t.String({ format: "email", maxLength: 254 }),
  password: t.String({ minLength: 1, maxLength: 1024 }),
})

export const authRoutes = new Elysia()
  .derive(({ cookie }) => {
    const raw = cookie[SESSION_COOKIE]?.value
    return {
      session: resolveSession(typeof raw === "string" ? raw : undefined),
    }
  })
  .get("/setup", ({ redirect }) => {
    // Once an account exists this page must be unreachable: a second call would
    // be account takeover.
    if (hasAdminUser()) return redirect("/login", 303)
    return new Response(renderPage("setup", {}, { title: "Set up" }), {
      headers: { "content-type": "text/html; charset=utf-8" },
    })
  })

  .post(
    "/setup",
    async ({ body, cookie, redirect }) => {
      if (hasAdminUser()) return redirect("/login", 303)

      if (body.password.length < 12) {
        return html(
          renderPage(
            "setup",
            { error: "Password must be at least 12 characters." },
            { title: "Set up" },
          ),
        )
      }

      let user: User
      try {
        user = await createUser(body.email, body.password)
      } catch (err) {
        if (err instanceof GateBusyError) return busy("setup", "Set up")
        // Lost a race or a double-submit to the account that now exists: the
        // same answer GET /setup gives once there is one. No email in the line.
        if (err instanceof AccountExistsError) {
          logger.warn(
            { path: "/setup" },
            "setup lost to an existing account; redirected to sign-in",
          )
          return redirect("/login", 303)
        }
        throw err
      }
      const session = createSession(user.id)
      cookie[SESSION_COOKIE]?.set({
        value: session.id,
        ...sessionCookieOptions(session.expiresAt),
      })
      logger.info({ email: user.email }, "admin account created")
      return redirect("/", 303)
    },
    { body: credentials },
  )

  .get("/login", ({ redirect }) => {
    if (!hasAdminUser()) return redirect("/setup", 303)
    return html(renderPage("login", {}, { title: "Sign in" }))
  })

  .post(
    "/login",
    async ({ body, cookie, redirect }) => {
      let user: User | null
      try {
        user = await verifyCredentials(body.email, body.password)
      } catch (err) {
        if (err instanceof GateBusyError) return busy("login", "Sign in")
        throw err
      }
      if (!user) {
        // Deliberately vague: naming which half was wrong enumerates accounts.
        return html(
          renderPage(
            "login",
            { error: "Incorrect email or password." },
            { title: "Sign in" },
          ),
        )
      }
      const session = createSession(user.id)
      cookie[SESSION_COOKIE]?.set({
        value: session.id,
        ...sessionCookieOptions(session.expiresAt),
      })
      return redirect("/", 303)
    },
    { body: credentials },
  )

  .post(
    "/logout",
    ({ body, cookie, session, redirect, status }) => {
      // Logout is state-changing but lives in authRoutes, outside appRoutes'
      // global CSRF gate, so the check has to be explicit here. Without it any
      // origin can log the user out with a hidden auto-submitting form.
      //
      // Conditional on there being a session: a POST with none (already
      // logged out, expired cookie, double submit) has nothing to protect and
      // should land quietly on /login rather than 403.
      if (session && !verifyCsrf(session, body.csrf)) {
        logger.warn({ path: "/logout" }, "CSRF check failed")
        return status(403, "invalid CSRF token")
      }
      const id = cookie[SESSION_COOKIE]?.value
      // Deleting the row is what makes logout real; clearing the cookie alone
      // would leave a still-valid session id in anyone's hands.
      if (typeof id === "string") destroySession(id)
      cookie[SESSION_COOKIE]?.remove()
      return redirect("/login", 303)
    },
    { body: t.Object({ csrf: t.String() }) },
  )

function html(body: string): Response {
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8" },
  })
}

/**
 * The answer when the argon2 gate is full (src/password.ts): the same form
 * again, with the busy notice its template owns, and a 503 so a client knows to
 * retry rather than treating it as a wrong password. Both login paths — known
 * and unknown email — end here alike, so a busy answer reveals nothing about
 * which accounts exist.
 */
function busy(page: "login" | "setup", title: string): Response {
  return new Response(renderPage(page, { busy: true }, { title }), {
    status: 503,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "retry-after": "2",
    },
  })
}
