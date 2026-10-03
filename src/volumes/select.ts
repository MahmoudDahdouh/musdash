import {
  LABEL_COMPOSE_PROJECT,
  LABEL_MANAGED,
  LABEL_RESOURCE,
  LABEL_VOLUME,
  type VolumeSummary,
} from "../docker/client.ts"
import { composeProject } from "../jobs/compose-plan.ts"

/**
 * Which volumes a delete may remove — the privilege boundary of S4.
 *
 * Pure: no Docker, database, logger or clock, so every rule is tested on
 * plain lists. Removing a volume destroys data no deploy can bring back, so a
 * volume qualifies only when its NAME and every one of its LABELS agree that
 * it is a named volume of exactly this stack. Any one rule alone could be
 * fooled — a hand-made volume can carry any labels, and a stack file can name
 * a volume anything — but together they describe only what musdash's own
 * Compose transform creates. The shared sidecar volumes
 * (musdash-caddy-data, musdash-caddy-config, musdash-buildkit-cache) carry no
 * labels and fail the name pattern, so no rule here can reach them.
 */

/**
 * `<composeProject(resourceId)>_<key>`: the name Compose gives a named volume.
 * The id part is a lower-cased ULID (Crockford base32, no I L O U); the key is
 * what Compose allows in a volume key, bounded.
 */
export const STACK_VOLUME_RE =
  /^musdash-[0-9a-hjkmnp-tv-z]{26}_[a-zA-Z0-9._-]{1,200}$/

/** A resource id as ids.ts makes it: an upper-case ULID. */
export const RESOURCE_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/

/** Where the key starts: after `musdash-`, 26 id characters, and `_`. */
const KEY_OFFSET = "musdash-".length + 26 + 1

/**
 * Whether `name` has the shape of a stack volume. The pattern admits `.` and
 * `..` as keys, which are path segments rather than names — refused here so
 * no later step ever has to reason about one.
 */
/**
 * The resource id inside a name that passed isStackVolumeName: composeProject
 * lower-cases the id, and a resource id is upper-case.
 */
export function stackVolumeResourceId(name: string): string {
  return name.slice("musdash-".length, KEY_OFFSET - 1).toUpperCase()
}

export function isStackVolumeName(name: string): boolean {
  if (!STACK_VOLUME_RE.test(name)) return false
  const key = name.slice(KEY_OFFSET)
  return key !== "." && key !== ".."
}

/** Every rule, for one volume against one resource id. */
function isVolumeOf(volume: VolumeSummary, resourceId: string): boolean {
  if (!RESOURCE_ID_RE.test(resourceId)) return false
  const labels = volume.labels
  const project = composeProject(resourceId)
  const key = labels[LABEL_VOLUME]
  return (
    labels[LABEL_RESOURCE] === resourceId &&
    labels[LABEL_MANAGED] === "true" &&
    labels[LABEL_COMPOSE_PROJECT] === project &&
    isStackVolumeName(volume.name) &&
    typeof key === "string" &&
    volume.name === `${project}_${key}`
  )
}

/**
 * The volumes a delete-with-volumes of `resourceId` removes. A volume
 * qualifies only if ALL hold: `musdash.resource_id` is exactly `resourceId`
 * (case-sensitive); `musdash.managed` is "true"; `com.docker.compose.project`
 * is the resource's Compose project; the name matches STACK_VOLUME_RE; and
 * the name is that project plus `_` plus its `musdash.volume` key. Everything
 * else is returned in `skipped`, for the caller to log and leave alone.
 */
export function stackVolumesToRemove(
  list: readonly VolumeSummary[],
  resourceId: string,
): { remove: VolumeSummary[]; skipped: VolumeSummary[] } {
  const remove: VolumeSummary[] = []
  const skipped: VolumeSummary[] = []
  for (const volume of list) {
    if (isVolumeOf(volume, resourceId)) remove.push(volume)
    else skipped.push(volume)
  }
  return { remove, skipped }
}

/** A stack volume whose resource has been deleted. */
export interface KeptVolume {
  name: string
  /** Its key in the Compose file it came from. */
  key: string
  resourceId: string
}

/**
 * Volumes left behind by deleted stacks: those meeting every rule of
 * stackVolumesToRemove for the id in their own label, where that id is a
 * resource id and `hasRow` says no resource has it. Sorted by name, so the
 * Settings list is stable between renders.
 */
export function keptVolumes(
  list: readonly VolumeSummary[],
  hasRow: (id: string) => boolean,
): KeptVolume[] {
  const out: KeptVolume[] = []
  for (const volume of list) {
    const resourceId = volume.labels[LABEL_RESOURCE]
    const key = volume.labels[LABEL_VOLUME]
    if (typeof resourceId !== "string" || typeof key !== "string") continue
    if (!isVolumeOf(volume, resourceId)) continue
    if (hasRow(resourceId)) continue
    out.push({ name: volume.name, key, resourceId })
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * remove_volume's gate: the kept volume named exactly `name`, or null when
 * there is none — not on the list, a live resource's, or failing any rule.
 */
export function removableKeptVolume(
  list: readonly VolumeSummary[],
  name: string,
  hasRow: (id: string) => boolean,
): KeptVolume | null {
  if (!isStackVolumeName(name)) return null
  return (
    keptVolumes(
      list.filter((v) => v.name === name),
      hasRow,
    )[0] ?? null
  )
}
