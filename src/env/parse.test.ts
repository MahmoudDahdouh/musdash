import { describe, expect, test } from "bun:test"
import { formatEnvText, parseEnvText } from "./parse.ts"

const vars = (t: string) => parseEnvText(t).vars
const errs = (t: string) => parseEnvText(t).errors

describe("parseEnvText", () => {
  test("plain KEY=value", () => {
    expect(vars("FOO=bar")).toEqual({ FOO: "bar" })
  })

  test("multiple lines", () => {
    expect(vars("A=1\nB=2\nC=3")).toEqual({ A: "1", B: "2", C: "3" })
  })

  // The case §15 calls out explicitly: split on the first `=` only.
  test("values containing = are preserved", () => {
    expect(vars("URL=postgres://u:p@h:5432/db?a=1&b=2")).toEqual({
      URL: "postgres://u:p@h:5432/db?a=1&b=2",
    })
    expect(vars("B64=aGVsbG8gd29ybGQ==")).toEqual({ B64: "aGVsbG8gd29ybGQ==" })
    expect(vars("EQ==")).toEqual({ EQ: "=" })
  })

  test("blank lines and whitespace are ignored", () => {
    expect(vars("\n\n  \nFOO=bar\n\n  \n")).toEqual({ FOO: "bar" })
  })

  test("comment lines are ignored", () => {
    expect(vars("# a comment\nFOO=bar\n  # indented comment")).toEqual({
      FOO: "bar",
    })
  })

  test("surrounding whitespace is trimmed from key and value", () => {
    expect(vars("  FOO  =  bar  ")).toEqual({ FOO: "bar" })
  })

  test("empty value", () => {
    expect(vars("EMPTY=")).toEqual({ EMPTY: "" })
    expect(vars("EMPTY=   ")).toEqual({ EMPTY: "" })
  })

  test("double-quoted values keep inner whitespace", () => {
    expect(vars('MSG="hello world"')).toEqual({ MSG: "hello world" })
    expect(vars('PAD="  spaced  "')).toEqual({ PAD: "  spaced  " })
  })

  test("single-quoted values are literal", () => {
    expect(vars("RAW='no \\n escape'")).toEqual({ RAW: "no \\n escape" })
  })

  test("escapes are honoured inside double quotes", () => {
    expect(vars('NL="line1\\nline2"')).toEqual({ NL: "line1\nline2" })
    expect(vars('Q="say \\"hi\\""')).toEqual({ Q: 'say "hi"' })
  })

  test("a quoted value may contain #", () => {
    expect(vars('COLOR="#ff0000"')).toEqual({ COLOR: "#ff0000" })
  })

  test("an unquoted inline comment is stripped", () => {
    expect(vars("FOO=bar # trailing comment")).toEqual({ FOO: "bar" })
  })

  test("a # inside an unquoted value without a space is kept", () => {
    expect(vars("HASH=a#b")).toEqual({ HASH: "a#b" })
  })

  test("export prefix is accepted", () => {
    expect(vars("export FOO=bar")).toEqual({ FOO: "bar" })
    expect(vars('export DB="x y"')).toEqual({ DB: "x y" })
  })

  test("a line with no = is reported, not silently dropped", () => {
    const r = parseEnvText("FOO=bar\nJUST_A_WORD\nBAZ=qux")
    expect(r.vars).toEqual({ FOO: "bar", BAZ: "qux" })
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toContain("line 2")
  })

  test("an invalid key name is reported", () => {
    const r = parseEnvText("9INVALID=x\nGOOD=y\nhas-dash=z")
    expect(r.vars).toEqual({ GOOD: "y" })
    expect(r.errors).toHaveLength(2)
  })

  test("lowercase and underscored keys are valid", () => {
    expect(vars("my_var=1\n_LEADING=2\nMiXeD3=3")).toEqual({
      my_var: "1",
      _LEADING: "2",
      MiXeD3: "3",
    })
  })

  test("duplicate keys: last wins, and it is reported", () => {
    const r = parseEnvText("FOO=first\nFOO=second")
    expect(r.vars).toEqual({ FOO: "second" })
    expect(r.errors[0]).toContain("more than once")
  })

  test("CRLF line endings", () => {
    expect(vars("A=1\r\nB=2")).toEqual({ A: "1", B: "2" })
  })

  test("an unterminated quote keeps the remainder rather than losing it", () => {
    expect(vars('FOO="unterminated')).toEqual({ FOO: "unterminated" })
  })

  test("a realistic pasted .env block", () => {
    const text = `
# Database
DATABASE_URL=postgres://user:s3cr3t@db:5432/app?sslmode=disable

export NODE_ENV=production
PORT=3000
SECRET_KEY="a b c=d"   # inline note
EMPTY=
`
    expect(parseEnvText(text)).toEqual({
      vars: {
        DATABASE_URL: "postgres://user:s3cr3t@db:5432/app?sslmode=disable",
        NODE_ENV: "production",
        PORT: "3000",
        SECRET_KEY: "a b c=d",
        EMPTY: "",
      },
      errors: [],
    })
  })

  test("empty input", () => {
    expect(parseEnvText("")).toEqual({ vars: {}, errors: [] })
  })
})

describe("formatEnvText", () => {
  test("round-trips simple values", () => {
    const v = { FOO: "bar", PORT: "3000" }
    expect(vars(formatEnvText(v))).toEqual(v)
  })

  test("round-trips values needing quotes", () => {
    const v = { MSG: "hello world", HASH: "a#b", NL: "one\ntwo" }
    expect(vars(formatEnvText(v))).toEqual(v)
  })

  test("round-trips an empty value", () => {
    expect(vars(formatEnvText({ E: "" }))).toEqual({ E: "" })
  })
})

describe("no errors on valid input", () => {
  test("clean input produces no errors", () => {
    expect(errs("A=1\nB=2")).toEqual([])
  })
})
