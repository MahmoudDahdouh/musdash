import type { Refusal } from "../compose/types.ts"

/**
 * A refused Compose form, kept for one render so the textarea comes back with
 * what the user pasted (docs/PHASE-3-PLAN.md §3.11).
 *
 * Server-side and keyed by session, never in the URL: the file can hold
 * secrets and runs to 64 KiB, and a URL ends up in history and access logs.
 * Bounded twice, because it is resident memory: at most MAX_DRAFTS entries
 * (the oldest goes first), each living TTL_MS, and read once — the render
 * that shows it removes it.
 */

const MAX_DRAFTS = 32
const TTL_MS = 10 * 60 * 1000

/** Where the draft came from, so only that page shows it. */
export type DraftTarget =
  | { kind: "create"; environmentId: string }
  | { kind: "settings"; resourceId: string }

export interface ComposeDraft {
  target: DraftTarget
  /** The resource name typed on the create form; "" for settings. */
  name: string
  text: string
  publicService: string
  /** As submitted, so the field shows exactly what was typed. */
  publicPort: string
  /** As submitted; "" when absent. */
  healthPath: string
  /**
   * The first refusal; the form names it. Null when the file passed and the
   * public service or its port was the problem — the error key says which.
   */
  refusal: Refusal | null
  at: number
}

const drafts = new Map<string, ComposeDraft>()

export function saveComposeDraft(
  sessionId: string,
  draft: Omit<ComposeDraft, "at">,
  now = Date.now(),
): void {
  // Re-inserted at the end, so Map order stays oldest-first.
  drafts.delete(sessionId)
  drafts.set(sessionId, { ...draft, at: now })
  for (const [key, d] of drafts) {
    if (drafts.size <= MAX_DRAFTS && now - d.at <= TTL_MS) break
    drafts.delete(key)
  }
}

/**
 * The session's draft for this target, removed as it is read; undefined when
 * there is none, it has expired, or it belongs to another page (then it is
 * left for that page).
 */
export function takeComposeDraft(
  sessionId: string,
  matches: (target: DraftTarget) => boolean,
  now = Date.now(),
): ComposeDraft | undefined {
  const draft = drafts.get(sessionId)
  if (draft === undefined) return undefined
  if (now - draft.at > TTL_MS) {
    drafts.delete(sessionId)
    return undefined
  }
  if (!matches(draft.target)) return undefined
  drafts.delete(sessionId)
  return draft
}

/** For tests. */
export function composeDraftCount(): number {
  return drafts.size
}
