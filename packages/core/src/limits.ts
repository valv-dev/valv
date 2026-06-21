import { ValidationError } from "./errors"

// Reject pathologically large or deep input before it reaches the recursive
// parser, validator, or emitter — all of which would otherwise overflow the
// stack or build multi-megabyte SQL. The check itself is iterative (its own
// explicit stack) so it can't overflow on the input it's guarding against.

const MAX_DEPTH = 50
const MAX_NODES = 5000

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
