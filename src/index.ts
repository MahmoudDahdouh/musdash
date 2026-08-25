import { Elysia } from "elysia"
import { bindHostname, config } from "./config.ts"
import { migrate } from "./db/migrate.ts"
import { logger } from "./log.ts"
import {
  queueSidecarBootstraps,
  reconcileOnce,
  startReconciler,
} from "./reconciler.ts"
import { appRoutes } from "./routes/app.ts"
import { authRoutes } from "./routes/auth.ts"
import { githubWebhookRoutes } from "./routes/github.ts"
import { sseRoutes } from "./routes/sse.ts"
import { startScheduler } from "./scheduler.ts"
import { startWorker } from "./queue/worker.ts"
import { assetResponse } from "./views/render.ts"

migrate()

// Heal before serving, so a rebooted box comes back without anyone asking.
await reconcileOnce().catch((e: unknown) => {
  logger.warn({ err: (e as Error).message }, "startup reconcile skipped")
})

startWorker()
queueSidecarBootstraps() // Docker work: the queue owns it, serving never waits.
startReconciler()
startScheduler()

const app = new Elysia()
  .onError(({ code, error, set }) => {
    // Never hand an internal error to the browser; log the detail, show a line.
    logger.error({ code, err: String(error) }, "request failed")
    if (code === "NOT_FOUND") return new Response("Not found", { status: 404 })
    set.status = 500
    return "Something went wrong. Check the server logs."
  })
  .get(
    "/assets/:file",
    ({ params, status }) =>
      assetResponse(params.file) ?? status(404, "not found"),
  )
  .get("/health", () => "ok")
  .use(authRoutes)
  .use(sseRoutes)
  // Its own instance, before appRoutes: appRoutes' guard would 303 a delivery
  // to /login, which GitHub records as success and never retries.
  .use(githubWebhookRoutes)
  .use(appRoutes)
  .listen({ port: config.port, hostname: bindHostname() })

logger.info(
  {
    port: config.port,
    hostname: app.server?.hostname,
    acmeStaging: config.acmeStaging,
  },
  "musdash listening",
)
