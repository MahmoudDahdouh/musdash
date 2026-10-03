import {
  LABEL_RESOURCE,
  type VolumeSummary,
  type VolumeUsage,
} from "../docker/client.ts"
import { docker } from "../docker/impl.ts"
import { getResource } from "../db/queries.ts"
import { logger } from "../log.ts"
import { type KeptVolume, keptVolumes, stackVolumesToRemove } from "./select.ts"
import {
  createVolumeSizeCache,
  VOLUME_SIZES_FAILURE_TTL_MS,
  VOLUME_SIZES_MAX_RESOURCES,
  VOLUME_SIZES_TTL_MS,
  type VolumeSizes,
} from "./sizes.ts"

/**
 * The volume reads the pages make. All read-only and all bounded, so a slow
 * or stopped daemon costs a page a fixed wait rather than holding it — the
 * same rule as the stack page's container list. Removal is never here: it is
 * the queue's (jobs/index.ts), behind select.ts's rules.
 */

/** How long a sizes endpoint waits for the measurement before answering "unknown". */
export const VOLUME_SIZES_ANSWER_MS = 10_000
/** How long a page render waits for a volume list. */
export const VOLUME_LIST_RENDER_MS = 2_000

/**
 * A volume the remove_volume job will not delete: not a stack volume, or one
 * whose resource still exists. Its message goes to the log and the job's
 * last_error, never to the browser.
 */
export class VolumeRefusedError extends Error {
  override readonly name = "VolumeRefusedError"
}

const sizeCache = createVolumeSizeCache({
  ttlMs: VOLUME_SIZES_TTL_MS,
  failureTtlMs: VOLUME_SIZES_FAILURE_TTL_MS,
  maxResources: VOLUME_SIZES_MAX_RESOURCES,
})

const UNKNOWN: VolumeSizes = { known: false }

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * One df, logged here because the cache has no logger. Only counts and the
 * error message are logged — never labels.
 */
async function measure(): Promise<readonly VolumeUsage[]> {
  const started = Date.now()
  try {
    const list = await docker.volumeUsage(LABEL_RESOURCE)
    logger.debug(
      { ms: Date.now() - started, volumes: list.length },
      "measured volume sizes",
    )
    return list
  } catch (err) {
    logger.warn({ err: errMessage(err) }, "could not measure volume sizes")
    throw err
  }
}

/**
 * Every stack volume's size, as of the cached measurement. Answers within
 * VOLUME_SIZES_ANSWER_MS: past that it says "unknown" while the measurement
 * runs on, so the next ask — once it lands — is served from the cache.
 */
export async function volumeSizes(): Promise<VolumeSizes> {
  let timer: Timer | undefined
  const timeout = new Promise<VolumeSizes>((done) => {
    timer = setTimeout(() => {
      logger.warn(
        { err: `no measurement within ${VOLUME_SIZES_ANSWER_MS} ms` },
        "volume sizes answered as unknown",
      )
      done(UNKNOWN)
    }, VOLUME_SIZES_ANSWER_MS)
  })
  try {
    return await Promise.race([sizeCache.get(measure), timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * `work`, or null when it fails or outlasts VOLUME_LIST_RENDER_MS. Null is
 * "could not be read" — the page says so, and never shows it as "none".
 */
async function bounded<T>(work: Promise<T>, what: string): Promise<T | null> {
  let timer: Timer | undefined
  const timeout = new Promise<null>((done) => {
    timer = setTimeout(() => done(null), VOLUME_LIST_RENDER_MS)
  })
  try {
    return await Promise.race([
      work.catch((err: unknown) => {
        logger.debug({ err: errMessage(err) }, `${what} failed`)
        return null
      }),
      timeout,
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The stack's volumes for its page, or null when they could not be listed.
 * Exactly the set a delete-with-volumes would remove — the same rules — so
 * the count the delete card names is the count the job deletes.
 */
export function stackVolumesForPage(
  resourceId: string,
): Promise<VolumeSummary[] | null> {
  return bounded(
    docker
      .listVolumes({ labelKey: LABEL_RESOURCE, labelValue: resourceId })
      .then((list) => stackVolumesToRemove(list, resourceId).remove),
    "volume list for a stack page",
  )
}

/** Volumes left by deleted stacks, for /settings, or null when unreadable. */
export function keptVolumesForPage(): Promise<KeptVolume[] | null> {
  return bounded(
    docker
      .listVolumes({ labelKey: LABEL_RESOURCE })
      .then((list) => keptVolumes(list, (id) => getResource(id) !== undefined)),
    "volume list for settings",
  )
}
