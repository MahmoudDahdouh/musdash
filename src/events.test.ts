import { afterEach, describe, expect, test } from "bun:test"
import {
  DEPLOY_LOG_FINISHED_TTL_MS,
  DEPLOY_LOG_KEEP,
  deployLogCount,
  deployLogTail,
  dropDeployLogs,
  markDeployLogFinished,
  publishDeployLog,
  subscribeDeployLogs,
} from "./events.ts"

/**
 * The deploy log map lives for the process, so without a bound it grows by one
 * entry per deployment forever — RSS drift the idle gate never sees, because
 * it boots fresh. These pin the bound and the eviction order.
 */
describe("deploy log retention", () => {
  // The map is module state shared by every test in this file; each test
  // drops what it created so the next starts from empty.
  const created: string[] = []
  const log = (id: string, text = "line") => {
    created.push(id)
    publishDeployLog(id, text)
  }
  afterEach(() => {
    for (const id of created.splice(0)) dropDeployLogs(id)
  })

  test("never holds more than the bound, however many deploys run", () => {
    for (let i = 0; i < 200; i++) {
      log(`bound-${i}`)
      markDeployLogFinished(`bound-${i}`)
      expect(deployLogCount()).toBeLessThanOrEqual(DEPLOY_LOG_KEEP)
    }
    expect(deployLogCount()).toBe(DEPLOY_LOG_KEEP)
    // The newest survive, the oldest went.
    expect(deployLogTail("bound-199")).toEqual(["line"])
    expect(deployLogTail("bound-0")).toEqual([])
  })

  test("the bound holds even when nothing is ever marked finished", () => {
    for (let i = 0; i < 200; i++) log(`live-${i}`)
    expect(deployLogCount()).toBe(DEPLOY_LOG_KEEP)
  })

  test("a finished log past the TTL with no subscriber goes on the next insert", () => {
    const now = Date.now()
    log("stale")
    markDeployLogFinished("stale", now - DEPLOY_LOG_FINISHED_TTL_MS - 1000)
    log("recent")
    markDeployLogFinished("recent", now - 1000)

    log("next")
    expect(deployLogTail("stale")).toEqual([])
    // Within the TTL, the finished page still has its tail to show.
    expect(deployLogTail("recent")).toEqual(["line"])
    expect(deployLogCount()).toBe(2)
  })

  test("a finished log past the TTL is kept while a page is subscribed", () => {
    log("watched")
    markDeployLogFinished(
      "watched",
      Date.now() - DEPLOY_LOG_FINISHED_TTL_MS - 1000,
    )
    const off = subscribeDeployLogs("watched", () => {})
    try {
      log("next")
      expect(deployLogTail("watched")).toEqual(["line"])
    } finally {
      off()
    }
    // Unsubscribed, the next insert takes it.
    log("after")
    expect(deployLogTail("watched")).toEqual([])
  })

  test("a running deploy is kept over finished ones when evicting", () => {
    log("running")
    for (let i = 1; i < DEPLOY_LOG_KEEP; i++) {
      log(`done-${i}`)
      markDeployLogFinished(`done-${i}`)
    }
    expect(deployLogCount()).toBe(DEPLOY_LOG_KEEP)

    log("incoming")
    expect(deployLogCount()).toBe(DEPLOY_LOG_KEEP)
    // The oldest entry is the running one, but a finished one goes instead.
    expect(deployLogTail("running")).toEqual(["line"])
    expect(deployLogTail("done-1")).toEqual([])
    expect(deployLogTail("incoming")).toEqual(["line"])
  })

  test("marking a deployment that logged nothing creates no entry", () => {
    markDeployLogFinished("never-logged")
    expect(deployLogCount()).toBe(0)
  })
})
