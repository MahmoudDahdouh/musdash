import { describe, expect, test } from "bun:test"
import type { VolumeSummary } from "../docker/client.ts"
import {
  isStackVolumeName,
  removableKeptVolume,
  stackVolumesToRemove,
} from "./select.ts"

/**
 * The rules that decide which volumes a delete may destroy. Each case below
 * is a volume that must survive a delete of RID's stack, beside the one that
 * must not.
 */

const RID = "01J9ZX7Q8M5N3P4R6S7T8V9W0X"
const OTHER = "01J9ZX7Q8M5N3P4R6S7T8V9W0Y"
const project = (id: string): string => `musdash-${id.toLowerCase()}`

/** A volume exactly as the Compose transform creates it for `id`. */
function stackVolume(id: string, key: string): VolumeSummary {
  return {
    name: `${project(id)}_${key}`,
    labels: {
      "musdash.managed": "true",
      "musdash.resource_id": id,
      "musdash.project_id": "01J9ZX7Q8M5N3P4R6S7T8V9W1A",
      "musdash.volume": key,
      "com.docker.compose.project": project(id),
    },
  }
}

function withLabels(
  v: VolumeSummary,
  change: Record<string, string | undefined>,
): VolumeSummary {
  const labels: Record<string, string> = { ...v.labels }
  for (const [k, value] of Object.entries(change)) {
    if (value === undefined) delete labels[k]
    else labels[k] = value
  }
  return { name: v.name, labels }
}

const SIDECARS: VolumeSummary[] = [
  { name: "musdash-caddy-data", labels: {} },
  { name: "musdash-caddy-config", labels: {} },
  { name: "musdash-buildkit-cache", labels: {} },
]

const good = stackVolume(RID, "db-data")

/** Every way a volume can look like RID's and still not be one of its stack volumes. */
const impostors: Record<string, VolumeSummary> = {
  "a different resource id": stackVolume(OTHER, "db-data"),
  "the resource id lower-cased": withLabels(good, {
    "musdash.resource_id": RID.toLowerCase(),
  }),
  "musdash.managed missing": withLabels(good, { "musdash.managed": undefined }),
  "musdash.managed not true": withLabels(good, { "musdash.managed": "TRUE" }),
  "a compose project mismatch": withLabels(good, {
    "com.docker.compose.project": project(OTHER),
  }),
  "the name prefixed by another resource id": {
    name: `${project(OTHER)}_db-data`,
    labels: good.labels,
  },
  "musdash.volume not the name's key": withLabels(good, {
    "musdash.volume": "cache",
  }),
}

describe("stackVolumesToRemove", () => {
  test("returns only the volume meeting every rule", () => {
    const list = [...Object.values(impostors), good, ...SIDECARS]
    const { remove, skipped } = stackVolumesToRemove(list, RID)
    expect(remove).toEqual([good])
    expect(skipped).toHaveLength(list.length - 1)
  })

  for (const [why, volume] of Object.entries(impostors)) {
    test(`skips ${why}`, () => {
      expect(stackVolumesToRemove([volume], RID).remove).toEqual([])
    })
  }

  test("skips the three unlabelled sidecar volumes", () => {
    expect(stackVolumesToRemove(SIDECARS, RID).remove).toEqual([])
  })
})

describe("removableKeptVolume", () => {
  const noRow = (): boolean => false

  test("returns the kept volume when its resource is gone", () => {
    expect(removableKeptVolume([good], good.name, noRow)).toEqual({
      name: good.name,
      key: "db-data",
      resourceId: RID,
    })
  })

  test("is null when the volume's resource still has a row", () => {
    expect(removableKeptVolume([good], good.name, (id) => id === RID)).toBe(
      null,
    )
  })

  for (const [why, volume] of Object.entries(impostors)) {
    // "A different resource id" is a valid stack volume of OTHER, so it is
    // the one impostor that IS a kept volume — of OTHER, under its own name.
    if (why === "a different resource id") continue
    test(`is null for ${why}`, () => {
      expect(removableKeptVolume([volume], volume.name, noRow)).toBe(null)
    })
  }

  test("is null for every sidecar name, even with stack labels", () => {
    for (const s of SIDECARS) {
      expect(removableKeptVolume(SIDECARS, s.name, noRow)).toBe(null)
      const dressed = { name: s.name, labels: good.labels }
      expect(removableKeptVolume([dressed], s.name, noRow)).toBe(null)
    }
  })

  test("is null for a name that is not on the list", () => {
    const absent = `${project(RID)}_other`
    expect(removableKeptVolume([good], absent, noRow)).toBe(null)
  })
})

describe("isStackVolumeName", () => {
  test("rejects names that are not a stack volume's", () => {
    for (const name of [
      `musdash-${RID}_data`, // upper-case resource id
      `${project(RID)}_a/b`,
      `${project(RID)}_..`,
      `${project(RID)}_.`,
      `${project(RID)}_`,
      "musdash-caddy-data",
      "",
    ]) {
      expect(isStackVolumeName(name)).toBe(false)
    }
  })

  test("accepts keys starting with . _ and -", () => {
    for (const key of [".env", "_data", "-data", "db-data", "a.b_c-d"]) {
      expect(isStackVolumeName(`${project(RID)}_${key}`)).toBe(true)
    }
  })
})
