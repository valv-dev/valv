import type { FieldType } from "./catalog"
import { ValidationError } from "./errors"

// The function allowlist + signatures. A function name in the AST is attacker-
// controlled, so emission renders only names with an entry here (or in a
// dialect's registry) — unknown names are rejected, never spliced. Each
// signature declares its argument kinds, which is how the emitter keeps args
// safe by construction (see emit.ts). Also the discovery surface getTools reads.

// One argument of a function call, mirroring how SQL functions take positional
// args. The AST supplies each as an Expr; the spec says how to read it.
export type ArgSpec =
  | { kind: "column"; optional?: boolean } // a column reference → quoted identifier
  | { kind: "number"; range?: [number, number] } // a finite literal → inlined
  | { kind: "enum"; values: readonly string[] } // an allowlisted literal → inlined
  | { kind: "predicate" } // a boolean Expr → emitted (and so parameterised)

// The coarse output type of a function: a fixed type (count → number), or
// "same as the column at arg N" for type-preserving aggregates (max → its arg).
// Used by resultSchema to predict a query's output shape without running it.
export type FnReturn = FieldType | { fromArg: number }

export interface FnDef {
  args: readonly ArgSpec[]
  returns: FnReturn
  // Assemble the SQL from each argument already rendered to a string (or
  // undefined for an omitted trailing optional column, e.g. count(*)).
  render(parts: (string | undefined)[]): string
}

// Standard SQL aggregates every dialect emits identically.
export const BASE_FUNCTIONS: Record<string, FnDef> = {
  count: { args: [{ kind: "column", optional: true }], returns: "number", render: ([c]) => `count(${c ?? "*"})` },
  sum: { args: [{ kind: "column" }], returns: "number", render: ([c]) => `sum(${c})` },
  avg: { args: [{ kind: "column" }], returns: "number", render: ([c]) => `avg(${c})` },
  min: { args: [{ kind: "column" }], returns: { fromArg: 0 }, render: ([c]) => `min(${c})` },
  max: { args: [{ kind: "column" }], returns: { fromArg: 0 }, render: ([c]) => `max(${c})` },
}

// Resolve a function name against base ∪ dialect functions. The own-property
// check holds the allowlist even if a caller passes a registry with a prototype
// (the dialect-merged one is null-prototype), so names like "constructor" or
// "toString" can't resolve to an inherited member.
export function lookupFunction(registry: Record<string, FnDef>, fn: string): FnDef {
  const def = Object.prototype.hasOwnProperty.call(registry, fn) ? registry[fn] : undefined
  if (!def) throw new ValidationError(`Function "${fn}" is not available.`)
  return def
}

// How many leading arguments a function requires (only a trailing optional
// column may be omitted, e.g. count).
export function requiredArgs(def: FnDef): number {
  return def.args.filter((s) => !(s.kind === "column" && s.optional)).length
}
