import { describe, expect, test } from "bun:test"
import {
  BUILD_PLACEHOLDER,
  computeKeepSet,
  type KeepSetInput,
} from "./images.ts"

/**
 * What the daily prune keeps of musdash's own builds (D60). Those images are
 * removed whatever their age unless this set names them, and a built image
 * exists nowhere but this server — so a keep-set that drops the wrong one
 * destroys a rollback target or a reusable build permanently, and one that
 * keeps too many fills the disk.
 */

const at = (minute: number) =>
  `2026-09-01T00:${String(minute).padStart(2, "0")}:00.000Z`

function sorted(xs: string[]): string[] {
  return [...xs].sort()
}

describe("computeKeepSet", () => {
  test("current, previous, and the 3 newest distinct succeeded images", () => {
    const input: KeepSetInput = {
      resources: [
        { id: "r1", current: "musdash/app:cur", previous: "musdash/app:prev" },
      ],
      succeeded: [
        { resourceId: "r1", image: "musdash/app:b1", createdAt: at(1) },
        { resourceId: "r1", image: "musdash/app:b2", createdAt: at(2) },
        { resourceId: "r1", image: "musdash/app:b3", createdAt: at(3) },
        { resourceId: "r1", image: "musdash/app:b4", createdAt: at(4) },
        { resourceId: "r1", image: "musdash/app:b5", createdAt: at(5) },
      ],
    }
    expect(sorted(computeKeepSet(input))).toEqual(
      sorted([
        "musdash/app:cur",
        "musdash/app:prev",
        "musdash/app:b5",
        "musdash/app:b4",
        "musdash/app:b3",
      ]),
    )
  })

  test("order comes from createdAt, not from the input", () => {
    const input: KeepSetInput = {
      resources: [{ id: "r1", current: "", previous: null }],
      succeeded: [
        { resourceId: "r1", image: "i4", createdAt: at(4) },
        { resourceId: "r1", image: "i1", createdAt: at(1) },
        { resourceId: "r1", image: "i3", createdAt: at(3) },
        { resourceId: "r1", image: "i2", createdAt: at(2) },
      ],
    }
    expect(sorted(computeKeepSet(input))).toEqual(["i2", "i3", "i4"])
  })

  test("an image named by several rows counts once", () => {
    // A reused image is named by every deployment that reused it; counting rows
    // would let it crowd the older distinct builds out of the limit.
    const input: KeepSetInput = {
      resources: [{ id: "r1", current: "", previous: null }],
      succeeded: [
        { resourceId: "r1", image: "a", createdAt: at(9) },
        { resourceId: "r1", image: "a", createdAt: at(8) },
        { resourceId: "r1", image: "a", createdAt: at(7) },
        { resourceId: "r1", image: "b", createdAt: at(6) },
        { resourceId: "r1", image: "c", createdAt: at(5) },
        { resourceId: "r1", image: "d", createdAt: at(4) },
      ],
    }
    const keep = computeKeepSet(input)
    expect(sorted(keep)).toEqual(["a", "b", "c"])
    expect(keep.length).toBe(new Set(keep).size)
  })

  test("the placeholder and empty strings never appear", () => {
    const input: KeepSetInput = {
      resources: [
        { id: "r1", current: BUILD_PLACEHOLDER, previous: "" },
        { id: "r2", current: "", previous: null },
      ],
      succeeded: [
        { resourceId: "r1", image: BUILD_PLACEHOLDER, createdAt: at(3) },
        { resourceId: "r1", image: "", createdAt: at(2) },
        { resourceId: "r1", image: "x", createdAt: at(1) },
      ],
    }
    expect(computeKeepSet(input)).toEqual(["x"])
  })

  test("rows for a resource that no longer exists are ignored", () => {
    const input: KeepSetInput = {
      resources: [{ id: "r1", current: "keep", previous: null }],
      succeeded: [{ resourceId: "gone", image: "orphan", createdAt: at(1) }],
    }
    expect(computeKeepSet(input)).toEqual(["keep"])
  })

  test("the limit is per resource, and current/previous are on top of it", () => {
    const input: KeepSetInput = {
      resources: [
        { id: "r1", current: "r1:b4", previous: "r1:old" },
        { id: "r2", current: "r2:b1", previous: null },
      ],
      succeeded: [
        { resourceId: "r1", image: "r1:b1", createdAt: at(1) },
        { resourceId: "r1", image: "r1:b2", createdAt: at(2) },
        { resourceId: "r1", image: "r1:b3", createdAt: at(3) },
        { resourceId: "r1", image: "r1:b4", createdAt: at(4) },
        { resourceId: "r2", image: "r2:b1", createdAt: at(5) },
      ],
    }
    expect(sorted(computeKeepSet(input, 2))).toEqual(
      sorted(["r1:b4", "r1:old", "r1:b3", "r2:b1"]),
    )
  })
})
