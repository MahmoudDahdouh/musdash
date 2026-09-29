import { afterAll, describe, expect, test } from "bun:test"
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  SCAN_LIMITS,
  type SourceFindings,
  scanUnsupportedSource,
  UnsupportedSourceError,
  unsupportedSourceMessage,
} from "./unsupported-source.ts"

/**
 * The scanner runs over a tree anyone who can push to the repository controls,
 * so the tests below are as much about what it must NOT report or follow as
 * about what it finds: a false refusal blocks a working deploy, and a followed
 * symlink reads outside the build dir.
 */

const temps: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "musdash-unsupported-"))
  temps.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

/** A temp repository holding `files` (repo-relative path → content). */
function repo(files: Record<string, string> = {}): string {
  const root = tempDir()
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  return root
}

const OID = "4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393"
const POINTER = `version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\nsize 12345\n`
const LFS_ATTRS = "*.bin filter=lfs diff=lfs merge=lfs -text\n"

const NONE: SourceFindings = {
  submodules: [],
  submoduleCount: 0,
  lfsPointers: [],
  lfsPointerCount: 0,
  truncated: null,
}

function gitmodules(...paths: string[]): string {
  return paths
    .map(
      (p, i) => `[submodule "m${i}"]\n\tpath = ${p}\n\turl = https://x/${i}\n`,
    )
    .join("")
}

describe("submodules", () => {
  test("1. empty, comment-only, or path-less .gitmodules finds nothing", async () => {
    for (const text of [
      "",
      "# a comment\n; another\n",
      '[submodule "lib"]\n\turl = https://github.com/o/lib\n',
    ]) {
      const root = repo({ ".gitmodules": text })
      expect(await scanUnsupportedSource(root, root)).toEqual(NONE)
    }
  })

  test("2. a submodule path that has content is not reported", async () => {
    const root = repo({
      ".gitmodules": gitmodules("vendor/lib"),
      "vendor/lib/index.js": "x\n",
    })
    expect(await scanUnsupportedSource(root, root)).toEqual(NONE)
  })

  test("3. a missing or empty submodule path is reported", async () => {
    const missing = repo({ ".gitmodules": gitmodules("vendor/lib") })
    const empty = repo({ ".gitmodules": gitmodules("vendor/lib") })
    mkdirSync(join(empty, "vendor/lib"), { recursive: true })
    for (const root of [missing, empty]) {
      const f = await scanUnsupportedSource(root, root)
      expect(f.submodules).toEqual(["vendor/lib"])
      expect(f.submoduleCount).toBe(1)
      expect(f.truncated).toBeNull()
    }

    // The git-config forms real .gitmodules files use: a quoted value, an
    // upper-case key, a trailing comment, and a later path overriding.
    const forms = repo({
      ".gitmodules":
        '[submodule "a"]\n  PATH = "vendor/lib"\n' +
        '[submodule "b"]\npath=vendor/other ; comment\n' +
        '[submodule "c"]\npath = wrong\npath = vendor/last/\n',
    })
    expect((await scanUnsupportedSource(forms, forms)).submodules).toEqual([
      "vendor/lib",
      "vendor/other",
      "vendor/last",
    ])
  })

  test("4. only submodules at or under the build context count", async () => {
    const root = repo({
      ".gitmodules": gitmodules("libs/x", "apps/web/lib", "apps/web"),
    })
    // apps/web does not exist at all: the check is path arithmetic.
    const f = await scanUnsupportedSource(root, join(root, "apps/web"))
    expect(f.submodules).toEqual(["apps/web/lib", "apps/web"])
    expect(f.submoduleCount).toBe(2)
  })

  test("5. escaping paths, symlinked ancestors and a symlinked .gitmodules are ignored", async () => {
    const outside = tempDir()
    mkdirSync(join(outside, "sub"))
    const root = repo({
      ".gitmodules": gitmodules("/abs/path", "../outside", "link/sub"),
    })
    // Followed, link/sub would be an empty directory — a live submodule.
    symlinkSync(outside, join(root, "link"))
    expect(await scanUnsupportedSource(root, root)).toEqual(NONE)

    const linked = repo()
    writeFileSync(join(outside, "gitmodules"), gitmodules("missing"))
    symlinkSync(join(outside, "gitmodules"), join(linked, ".gitmodules"))
    expect(await scanUnsupportedSource(linked, linked)).toEqual(NONE)
  })
})

describe("LFS pointers", () => {
  test("6. a pointer in the context is reported when root .gitattributes enables LFS", async () => {
    const root = repo({
      ".gitattributes": LFS_ATTRS,
      "assets/a.bin": POINTER,
    })
    const f = await scanUnsupportedSource(root, root)
    expect(f.lfsPointers).toEqual(["assets/a.bin"])
    expect(f.lfsPointerCount).toBe(1)
    expect(f.truncated).toBeNull()
  })

  test("7. files that are not valid pointers are not reported", async () => {
    const root = repo({
      ".gitattributes": LFS_ATTRS,
      "real.bin": `${"binary content ".repeat(20)}\n`,
      "bad-oid.bin": POINTER.replace(OID, "not-a-sha256-oid".padEnd(64, "z")),
      "big.bin": `${POINTER}${"x".repeat(1024)}`,
    })
    expect(await scanUnsupportedSource(root, root)).toEqual(NONE)
  })

  test("8. without LFS in the ROOT .gitattributes, pointers are not looked for", async () => {
    // Fail-open by design (D61): nested .gitattributes are not consulted, so a
    // repository enabling LFS only below the root deploys as before.
    const noAttrs = repo({ "a.bin": POINTER })
    const noFilter = repo({
      ".gitattributes": "*.txt text\n",
      "a.bin": POINTER,
    })
    const nested = repo({
      "apps/web/.gitattributes": LFS_ATTRS,
      "apps/web/a.bin": POINTER,
    })
    expect(await scanUnsupportedSource(noAttrs, noAttrs)).toEqual(NONE)
    expect(await scanUnsupportedSource(noFilter, noFilter)).toEqual(NONE)
    expect(
      await scanUnsupportedSource(nested, join(nested, "apps/web")),
    ).toEqual(NONE)
  })

  test("9. pointers outside the context or under .git are not reported", async () => {
    const root = repo({
      ".gitattributes": LFS_ATTRS,
      "other/a.bin": POINTER,
      "apps/web/index.js": "x\n",
    })
    expect(await scanUnsupportedSource(root, join(root, "apps/web"))).toEqual(
      NONE,
    )

    const withGit = repo({
      ".gitattributes": LFS_ATTRS,
      ".git/lfs/a.bin": POINTER,
      "src/.git/b.bin": POINTER,
    })
    expect(await scanUnsupportedSource(withGit, withGit)).toEqual(NONE)
  })

  test("10. symlinks are never followed, and a link loop terminates", async () => {
    const outside = repo({ "a.bin": POINTER })
    const root = repo({ ".gitattributes": LFS_ATTRS })
    symlinkSync(outside, join(root, "elsewhere"))
    symlinkSync(join(outside, "a.bin"), join(root, "direct.bin"))
    mkdirSync(join(root, "dir"))
    symlinkSync("..", join(root, "dir/loop"))
    expect(await scanUnsupportedSource(root, root)).toEqual(NONE)
  })

  test("a symlinked .gitattributes or a build context through a symlink is not walked", async () => {
    // Both would otherwise let the tree steer the scan outside itself.
    const outside = repo({ ".gitattributes": LFS_ATTRS, "a.bin": POINTER })
    const linkedAttrs = repo({ "a.bin": POINTER })
    symlinkSync(
      join(outside, ".gitattributes"),
      join(linkedAttrs, ".gitattributes"),
    )
    expect(await scanUnsupportedSource(linkedAttrs, linkedAttrs)).toEqual(NONE)

    const linkedContext = repo({ ".gitattributes": LFS_ATTRS })
    symlinkSync(outside, join(linkedContext, "app"))
    for (const context of ["app", "app/sub"]) {
      expect(
        await scanUnsupportedSource(
          linkedContext,
          join(linkedContext, context),
        ),
      ).toEqual(NONE)
    }
  })

  test("11. the entry and hit limits stop the scan without throwing", async () => {
    const files: Record<string, string> = { ".gitattributes": LFS_ATTRS }
    for (let i = 0; i < 10; i++) files[`f${i}.txt`] = "x\n"
    // The pointer is in a subdirectory, so the ten files and .gitattributes
    // at the root are all examined before the walk could reach it.
    files["z/a.bin"] = POINTER
    const many = repo(files)
    const limited = await scanUnsupportedSource(many, many, {
      ...SCAN_LIMITS,
      maxEntries: 5,
    })
    expect(limited.truncated).toBe("entries")
    expect(limited.lfsPointers).toEqual([])
    expect(limited.lfsPointerCount).toBe(0)

    const five = repo({
      ".gitattributes": LFS_ATTRS,
      "a/1.bin": POINTER,
      "a/2.bin": POINTER,
      "b/3.bin": POINTER,
      "b/4.bin": POINTER,
      "5.bin": POINTER,
    })
    const f = await scanUnsupportedSource(five, five, {
      ...SCAN_LIMITS,
      maxHits: 3,
    })
    expect(f.lfsPointers).toHaveLength(3)
    expect(f.lfsPointerCount).toBe(5)
    expect(f.truncated).toBeNull()
  })

  test("12. a build context that does not exist finds nothing", async () => {
    const root = repo({ ".gitattributes": LFS_ATTRS, "a.bin": POINTER })
    expect(await scanUnsupportedSource(root, join(root, "nope/web"))).toEqual(
      NONE,
    )
  })
})

describe("unsupportedSourceMessage", () => {
  test("13. exact text, sanitised paths, and the typed error", () => {
    const submodule: SourceFindings = {
      ...NONE,
      submodules: ["vendor/lib"],
      submoduleCount: 1,
    }
    expect(unsupportedSourceMessage(submodule)).toBe(
      "This repository uses Git submodules (`vendor/lib`), which musdash does not fetch yet: GitHub's archive leaves them empty. Vendor the submodule's files into the repository, or remove the submodule, to deploy.",
    )

    const lfs: SourceFindings = {
      ...NONE,
      lfsPointers: ["assets/a.bin", "assets/b.bin", "assets/c.bin"],
      lfsPointerCount: 7,
    }
    expect(unsupportedSourceMessage(lfs)).toBe(
      "This repository stores files with Git LFS (`assets/a.bin` and 6 more are LFS pointers, not the files). musdash does not fetch Git LFS files yet.",
    )

    const both: SourceFindings = {
      submodules: ["a", "b"],
      submoduleCount: 2,
      lfsPointers: ["x.bin"],
      lfsPointerCount: 1,
      truncated: null,
    }
    expect(unsupportedSourceMessage(both)).toBe(
      "This repository uses Git submodules (`a` and 1 more), which musdash does not fetch yet: GitHub's archive leaves them empty. Vendor the submodule's files into the repository, or remove the submodule, to deploy. This repository stores files with Git LFS (`x.bin` is an LFS pointer, not the file). musdash does not fetch Git LFS files yet.",
    )

    const newline: SourceFindings = {
      ...NONE,
      submodules: ["evil\nDeploy succeeded"],
      submoduleCount: 1,
    }
    const message = unsupportedSourceMessage(newline)
    expect(message).toContain("(`evil?Deploy succeeded`)")
    expect(message).not.toContain("\n")

    const shown = (path: string): string =>
      unsupportedSourceMessage({
        ...NONE,
        submodules: [path],
        submoduleCount: 1,
      })
    // Bidi overrides and C1 controls could make the line read as something
    // else without adding a line; long paths are cut at 120 characters.
    expect(shown("a\u202Eb\u0085c\u2028d")).toContain("(`a?b?c?d`)")
    const long = shown("x".repeat(200))
    expect(long).toContain(`(\`${"x".repeat(117)}...\`)`)

    const err = new UnsupportedSourceError(both)
    expect(err.message).toBe(unsupportedSourceMessage(both))
    expect(err.name).toBe("UnsupportedSourceError")
    expect(err.findings).toBe(both)
    expect(err).toBeInstanceOf(Error)
  })
})
