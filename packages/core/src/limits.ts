import { ValidationError } from "./errors"

// Reject pathologically large or deep input before it reaches the recursive
// parser, validator, or emitter — all of which would otherwise overflow the
// stack or build multi-megabyte SQL. The check itself is iterative (its own
// explicit stack) so it can't overflow on the input it's guarding against.

const MAX_DEPTH = 50
const MAX_NODES = 5000

// Join cost ceilings. Static, deterministic guards applied after a query's join
// paths are resolved (joins.ts) — they bound query shape before SQL is built.
// belongsTo joins (N:1) don't multiply rows; hasMany/manyToMany (fan-out) do and
// compound across hops, so they get their own tighter cap — the primary guard
// against a join blowing up into a huge intermediate result.
export const MAX_JOIN_DEPTH = 3 // longest relation path from the root
export const MAX_JOINED_TABLES = 4 // total joined tables (excl. the root)
export const MAX_FANOUT_JOINS = 2 // hasMany/manyToMany hops in a single query

export function assertWithinLimits(input: unknown): void {
  let nodes = 0
  const stack: Array<{ value: unknown; depth: number }> = [{ value: input, depth: 0 }]
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!
    if (depth > MAX_DEPTH) throw new ValidationError("Query is too deeply nested.")
    if (value === null || typeof value !== "object") continue
    if (++nodes > MAX_NODES) throw new ValidationError("Query is too large.")
    const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)
    for (const child of children) stack.push({ value: child, depth: depth + 1 })
  }
}
