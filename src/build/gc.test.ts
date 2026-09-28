import { describe, expect, test } from "bun:test"
import { gcKeepStorage } from "./gc.ts"

/**
 * buildkitd reads --oci-worker-gc-keepstorage as "Reserved,Free,Maximum". The
 * two-field form musdash used put the cache ceiling in the Free slot, so the
 * daemon kept 10 GB of the DISK free instead of capping its cache at 10 GB,
 * and on the 2GB host's 19 GB disk it emptied the cache after every build
 * (T-2). `buildctl debug workers -v` there printed "Minimum free space:
 * 10.24GB" and no maximum.
 */
describe("gcKeepStorage", () => {
  test("the cache ceiling is the third field, the Maximum", () => {
    const [reserved, free, maximum] = gcKeepStorage(10).split(",")
    expect(maximum).toBe("10240")
    expect(reserved).toBe("2560")
    // No free-space target: the prune job and the ceiling bound the disk.
    expect(free).toBe("0")
  })

  test("no field is empty, which buildkitd refuses to parse", () => {
    for (const field of gcKeepStorage(1).split(",")) {
      expect(field).toMatch(/^\d+$/)
    }
  })
})
