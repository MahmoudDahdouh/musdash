import { describe, expect, test } from "bun:test"
import {
  COMPOSE_PATH,
  composeArgv,
  composeEnv,
  composeErrorMessage,
  MSG_ADDRESS_POOLS,
  MSG_NOT_INSTALLED,
} from "./compose.ts"

/**
 * What every `docker compose` invocation carries (D65 items 9 and 14): the
 * explicit project and file, and an environment of exactly three keys — plus,
 * for `config` only, the user's filtered variables beneath ours.
 */

const FILE = {
  file: "/data/compose/tmp/01ABC/stack.json",
  dir: "/data/compose/tmp/01ABC",
}

describe("composeArgv", () => {
  test("-p always, and -f with --project-directory whenever there is a file", () => {
    const argv = composeArgv("musdash-01abc", FILE, ["up", "-d"])
    expect(argv.slice(0, 2)).toEqual(["docker", "compose"])
    expect(argv).toContain("-p")
    expect(argv[argv.indexOf("-p") + 1]).toBe("musdash-01abc")
    expect(argv[argv.indexOf("-f") + 1]).toBe(FILE.file)
    expect(argv[argv.indexOf("--project-directory") + 1]).toBe(FILE.dir)
    // Global flags before the subcommand, where Compose reads them.
    expect(argv.indexOf("-f")).toBeLessThan(argv.indexOf("up"))
    expect(argv.indexOf("-p")).toBeLessThan(argv.indexOf("up"))
  })

  test("without a file, -p alone (stop and down work from labels)", () => {
    const argv = composeArgv("musdash-01abc", null, [
      "down",
      "--remove-orphans",
    ])
    expect(argv[argv.indexOf("-p") + 1]).toBe("musdash-01abc")
    expect(argv).not.toContain("-f")
  })

  test("never a flag that deletes volumes", () => {
    for (const args of [
      ["down", "--remove-orphans"],
      ["up", "-d", "--remove-orphans", "--no-build"],
      ["stop"],
      ["pull"],
    ]) {
      const argv = composeArgv("musdash-01abc", FILE, args)
      expect(argv).not.toContain("--volumes")
      expect(argv).not.toContain("-v")
      expect(argv).not.toContain("-V")
    }
  })

  test("a project name Compose would not accept is refused before any spawn", () => {
    for (const bad of ["", "Musdash", "a b", "-x", "a;rm"]) {
      expect(() => composeArgv(bad, null, ["stop"])).toThrow()
    }
  })
})

describe("composeEnv", () => {
  test("exactly PATH, HOME and DOCKER_HOST", () => {
    const env = composeEnv("/data/compose/home", "unix:///var/run/docker.sock")
    expect(env).toEqual({
      PATH: COMPOSE_PATH,
      HOME: "/data/compose/home",
      DOCKER_HOST: "unix:///var/run/docker.sock",
    })
  })

  test("the user's variables go beneath ours, and ours win", () => {
    const env = composeEnv("/h", "unix:///s", {
      DATABASE_URL: "postgres://x",
      DOCKER_HOST: "tcp://evil:2375",
      PATH: "/tmp/evil",
      HOME: "/root",
    })
    expect(env).toEqual({
      DATABASE_URL: "postgres://x",
      PATH: COMPOSE_PATH,
      HOME: "/h",
      DOCKER_HOST: "unix:///s",
    })
  })

  test("nothing of this process leaks in", () => {
    process.env.MUSDASH_COMPOSE_TEST = "x"
    try {
      expect(Object.keys(composeEnv("/h", "unix:///s")).sort()).toEqual([
        "DOCKER_HOST",
        "HOME",
        "PATH",
      ])
    } finally {
      delete process.env.MUSDASH_COMPOSE_TEST
    }
  })
})

describe("composeErrorMessage", () => {
  test("exhausted address pools get the sentence that says what to do", () => {
    const msg = composeErrorMessage(
      "up",
      [
        " Network musdash-01abc_default  Creating",
        'time="2026-09-29T10:00:00Z" level=error msg="failed to create network musdash-01abc_default: Error response from daemon: all predefined address pools have been fully subnetted"',
      ],
      1,
    )
    expect(msg).toBe(MSG_ADDRESS_POOLS)
  })

  test("a docker without the compose plugin says to install it", () => {
    expect(
      composeErrorMessage(
        "config",
        ["docker: 'compose' is not a docker command.", "See 'docker --help'"],
        1,
      ),
    ).toBe(MSG_NOT_INSTALLED)
  })

  test("otherwise the last error line, unwrapped from logrus", () => {
    expect(
      composeErrorMessage(
        "pull",
        [
          "some progress",
          'time="2026-09-29T10:00:00Z" level=error msg="pull access denied for nope, repository does not exist or may require \\"docker login\\""',
          "",
        ],
        18,
      ),
    ).toBe(
      'pull access denied for nope, repository does not exist or may require "docker login"',
    )
    expect(composeErrorMessage("up", ["plain failure line"], 1)).toBe(
      "plain failure line",
    )
  })

  test("no stderr names the exit code", () => {
    expect(composeErrorMessage("stop", [], 7)).toBe(
      "docker compose stop exited with code 7",
    )
  })
})
