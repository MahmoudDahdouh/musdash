// biome-ignore-all lint/suspicious/noTemplateCurlyInString: ${VAR} in a plain
// string is the subject under test here, not a mistyped template literal. The
// rule stays on everywhere else, where it is catching a real bug.

import { describe, expect, test } from "bun:test"
import {
  EnvInterpolationError,
  EnvSelfReferenceError,
  interpolate,
} from "./interpolate.ts"

describe("interpolate", () => {
  test("substitutes a reference to another variable", () => {
    expect(interpolate({ A: "1", B: "${A}" })).toEqual({ A: "1", B: "1" })
  })

  test("substitutes several references in one value", () => {
    expect(
      interpolate({
        SCHEME: "https",
        HOST: "example.com",
        URL: "${SCHEME}://${HOST}",
      }),
    ).toEqual({
      SCHEME: "https",
      HOST: "example.com",
      URL: "https://example.com",
    })
  })

  test("an empty value is a valid substitution, not a missing one", () => {
    expect(interpolate({ A: "", B: "x${A}y" })).toEqual({ A: "", B: "xy" })
  })

  // One pass, by design: expanding B's own reference too would require cycle
  // detection, and a cycle would hang the single worker.
  test("does not recurse — a reference to a reference stays literal", () => {
    expect(interpolate({ A: "${B}", B: "${C}", C: "x" })).toEqual({
      A: "${C}",
      B: "x",
      C: "x",
    })
  })

  // The regression this guards: reading from the output map instead of the
  // input would make the result depend on Object.entries order.
  test("result does not depend on key order", () => {
    const forward = interpolate({ A: "1", B: "${A}" })
    const reverse = interpolate({ B: "${A}", A: "1" })
    expect(forward).toEqual(reverse)
  })

  test("an undefined reference throws, naming the key and the reference", () => {
    expect(() => interpolate({ A: "${MISSING}" })).toThrow(
      EnvInterpolationError,
    )
    try {
      interpolate({ ENDPOINT: "${BASE}/v1" })
      throw new Error("should have thrown")
    } catch (e) {
      const err = e as EnvInterpolationError
      expect(err.key).toBe("ENDPOINT")
      expect(err.missing).toBe("BASE")
    }
  })

  // The message reaches the deploy log, so it must carry names and no values.
  test("the error message contains no variable values", () => {
    try {
      interpolate({ A: "secret-value-${MISSING}" })
      throw new Error("should have thrown")
    } catch (e) {
      expect((e as Error).message).not.toContain("secret-value")
    }
  })

  // The shell habit PATH=$PATH:/x cannot work here — there is no inherited
  // environment — and without this it would silently yield a doubled value.
  test("a self-reference throws rather than doubling the value", () => {
    expect(() => interpolate({ PATH: "${PATH}:/x" })).toThrow(
      EnvSelfReferenceError,
    )
  })

  test("$$ yields a literal $", () => {
    expect(interpolate({ A: "pa$$word" })).toEqual({ A: "pa$word" })
  })

  test("$${NAME} yields a literal ${NAME}", () => {
    expect(interpolate({ A: "$${HOME}" })).toEqual({ A: "${HOME}" })
  })

  test("a bare $ and $word pass through untouched", () => {
    expect(interpolate({ A: "pa$word", B: "100$" })).toEqual({
      A: "pa$word",
      B: "100$",
    })
  })

  test("an unclosed ${ is left literal", () => {
    expect(interpolate({ A: "${UNCLOSED" })).toEqual({ A: "${UNCLOSED" })
  })

  test("an empty map is a no-op", () => {
    expect(interpolate({})).toEqual({})
  })
})
