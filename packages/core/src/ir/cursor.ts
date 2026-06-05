import { ValidationError } from "../errors"

/**
 * Keyset encoded into an opaque pagination cursor. The adapter builds a
 * `WHERE (sortField, id) > (sortValue, id)` predicate from this to continue
 * paging after the last returned row. `id` is the primary-key tiebreaker so
 * paging is stable even when `sortField` has duplicate values.
 */
export interface CursorKeyset {
  sortField: string
  direction: "asc" | "desc"
  sortValue: unknown
  id: unknown
}

/** Encode a keyset into an opaque base64url token. */
export function encodeCursor(keyset: CursorKeyset): string {
  return Buffer.from(JSON.stringify(keyset), "utf8").toString("base64url")
}

/**
 * Decode an opaque pagination cursor back into its keyset. Throws a
 * `ValidationError` for any malformed or tampered token rather than letting a
 * raw `SyntaxError` escape.
 */
export function decodeCursor(token: string): CursorKeyset {
  let parsed: unknown
  try {
    const json = Buffer.from(token, "base64url").toString("utf8")
    parsed = JSON.parse(json)
  } catch {
    throw new ValidationError("Invalid pagination cursor")
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as Record<string, unknown>).sortField !== "string" ||
    !("sortValue" in (parsed as Record<string, unknown>)) ||
    !("id" in (parsed as Record<string, unknown>))
  ) {
    throw new ValidationError("Invalid pagination cursor")
  }

  const obj = parsed as Record<string, unknown>
  return {
    sortField: obj.sortField as string,
    direction: obj.direction === "desc" ? "desc" : "asc",
    sortValue: obj.sortValue,
    id: obj.id,
  }
}
