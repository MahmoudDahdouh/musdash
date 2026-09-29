import { afterAll, describe, expect, test } from "bun:test"
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type AutoWebpackSkip,
  type AutoWebpackStep,
  belowTurbopackCap,
  decideAutoWebpack,
  type NextProjectFacts,
  nextMajorFromSpec,
  type PackageJsonRead,
  parseRailpackInfo,
  type RailpackInfo,
  readPackageJson,
  readPackageLock,
  resolveAutoWebpack,
  TURBOPACK_MIN_BYTES,
} from "./next-webpack.ts"

/**
 * The switch rewrites a user's build command, so both directions matter: a
 * switch on Next.js 15 or older breaks a build that would have worked (the
 * flag does not exist there), and a switch past a script the rewrite cannot
 * reproduce drops what the script did. Every "no" below is one of those.
 */

const MIB = 1024 * 1024

describe("belowTurbopackCap", () => {
  test("false when the cap is unknown or large enough", () => {
    for (const v of [null, 0, Number.NaN, 1434 * MIB, 2048 * MIB]) {
      expect(belowTurbopackCap(v)).toBe(false)
    }
    expect(TURBOPACK_MIN_BYTES).toBe(1434 * MIB)
  })

  test("true below 1434 MiB", () => {
    for (const mib of [960, 1280, 1433]) {
      expect(belowTurbopackCap(mib * MIB)).toBe(true)
    }
  })
})

describe("nextMajorFromSpec", () => {
  test("reads the major of a single comparator", () => {
    for (const spec of [
      "^16.0.1",
      "~16.1.0",
      "16.0.3",
      ">=16",
      "16.x",
      "16.0.0-canary.3",
    ]) {
      expect(nextMajorFromSpec(spec)).toBe(16)
    }
    expect(nextMajorFromSpec("^15.5.0")).toBe(15)
    expect(nextMajorFromSpec(">=15")).toBe(15)
  })

  test("null for anything that does not pin a major for certain", () => {
    for (const spec of [
      "latest",
      "canary",
      "*",
      "workspace:^16",
      "catalog:",
      "npm:next@16.0.0",
      "github:vercel/next.js",
      "https://example.com/next-16.0.0.tgz",
      "^15 || ^16",
      ">=16 <17",
      "",
    ]) {
      expect(nextMajorFromSpec(spec)).toBeNull()
    }
  })
})

/** What railpack 0.37.0 reports for a plain npm Next.js app. */
const NPM_INFO: RailpackInfo = {
  providers: ["node"],
  nodePackageManager: "npm",
  buildCommands: ["npm run build"],
}

interface Fixture {
  limitBytes?: number | null
  buildEnv?: Record<string, string>
  pkg?: Record<string, unknown>
  scripts?: Record<string, string>
  next?: string | null
  info?: Partial<RailpackInfo> | null
  packageLock?: unknown
}

/**
 * Criterion 3's fixture: 960 MiB, `next: ^16.0.1`, `build: next build`, no
 * lock, and Railpack reporting a plain npm Node app. Every fact is supplied,
 * so the decision never asks for one.
 */
function decide(f: Fixture = {}): AutoWebpackStep {
  const scripts = f.scripts ?? { build: "next build" }
  const next = f.next === undefined ? "^16.0.1" : f.next
  const packageJson = {
    name: "app",
    scripts,
    dependencies: next === null ? { react: "^19.0.0" } : { next },
    ...f.pkg,
  }
  return decideAutoWebpack({
    limitBytes: f.limitBytes === undefined ? 960 * MIB : f.limitBytes,
    buildEnv: f.buildEnv ?? {},
    facts: {
      packageJson: { kind: "json", value: packageJson },
      railpackInfo: f.info === null ? null : { ...NPM_INFO, ...f.info },
      packageLock: f.packageLock === undefined ? null : f.packageLock,
    },
  })
}

function lockWith(version: string) {
  return {
    lockfileVersion: 3,
    packages: { "": {}, "node_modules/next": { version } },
  }
}

describe("decideAutoWebpack", () => {
  test("switches a plain Next.js 16 build on a small cap", () => {
    expect(decide()).toEqual({
      switch: true,
      buildCmd: "next build --webpack",
      nextMajor: 16,
      capMib: 960,
    })
    expect(decide({ scripts: { build: "next build --debug" } })).toEqual({
      switch: true,
      buildCmd: "next build --debug --webpack",
      nextMajor: 16,
      capMib: 960,
    })
  })

  test("each condition alone stops the switch", () => {
    // Each case also names the reason, so a case cannot pass by tripping an
    // earlier, unrelated check.
    const cases: [Fixture, AutoWebpackSkip][] = [
      [{ limitBytes: null }, "cap-unknown"],
      [{ limitBytes: 1434 * MIB }, "cap-large"],
      [{ buildEnv: { RAILPACK_BUILD_CMD: "npm run build" } }, "user-build-cmd"],
      [{ buildEnv: { RAILPACK_BUILD_CMD: "" } }, "user-build-cmd"],
      [{ next: "^15.5.0" }, "next-below-16"],
      [{ packageLock: lockWith("15.5.4") }, "next-below-16"],
      [{ next: null }, "no-next"],
      [{ scripts: { build: "next build --webpack" } }, "build-script"],
      [{ scripts: { build: "next build --turbopack" } }, "build-script"],
      [{ scripts: { build: "next build --turbo" } }, "build-script"],
      [{ scripts: { build: "next build --turbo=true" } }, "build-script"],
      [{ scripts: { build: "turbo run build" } }, "build-script"],
      [{ scripts: { build: "npm run lint && next build" } }, "build-script"],
      [{ scripts: { build: "NODE_OPTIONS=x next build" } }, "build-script"],
      [{ scripts: { build: "next build -d" } }, "build-script"],
      [
        { scripts: { build: "next build", prebuild: "echo pre" } },
        "pre-post-script",
      ],
      [
        { scripts: { build: "next build", postbuild: "echo post" } },
        "pre-post-script",
      ],
      // Railpack reports `yarnberry` for a .yarnrc.yml as well as for this.
      [{ info: { nodePackageManager: "yarnberry" } }, "yarn-berry"],
      [{ pkg: { packageManager: "yarn@4.1.0" } }, "yarn-berry"],
      // A railpack.json (or RAILPACK_CONFIG_FILE) that sets the build step:
      // the plan's build command is no longer the default one.
      [{ info: { buildCommands: ["sh -c 'echo hi'"] } }, "railpack-config"],
      // Another provider wins before Node: RAILPACK_BUILD_CMD would replace
      // a Go or Python build command.
      [{ info: { providers: ["golang"] } }, "other-provider"],
      [{ info: { providers: ["python", "node"] } }, "other-provider"],
      [{ info: { providers: [] } }, "other-provider"],
      [{ info: null }, "railpack-info-unusable"],
      [{ info: { nodePackageManager: null } }, "railpack-info-unusable"],
      // Each override form can pin Next.js 15 behind the ^16 range.
      [{ pkg: { overrides: { next: "15.5.4" } } }, "next-overridden"],
      [{ pkg: { pnpm: { overrides: { next: "15.5.4" } } } }, "next-overridden"],
      [
        { pkg: { pnpm: { overrides: { "next@*": "15.5.4" } } } },
        "next-overridden",
      ],
      [{ pkg: { resolutions: { next: "15.5.4" } } }, "next-overridden"],
      [{ pkg: { resolutions: { "**/next": "15.5.4" } } }, "next-overridden"],
      [
        { pkg: { optionalDependencies: { next: "15.5.4" } } },
        "next-overridden",
      ],
    ]
    for (const [c, reason] of cases) {
      expect({ c, d: decide(c) }).toEqual({
        c,
        d: { switch: false, reason },
      })
    }
    const base = { limitBytes: 960 * MIB, buildEnv: {} }
    expect(
      decideAutoWebpack({
        ...base,
        facts: { packageJson: { kind: "absent" } },
      }),
    ).toEqual({ switch: false, reason: "no-package-json" })
    expect(
      decideAutoWebpack({
        ...base,
        facts: { packageJson: { kind: "unreadable" } },
      }),
    ).toEqual({ switch: false, reason: "package-json-unreadable" })
    // Valid JSON that is not an object is no more readable.
    expect(
      decideAutoWebpack({
        ...base,
        facts: { packageJson: { kind: "json", value: ["next"] } },
      }),
    ).toEqual({ switch: false, reason: "package-json-unreadable" })
  })

  test("an override of some other package does not stop the switch", () => {
    expect(
      decide({
        pkg: {
          overrides: { react: "19.0.0" },
          resolutions: { "**/nextra": "1.0.0" },
        },
      }),
    ).toMatchObject({ switch: true })
  })

  test("each package manager's default build command is the only one accepted", () => {
    const defaults = [
      ["npm", "npm run build"],
      ["pnpm", "pnpm run build"],
      ["yarn1", "yarn run build"],
      ["bun", "bun run build"],
    ] as const
    for (const [pm, cmd] of defaults) {
      expect(
        decide({ info: { nodePackageManager: pm, buildCommands: [cmd] } }),
      ).toMatchObject({ switch: true })
    }
    for (const buildCommands of [
      // Another manager's default: the plan is not what this manager runs.
      ["pnpm run build"],
      // No build step, and a build step without commands.
      null,
      [],
      ["npm run build", "npm run build"],
      // What the switch itself would produce: set by something else already.
      ["sh -c 'next build --webpack'"],
    ]) {
      expect({ buildCommands, d: decide({ info: { buildCommands } }) }).toEqual(
        { buildCommands, d: { switch: false, reason: "railpack-config" } },
      )
    }
  })

  test("the decision's cap boundary is exactly belowTurbopackCap's", () => {
    // jobs/build.ts feeds belowTurbopackCap(cap) to the fingerprint; if the
    // decision drew its line anywhere else, a switched build and an unswitched
    // one could share a fingerprint and be reused across the line.
    for (const v of [
      null,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      0,
      1,
      960 * MIB,
      TURBOPACK_MIN_BYTES - 1,
      TURBOPACK_MIN_BYTES,
      TURBOPACK_MIN_BYTES + 1,
      2048 * MIB,
    ]) {
      const d = decide({ limitBytes: v })
      expect({ v, switched: "switch" in d && d.switch }).toEqual({
        v,
        switched: belowTurbopackCap(v),
      })
    }
  })

  test("with npm, the lock's installed version wins over the range", () => {
    expect(
      decide({ next: "latest", packageLock: lockWith("16.0.3") }),
    ).toMatchObject({ switch: true, nextMajor: 16 })
    // A v1 lock has no `packages`: the range decides.
    expect(
      decide({
        next: "^16",
        packageLock: { lockfileVersion: 1, dependencies: {} },
      }),
    ).toMatchObject({ switch: true, nextMajor: 16 })
    expect(decide({ next: "^16", packageLock: lockWith("15.5.4") })).toEqual({
      switch: false,
      reason: "next-below-16",
    })
    // A range that pins nothing and no lock to settle it.
    expect(decide({ next: "latest" })).toEqual({
      switch: false,
      reason: "next-version-unknown",
    })
  })

  test("package-lock.json counts only when Railpack says npm", () => {
    // A lock left behind by a switch to another manager says nothing about
    // what that manager installs.
    for (const nodePackageManager of ["pnpm", "yarn1", "bun"] as const) {
      const info = {
        nodePackageManager,
        buildCommands: [
          `${nodePackageManager === "yarn1" ? "yarn" : nodePackageManager} run build`,
        ],
      }
      expect(
        decide({ next: "^16.0.1", info, packageLock: lockWith("15.5.4") }),
      ).toMatchObject({ switch: true, nextMajor: 16 })
      expect(
        decide({ next: "latest", info, packageLock: lockWith("16.0.3") }),
      ).toEqual({ switch: false, reason: "next-version-unknown" })
    }
    // A range that pins 15 ends it before any lock is looked at.
    expect(
      decide({ next: "^15.5.0", packageLock: lockWith("16.0.3") }),
    ).toEqual({ switch: false, reason: "next-below-16" })
  })

  test("no fixture whose determined major is 15 or lower switches", () => {
    for (const next of ["^15.5.0", "15.0.0", "~14.2.0", ">=13", "^9"]) {
      expect(decide({ next })).toMatchObject({ switch: false })
    }
    for (const version of ["15.5.4", "14.2.3", "13.0.0"]) {
      expect(
        decide({ next: "latest", packageLock: lockWith(version) }),
      ).toMatchObject({ switch: false })
    }
  })

  test("asks for each fact only once the cheaper ones leave the question open", () => {
    const at = (facts: NextProjectFacts, buildEnv = {}) =>
      decideAutoWebpack({ limitBytes: 960 * MIB, buildEnv, facts })
    const pkg = (value: unknown): NextProjectFacts => ({
      packageJson: { kind: "json", value },
    })
    const nextApp = {
      scripts: { build: "next build" },
      dependencies: { next: "^16.0.1" },
    }
    // The cap and the user's command need nothing read.
    expect(
      decideAutoWebpack({ limitBytes: 4096 * MIB, buildEnv: {}, facts: {} }),
    ).toEqual({ switch: false, reason: "cap-large" })
    expect(at({}, { RAILPACK_BUILD_CMD: "x" })).toEqual({
      switch: false,
      reason: "user-build-cmd",
    })
    expect(at({})).toEqual({ need: "packageJson" })
    // An Express app, or Next.js 15, stops at package.json: no subprocess.
    expect(at(pkg({ dependencies: { express: "^5.0.0" } }))).toEqual({
      switch: false,
      reason: "no-next",
    })
    expect(at(pkg({ ...nextApp, dependencies: { next: "^15.5.0" } }))).toEqual({
      switch: false,
      reason: "next-below-16",
    })
    expect(at(pkg(nextApp))).toEqual({ need: "railpackInfo" })
    // Railpack says Go: no lockfile parse.
    expect(
      at({
        ...pkg(nextApp),
        railpackInfo: { ...NPM_INFO, providers: ["golang"] },
      }),
    ).toEqual({ switch: false, reason: "other-provider" })
    expect(at({ ...pkg(nextApp), railpackInfo: NPM_INFO })).toEqual({
      need: "packageLock",
    })
    // pnpm never asks for package-lock.json.
    expect(
      at({
        ...pkg(nextApp),
        railpackInfo: {
          ...NPM_INFO,
          nodePackageManager: "pnpm",
          buildCommands: ["pnpm run build"],
        },
      }),
    ).toMatchObject({ switch: true })
  })
})

describe("resolveAutoWebpack", () => {
  test("gathers only what the decision asks for, in order", async () => {
    const asked: string[] = []
    const sources = (value: unknown) => ({
      packageJson: (): Promise<PackageJsonRead> => {
        asked.push("packageJson")
        return Promise.resolve({ kind: "json", value })
      },
      railpackInfo: () => {
        asked.push("railpackInfo")
        return Promise.resolve(NPM_INFO)
      },
      packageLock: () => {
        asked.push("packageLock")
        return Promise.resolve(lockWith("16.0.3"))
      },
    })
    const input = { limitBytes: 960 * MIB, buildEnv: {} }

    expect(
      await resolveAutoWebpack(
        input,
        sources({ dependencies: { express: "^5.0.0" } }),
      ),
    ).toEqual({ switch: false, reason: "no-next" })
    expect(asked).toEqual(["packageJson"])

    asked.length = 0
    expect(
      await resolveAutoWebpack(
        input,
        sources({
          scripts: { build: "next build" },
          dependencies: { next: "latest" },
        }),
      ),
    ).toEqual({
      switch: true,
      buildCmd: "next build --webpack",
      nextMajor: 16,
      capMib: 960,
    })
    expect(asked).toEqual(["packageJson", "railpackInfo", "packageLock"])
  })
})

describe("parseRailpackInfo", () => {
  /** The shape railpack 0.37.0 prints for `info --format json`, trimmed. */
  function report(over: Record<string, unknown> = {}) {
    return {
      railpackVersion: "0.37.0",
      plan: {
        steps: [
          { name: "packages:mise", commands: [{ path: "/mise/shims" }] },
          {
            name: "install",
            commands: [{ cmd: "npm ci" }, { path: "/app/node_modules/.bin" }],
          },
          { name: "build", commands: [{ cmd: "npm run build" }] },
        ],
      },
      resolvedPackages: {},
      metadata: { nodePackageManager: "npm", nodeRuntime: "next" },
      detectedProviders: ["node"],
      logs: [],
      success: true,
      ...over,
    }
  }
  const withBuild = (build: Record<string, unknown>) =>
    report({
      plan: { steps: [{ name: "install" }, { name: "build", ...build }] },
    })

  test("reads providers, the package manager and the build step's commands", () => {
    expect(parseRailpackInfo(report())).toEqual({
      providers: ["node"],
      nodePackageManager: "npm",
      buildCommands: ["npm run build"],
    })
    for (const pm of ["pnpm", "yarn1", "yarnberry", "bun"] as const) {
      expect(
        parseRailpackInfo(report({ metadata: { nodePackageManager: pm } }))
          ?.nodePackageManager,
      ).toBe(pm)
    }
    expect(
      parseRailpackInfo(
        report({ detectedProviders: ["golang"], metadata: {} }),
      ),
    ).toEqual({
      providers: ["golang"],
      nodePackageManager: null,
      buildCommands: ["npm run build"],
    })
  })

  test("build commands: exec commands only; missing commands; overridden", () => {
    // A path or variable command carries no `cmd` and is not counted.
    expect(
      parseRailpackInfo(
        withBuild({
          commands: [{ path: "/x" }, { cmd: "yarn run build" }, { name: "A" }],
        }),
      )?.buildCommands,
    ).toEqual(["yarn run build"])
    // No build script: the step has no `commands` key.
    expect(parseRailpackInfo(withBuild({}))?.buildCommands).toEqual([])
    expect(
      parseRailpackInfo(withBuild({ commands: [{ cmd: "sh -c 'echo hi'" }] }))
        ?.buildCommands,
    ).toEqual(["sh -c 'echo hi'"])
    // With --env RAILPACK_BUILD_CMD=…, the shape Railpack runs it in.
    expect(
      parseRailpackInfo(
        withBuild({ commands: [{ cmd: "sh -c 'next build --webpack'" }] }),
      )?.buildCommands,
    ).toEqual(["sh -c 'next build --webpack'"])
    // No build step, or two, or an unreadable one: not a plan to reason about.
    for (const plan of [
      { steps: [{ name: "install" }] },
      { steps: [{ name: "build" }, { name: "build" }] },
      { steps: [{ name: "build", commands: "npm run build" }] },
      { steps: [{ name: "build", commands: [{ cmd: 42 }] }] },
      { steps: {} },
      null,
    ]) {
      expect(parseRailpackInfo(report({ plan }))?.buildCommands).toBeNull()
    }
  })

  test("null for anything that is not a successful report", () => {
    for (const json of [
      null,
      "node",
      [],
      report({ success: false }),
      report({ success: "true" }),
      report({ detectedProviders: "node" }),
      report({ detectedProviders: ["node", 1] }),
      report({ detectedProviders: undefined }),
    ]) {
      expect(parseRailpackInfo(json)).toBeNull()
    }
    // An unknown package manager is not guessed at.
    expect(
      parseRailpackInfo(report({ metadata: { nodePackageManager: "deno" } }))
        ?.nodePackageManager,
    ).toBeNull()
    expect(
      parseRailpackInfo(report({ metadata: "npm" }))?.nodePackageManager,
    ).toBeNull()
  })
})

describe("readPackageJson / readPackageLock", () => {
  const root = mkdtempSync(join(tmpdir(), "musdash-next-webpack-"))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  const PKG = JSON.stringify({
    scripts: { build: "next build" },
    dependencies: { next: "^16.0.1" },
  })
  const LOCK = JSON.stringify(lockWith("16.0.3"))
  /** Valid JSON grown past `bytes` with whitespace, so only its size can refuse it. */
  const padded = (json: string, bytes: number) =>
    json + " ".repeat(bytes + 1 - json.length)

  /** A build dir `<root>/<name>` with an `app/` context holding `files`. */
  function tree(name: string, files: Record<string, string>): string {
    const dir = join(root, name)
    mkdirSync(join(dir, "app"), { recursive: true })
    for (const [file, text] of Object.entries(files)) {
      writeFileSync(join(dir, "app", file), text)
    }
    return dir
  }

  // One test, deliberately: the untrusted-tree rules (symlinks, size caps)
  // in their smallest form, each against a baseline that does read.
  test("refuses symlinks and oversized files in the repository", async () => {
    const unreadable: PackageJsonRead = { kind: "unreadable" }
    const ok = tree("ok", { "package.json": PKG, "package-lock.json": LOCK })
    expect(await readPackageJson(ok, join(ok, "app"))).toEqual({
      kind: "json",
      value: JSON.parse(PKG),
    })
    expect(await readPackageLock(ok, join(ok, "app"))).toEqual(JSON.parse(LOCK))

    // No package.json at all is a different answer from one that is refused.
    const empty = tree("empty", {})
    expect(await readPackageJson(empty, join(empty, "app"))).toEqual({
      kind: "absent",
    })

    // package.json is a symlink to a perfectly good file.
    const linkedPkg = tree("linked-pkg", {})
    symlinkSync(
      join(ok, "app", "package.json"),
      join(linkedPkg, "app", "package.json"),
    )
    expect(await readPackageJson(linkedPkg, join(linkedPkg, "app"))).toEqual(
      unreadable,
    )

    // A context path component is a symlinked directory.
    const linkedDir = join(root, "linked-dir")
    mkdirSync(linkedDir)
    symlinkSync(join(ok, "app"), join(linkedDir, "app"))
    expect(await readPackageJson(linkedDir, join(linkedDir, "app"))).toEqual(
      unreadable,
    )
    expect(await readPackageLock(linkedDir, join(linkedDir, "app"))).toBeNull()

    // package.json over 1 MiB.
    const bigPkg = tree("big-pkg", { "package.json": padded(PKG, 1 * MIB) })
    expect(await readPackageJson(bigPkg, join(bigPkg, "app"))).toEqual(
      unreadable,
    )

    // Not JSON.
    const badPkg = tree("bad-pkg", { "package.json": "{ not json" })
    expect(await readPackageJson(badPkg, join(badPkg, "app"))).toEqual(
      unreadable,
    )

    // A byte-order mark is not a reason to refuse.
    const bomPkg = tree("bom-pkg", { "package.json": `\uFEFF${PKG}` })
    expect(await readPackageJson(bomPkg, join(bomPkg, "app"))).toEqual({
      kind: "json",
      value: JSON.parse(PKG),
    })

    // package-lock.json over 8 MiB is treated as absent, not as a failure.
    const bigLock = tree("big-lock", {
      "package.json": PKG,
      "package-lock.json": padded(LOCK, 8 * MIB),
    })
    expect(await readPackageJson(bigLock, join(bigLock, "app"))).toEqual({
      kind: "json",
      value: JSON.parse(PKG),
    })
    expect(await readPackageLock(bigLock, join(bigLock, "app"))).toBeNull()
  })
})
