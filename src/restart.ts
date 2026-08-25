import { activeJobCount } from "./queue/index.ts"
import { stopWorker } from "./queue/worker.ts"
import { stopReconciler } from "./reconciler.ts"
import { stopScheduler } from "./scheduler.ts"
import { logger } from "./log.ts"

/**
 * Restarting musdash from the dashboard.
 *
 * This is deliberately NOT a job. The worker calls complete() after the handler
 * returns, so a handler that exits the process never completes its own row: the
 * lease sits there, recoverExpiredLeases() re-claims it fifteen minutes later,
 * and the process restarts again. A restart job is a slow restart loop.
 *
 * It is a direct route action instead, which does not breach "do not await in a
 * handler" because nothing is awaited — the exit is deferred past the response.
 */

/** How long the response has to reach the browser before the process exits. */
const EXIT_DELAY_MS = 750

/**
 * Whether something will actually bring musdash back up.
 *
 * systemd sets INVOCATION_ID on every service process, which needs no
 * subprocess, no permissions, and no knowledge of the unit's own name — asking
 * `systemctl show` would need all three, and the process cannot reliably learn
 * what unit it is. Under `bun run dev` the variable is absent, so the button is
 * disabled rather than silently killing the dev server.
 *
 * This cannot see a hand-written unit with `Restart=no`, which is why the UI
 * shows the fallback command alongside the button rather than instead of it.
 */
export function restartCapability(): "systemd" | "unmanaged" {
  return process.env.INVOCATION_ID === undefined ? "unmanaged" : "systemd"
}

/**
 * Why a restart should not happen right now, or null.
 *
 * Counts leased jobs as well as pending ones: a deploy that is mid-flight is
 * leased, and that is exactly the case worth blocking — restarting through one
 * strands a half-swapped resource until the lease expires. Refusing is honest
 * and costs the operator three seconds; draining would mean a background timer
 * holding a promise nobody is watching.
 */
export function restartBlockedReason(): string | null {
  const active = activeJobCount()
  if (active === 0) return null
  return active === 1
    ? "a job is running — try again in a moment"
    : `${active} jobs are running — try again in a moment`
}

/**
 * Stops the background loops and exits, so systemd starts a fresh process.
 *
 * The worker is stopped first to close the window where it claims a job it will
 * never finish. Exiting is safe for bun:sqlite — writes are synchronous and
 * already committed, and the WAL is durable — and systemd's `Restart=always`
 * restarts on a clean exit just as it does on a failure.
 */
export function requestRestart(): void {
  logger.info("restart requested from the dashboard")
  stopWorker()
  stopReconciler()
  stopScheduler()
  setTimeout(() => process.exit(0), EXIT_DELAY_MS)
}
