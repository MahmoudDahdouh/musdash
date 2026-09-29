/**
 * A small in-memory cache of per-installation lists (the repository picker's).
 *
 * Kept free of the logger, config, database and GitHub client — the same split
 * as token-retry.ts — so every rule below is testable with a fake clock and a
 * stub fetch. repos.ts binds one instance to listInstallationRepos.
 *
 * Why cache at all: the project page used to list every installation's
 * repositories from GitHub on every render, which is a paginated round trip per
 * installation per page load. The list changes rarely and GitHub tells us when
 * it does (installation_repositories), so a short TTL plus explicit forgetting
 * on those events is enough.
 *
 * Why it is bounded twice (entries and total items): this lives in the one
 * process whose RSS is capped at 100MB. An installation granting thousands of
 * repositories, or many installations, must not grow it without limit.
 *
 * No timers: expiry is swept lazily on get and store, so an idle dashboard does
 * no work and holds no handle open.
 */

export const REPO_LIST_TTL_MS = 5 * 60_000
export const REPO_LIST_STALE_MAX_AGE_MS = 60 * 60_000
export const REPO_CACHE_MAX_ENTRIES = 16
export const REPO_CACHE_MAX_ITEMS = 5_000

export interface RepoCacheOptions {
  /** A stored list younger than this is served without a fetch. */
  ttlMs: number
  /** How old a list may be and still be served when a refresh fails. Older
   *  entries are dropped. */
  staleMaxAgeMs: number
  maxEntries: number
  /** Across all entries. A single list longer than this is never stored. */
  maxItems: number
  now?: () => number
}

export interface RepoCacheResult<T> {
  items: readonly T[]
  /** Non-null only when a refresh failed and an older list was served. */
  stale: { ageMs: number; error: unknown } | null
}

export interface RepoCache<T> {
  get(
    id: number,
    fetch: () => Promise<readonly T[]>,
  ): Promise<RepoCacheResult<T>>
  forget(id: number): void
  clear(): void
  stats(): { entries: number; items: number }
}

interface Entry<T> {
  items: readonly T[]
  fetchedAt: number
}

export function createRepoCache<T>(options: RepoCacheOptions): RepoCache<T> {
  const now = options.now ?? Date.now
  const entries = new Map<number, Entry<T>>()
  /**
   * Fetches in progress, keyed by id — what stops N concurrent renders (or a
   * render racing a deploy's picker) from paginating the same list N times.
   */
  const inFlight = new Map<number, Promise<RepoCacheResult<T>>>()
  /**
   * Bumped by forget() and clear(). A fetch that started before either must not
   * store its result afterwards: it was made under a grant (or an App) that the
   * forget said no longer holds, and storing it would resurrect exactly the
   * list the forget was meant to drop.
   */
  let epoch = 0

  function totalItems(): number {
    let total = 0
    for (const entry of entries.values()) total += entry.items.length
    return total
  }

  function sweep(at: number): void {
    for (const [id, entry] of entries) {
      if (at - entry.fetchedAt > options.staleMaxAgeMs) entries.delete(id)
    }
  }

  function evictOldest(): void {
    let oldestId: number | null = null
    let oldestAt = Number.POSITIVE_INFINITY
    for (const [id, entry] of entries) {
      if (entry.fetchedAt < oldestAt) {
        oldestAt = entry.fetchedAt
        oldestId = id
      }
    }
    if (oldestId !== null) entries.delete(oldestId)
  }

  function store(id: number, items: readonly T[]): void {
    const at = now()
    sweep(at)
    if (items.length > options.maxItems) {
      // Too large to keep under the budget. Dropping the older entry too is
      // deliberate: it no longer describes the grant, and serving it as stale
      // on a later failure would show a list GitHub has since contradicted.
      entries.delete(id)
      return
    }
    entries.set(id, { items, fetchedAt: at })
    while (
      entries.size > options.maxEntries ||
      totalItems() > options.maxItems
    ) {
      evictOldest()
    }
  }

  async function refresh(
    id: number,
    fetch: () => Promise<readonly T[]>,
    startedEpoch: number,
  ): Promise<RepoCacheResult<T>> {
    try {
      // Wrapped so a fetch that throws synchronously rejects like any other
      // failure instead of escaping get().
      const items = await new Promise<readonly T[]>((resolve) => {
        resolve(fetch())
      })
      if (epoch === startedEpoch) store(id, items)
      return { items, stale: null }
    } catch (error) {
      // A failure is never cached, so the next get tries GitHub again. The
      // entry is re-read here rather than captured at the start, because
      // another fetch for the same id may have stored a newer list meanwhile.
      const previous = entries.get(id)
      if (previous) {
        const ageMs = now() - previous.fetchedAt
        if (ageMs <= options.staleMaxAgeMs) {
          return { items: previous.items, stale: { ageMs, error } }
        }
      }
      throw error
    }
  }

  return {
    get(id, fetch) {
      // The cache check and the inFlight.set below MUST stay in one synchronous
      // block, as in tokens.ts: they are atomic only because nothing awaits
      // between them, and an await here reintroduces the duplicate fetch.
      const at = now()
      sweep(at)
      const hit = entries.get(id)
      if (hit && at - hit.fetchedAt < options.ttlMs) {
        return Promise.resolve({ items: hit.items, stale: null })
      }

      const pending = inFlight.get(id)
      if (pending) return pending

      const promise: Promise<RepoCacheResult<T>> = refresh(
        id,
        fetch,
        epoch,
      ).finally(() => {
        // Compare-and-delete: a forget() during this fetch may already have
        // removed this record and a newer get started another. Deleting
        // unconditionally would drop THAT one and let a third fetch start.
        if (inFlight.get(id) === promise) inFlight.delete(id)
      })
      inFlight.set(id, promise)
      return promise
    },

    forget(id) {
      entries.delete(id)
      inFlight.delete(id)
      epoch++
    },

    clear() {
      entries.clear()
      inFlight.clear()
      epoch++
    },

    stats() {
      return { entries: entries.size, items: totalItems() }
    },
  }
}
