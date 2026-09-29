/**
 * The container port as the three resource forms submit it.
 *
 * The field is read as a string, not `t.Numeric()`, because a browser submits
 * an empty number input as `containerPort=` and Numeric refuses "", which
 * turned clearing the field into a full-page 400. Blank and missing mean the
 * same thing — "no port", so no Caddy route and no HTTP health poll — and the
 * server never substitutes a default for either.
 *
 * A non-empty value must be an integer 1..65535. The form's min/max says so
 * too, but this is the real check: the port reaches Caddy's dial address and
 * the health poll URL, so a hand-made request must not get past it.
 */

export type ContainerPortParse =
  { ok: true; port: number | null } | { ok: false }

const DIGITS = /^\d{1,5}$/

export function parseContainerPort(
  raw: string | undefined,
): ContainerPortParse {
  const value = raw?.trim() ?? ""
  if (value === "") return { ok: true, port: null }
  // Digits only: Number() alone would accept "80.5", "+80", "1e3" and "0x50".
  if (!DIGITS.test(value)) return { ok: false }
  const port = Number(value)
  if (port < 1 || port > 65535) return { ok: false }
  return { ok: true, port }
}
