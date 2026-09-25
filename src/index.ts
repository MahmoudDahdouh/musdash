import { Elysia } from "elysia"
import { config } from "./config.ts"
import { migrate } from "./db/migrate.ts"
import { guardRequest, handleError, serveOptions } from "./http.ts"
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
  // Before anything else: a public peer gets nothing, not even /health (D31),
  // and an oversized form is refused before Elysia reads it (D35).
  .onRequest(guardRequest)
  .onError(handleError)
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
  .listen(serveOptions())

logger.info(
  {
    port: config.port,
    hostname: app.server?.hostname,
    acmeStaging: config.acmeStaging,
  },
  "musdash listening",
)
