import type { Password } from "bun"
import { logger } from "./log.ts"

/**
 * The only file that touches `Bun.password` (D34, V-3).
 *
 * argon2id's cost is memory, allocated per call, and the sign-in form is the
 * one page anyone on the internet can reach. At Bun's default m=65536 KiB each
 * login attempt took 64 MiB, and nothing serialized them — by the measured idle
 * headroom, about eight parallel attempts from an unauthenticated client would
 * exhaust a 1GB host (an estimate, not an observed failure).
 * Two things fix it and both live here, behind one import, so no new call site
 * can quietly bypass either: smaller parameters, and a gate that runs one
 * argon2 operation at a time.
 *
 * Deliberately free of the database: the tests import this without opening
 * data/musdash.db.
 */

/**
 * OWASP Password Storage Cheat Sheet, argon2id option m=7168 KiB (7 MiB), t=5,
 * p=1 — the lowest-memory of the five settings OWASP lists as equal in defence,
 * because memory is this product's constraint. `memoryCost` is in KiB
 * (bun-types 1.4.0: "Memory usage, in kibibytes. Minimum 8."); the test pins the
 * encoded PHC string, so a misread unit cannot ship silently.
 */
export const ARGON2_PARAMS = {
  algorithm: "argon2id",
  memoryCost: 7168,
  timeCost: 5,
} as const satisfies Password.Argon2Algorithm

/**
 * Waiting callers allowed behind the one running argon2 operation. There is one
 * legitimate user; eight queued operations keep the worst wait well under a
 * second at these parameters (~0.1 s measured locally at ~11 ms per operation;
 * a 1 vCPU VPS is several times slower), and each waiter holds only a small parsed body and a
 * pending promise — no argon2 memory until it reaches the front.
 */
export const MAX_WAITING = 8

/** Thrown by Gate.run when MAX_WAITING callers are already queued. */
export class GateBusyError extends Error {
  // Set explicitly: the release binary is minified, so the class name the
  // runtime would infer is mangled, and the rehash warning logs this field.
  override readonly name = "GateBusyError"
}

export interface Gate {
  /**
   * Runs `task` when no other task is running; FIFO; rejects with
   * GateBusyError (without calling `task`) when `waiting === maxWaiting`.
   * Releases on resolve, reject, or synchronous throw of `task`, and passes the
   * task's outcome through.
   */
  run<T>(task: () => Promise<T>): Promise<T>
  readonly active: number
  readonly waiting: number
}

export function createGate(maxWaiting: number): Gate {
  let active = 0
  const queue: (() => void)[] = []

  // The slot is handed straight to the next waiter rather than freed and
  // re-contested. If `active` dropped to 0 between one task ending and the next
  // waiter's continuation running, a brand-new caller arriving in that gap
  // would see an empty gate and run alongside it — two argon2 blocks at once,
  // and out of order.
  function release(): void {
    const next = queue.shift()
    if (next) next()
    else active = 0
  }

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (active === 0) {
        active = 1
      } else {
        // Decided before anything is allocated: a rejected caller never
        // reaches argon2 and never holds a queue slot.
        if (queue.length >= maxWaiting) {
          throw new GateBusyError("password gate is full")
        }
        await new Promise<void>((resolve) => queue.push(resolve))
      }
      // `await task()` inside try covers all three exits — a resolved task, a
      // rejected one, and one that throws before returning a promise. Missing
      // any of them would hold the slot forever, and the only user could then
      // never sign in again until a restart.
      try {
        return await task()
      } finally {
        release()
      }
    },
    get active() {
      return active
    },
    get waiting() {
      return queue.length
    },
  }
}

/** One gate for every argon2 operation in the process. */
const gate = createGate(MAX_WAITING)

const BUSY_WARN_WINDOW_MS = 60_000
let busyTimer: ReturnType<typeof setTimeout> | null = null
let busyRejected = 0

/**
 * Warns about busy rejections at most once per window, so a flood cannot fill
 * the journal. The first rejection after a quiet window logs at once; later
 * ones are counted, and a single timer reports the count when the window ends
 * — so a burst's size always appears even if nothing follows it. A window that
 * ends with a count opens the next one; one that ends with none closes, and the
 * next rejection logs immediately again.
 *
 * Carries counts only. Never the email, the password, or a hash.
 */
function noteBusy(): void {
  if (busyTimer !== null) {
    busyRejected += 1
    return
  }
  logger.warn(
    { maxWaiting: MAX_WAITING },
    "sign-in busy: argon2 gate full, answered 503",
  )
  startBusyWindow()
}

function startBusyWindow(): void {
  busyTimer = setTimeout(flushBusy, BUSY_WARN_WINDOW_MS)
  // Never the reason the process stays alive, and tests must be able to exit.
  busyTimer.unref()
}

function flushBusy(): void {
  const rejected = busyRejected
  busyRejected = 0
  busyTimer = null
  if (rejected === 0) return
  logger.warn(
    { rejected, windowSeconds: BUSY_WARN_WINDOW_MS / 1000 },
    "sign-in busy: further attempts answered 503",
  )
  startBusyWindow()
}

async function guarded<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await gate.run(task)
  } catch (err) {
    if (err instanceof GateBusyError) noteBusy()
    throw err
  }
}

/** Hashes at ARGON2_PARAMS through the gate. May throw GateBusyError. */
export function hashPassword(password: string): Promise<string> {
  return guarded(() => Bun.password.hash(password, ARGON2_PARAMS))
}

/**
 * Verifies at whatever parameters `hash` encodes (an old m=65536 hash still
 * costs 64 MiB, but only one at a time). May throw GateBusyError.
 */
export function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  return guarded(() => Bun.password.verify(password, hash))
}

const CURRENT_PREFIX = `$argon2id$v=19$m=${ARGON2_PARAMS.memoryCost},t=${ARGON2_PARAMS.timeCost},p=1$`

/** True unless `hash` was produced with exactly ARGON2_PARAMS. Pure. */
export function needsRehash(hash: string): boolean {
  return !hash.startsWith(CURRENT_PREFIX)
}
