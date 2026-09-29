import { shortId } from "../ids.ts"

/**
 * Naming and retention of the images musdash builds. Pure: no database, no
 * Docker, so the retention rule can be tested without either.
 */

/**
 * What a deployment row names as its image until a build has produced one.
 *
 * Every deploy that builds is enqueued with this, never with the image already
 * running: a build that failed left that image on its row, so the one deploy
 * that produced nothing named an image that works (P-2). The pages render it
 * as "Building…" or, once the deploy has ended, "Not built" (P-11).
 */
export const BUILD_PLACEHOLDER = "(building)"

/**
 * How many distinct succeeded builds of one resource the prune keeps, on top of
 * the image it runs and its rollback target (D60).
 *
 * Three, because each one is a full image on a disk that is usually small, and
 * a push that matches an older build (a revert, a redelivered webhook) is the
 * only thing that reaches further back than the rollback target.
 */
export const RETAINED_BUILDS = 3

/**
 * Exactly the tags builtImageTag produces: a resource slug (the slug rule,
 * `^[a-z0-9-]{1,32}$`, RESOURCE_NAME_RE in src/docker/client.ts — kept in step
 * by hand, since this module imports only ids.ts; a rule that widened without
 * this would only drop longer slugs back to the 168h rule) and shortId
 * of a ULID — its last 8 characters,
 * lowercased, all from the random part and so all from Crockford's alphabet,
 * which has no i, l, o or u.
 *
 * Exact rather than loose because the prune removes every image this matches
 * whatever its age: a user's own image that happened to look like
 * `musdash/x:anything` must not be caught by it. No `g` flag — a global RegExp
 * carries lastIndex between .test() calls and would skip every other match.
 */
export const BUILT_IMAGE_TAG =
  /^musdash\/[a-z0-9-]{1,32}:[0-9a-hjkmnp-tv-z]{8}$/

/**
 * The tag a build of this deployment produces.
 *
 * It embeds the deployment id, so every build is a distinct reference and a
 * rollback has something to point AT. A single moving tag would make rollback
 * meaningless: both deployments would name the same image.
 */
export function builtImageTag(
  resourceSlug: string,
  deploymentId: string,
): string {
  return `musdash/${resourceSlug}:${shortId(deploymentId)}`
}

export function isBuiltImageTag(image: string): boolean {
  return BUILT_IMAGE_TAG.test(image)
}

export interface KeepSetInput {
  resources: ReadonlyArray<{
    id: string
    current: string
    previous: string | null
  }>
  succeeded: ReadonlyArray<{
    resourceId: string
    image: string
    createdAt: string
  }>
}

/**
 * Every image reference the prune must not delete.
 *
 * Per resource: what it runs now, its rollback target, and its newest
 * `perResource` DISTINCT succeeded images. Distinct, because a reused image is
 * named by several rows — counting rows would let one popular image crowd out
 * the others the limit is meant to keep.
 *
 * Sorted here by createdAt, never trusting the caller's order: a keep-set that
 * silently kept the oldest builds would look right on every host until the
 * first prune after an unordered query.
 *
 * Rows for a resource that no longer exists are ignored, so deleting a
 * resource releases its images to the prune. The placeholder is never a
 * reference, and never kept.
 */
export function computeKeepSet(
  input: KeepSetInput,
  perResource: number = RETAINED_BUILDS,
): string[] {
  const keep = new Set<string>()
  const usable = (image: string | null): image is string =>
    image !== null && image !== "" && image !== BUILD_PLACEHOLDER

  const byResource = new Map<
    string,
    Array<{ image: string; createdAt: string }>
  >()
  for (const r of input.resources) {
    if (usable(r.current)) keep.add(r.current)
    if (usable(r.previous)) keep.add(r.previous)
    byResource.set(r.id, [])
  }
  for (const row of input.succeeded) {
    if (!usable(row.image)) continue
    byResource.get(row.resourceId)?.push(row)
  }

  for (const rows of byResource.values()) {
    // ISO-8601 timestamps sort lexically in time order.
    rows.sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
    )
    const retained = new Set<string>()
    for (const row of rows) {
      if (retained.size >= perResource) break
      retained.add(row.image)
    }
    for (const image of retained) keep.add(image)
  }
  return [...keep]
}
