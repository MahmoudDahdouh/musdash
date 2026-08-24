import { Elysia, t } from "elysia"
import {
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
import { logger } from "../log.ts"
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

      const user = await createUser(body.email, body.password)
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
      const user = await verifyCredentials(body.email, body.password)
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
