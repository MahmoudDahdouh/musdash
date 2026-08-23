import { getDeployment, markDeploymentFailed } from "../db/queries.ts"
import { publishDeployment } from "../events.ts"
import { handlers } from "../jobs/index.ts"
import { logger } from "../log.ts"
import { claim, complete, fail, recoverExpiredLeases } from "./index.ts"

/**
 * The single worker loop.
 *
 * Concurrency is exactly 1 and must stay that way: a deploy spikes memory while
 * extracting layers, and two at once would blow the RAM budget the product is
 * built around. The loop awaits each handler before polling again — no
 * Promise.all, no fire-and-forget.
 */

const POLL_MS = 1000

let running = false
let stopped = false
let currentTimer: Timer | null = null

export function startWorker(): void {
  if (running) return
  running = true
  stopped = false

  // Jobs left leased by a crash come back to pending. This single call is what
  // makes an interrupted deploy resume rather than hang forever.
  const recovered = recoverExpiredLeases()
  if (recovered > 0) logger.info({ recovered }, "recovered expired job leases")

  void loop()
}

export function stopWorker(): void {
  stopped = true
  running = false
  if (currentTimer) clearTimeout(currentTimer)
}

async function loop(): Promise<void> {
  while (!stopped) {
    let didWork = false
    try {
      didWork = await tick()
    } catch (err) {
      logger.error({ err: (err as Error).message }, "worker tick failed")
    }
    // Poll immediately if the queue still has work; otherwise wait.
    if (!didWork) await sleep(POLL_MS)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    currentTimer = setTimeout(resolve, ms)
  })
}

async function tick(): Promise<boolean> {
  const job = claim()
  if (!job) return false

  const handler = handlers[job.type]
  if (!handler) {
    logger.error({ type: job.type, id: job.id }, "no handler for job type")
    fail(job.id, `no handler for job type ${job.type}`)
    return true
  }

  const startedAt = Date.now()
  try {
    const payload = JSON.parse(job.payload_json) as Record<string, unknown>
    await handler(payload)
    complete(job.id)
    logger.info(
      { type: job.type, id: job.id, ms: Date.now() - startedAt },
      "job completed",
    )
  } catch (err) {
    const message = (err as Error).message
    const result = fail(job.id, message)
    logger.warn(
      { type: job.type, id: job.id, retrying: result.retrying, err: message },
      "job failed",
    )

    // A job that gives up must not leave its deployment claiming to be running
    // — a permanently "deploying" pill with nothing behind it is a bug users
    // report.
    if (!result.retrying) {
      const payload = safeParse(job.payload_json)
      const deploymentId = payload?.deploymentId
      if (typeof deploymentId === "string") {
        const deployment = getDeployment(deploymentId)
        if (deployment && deployment.status !== "failed") {
          markDeploymentFailed(deploymentId, message)
          publishDeployment({
            deploymentId,
            resourceId: deployment.resourceId,
            status: "failed",
          })
        }
      }
    }
  }
  return true
}

function safeParse(json: string): Record<string, unknown> | null {
  try {
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return null
  }
}
