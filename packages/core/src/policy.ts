// The Policy model: what a developer writes to gate access, and the context it
// runs against. The query path turns these rules into row filters and field
// allowlists injected before SQL is emitted.

import type { Expr } from "./ast"

export type PolicyFn<TContext = DefaultContext> = (ctx: TContext) => PolicyResult

/**
 * An operation rule:
 *   true / false        → allow / deny
 *   { field: value, … } → the scalar-equality shorthand: each pair is `col =
 *                          value`, AND-ed together (the common tenant-scoping case)
 *   an Expr             → an arbitrary predicate — the same AST the model emits in
 *                          a WHERE, so any operator (`>`, `<`, `!=`, …) and
 *                          AND/OR/NOT are available, e.g.
 *                          { kind: "cmp", op: ">", left: { kind: "col", name:
 *                          "total" }, right: { kind: "value", value: 100 } }.
 *
 * Reads/deletes use the predicate as a WHERE filter. Creates can only use the
 * scalar shorthand (you force values onto a row, not a comparison).
 */
export type PolicyRule = boolean | Expr | Record<string, unknown>

export interface PolicyResult {
  read?: PolicyRule
  write?: PolicyRule // shorthand for both create and update
  create?: PolicyRule // overrides write for inserts
  update?: PolicyRule // overrides write for updates
  delete?: PolicyRule
  aggregate?: PolicyRule // overrides read for aggregations
  fields?: FieldPolicy
  relations?: Record<string, boolean>
}

export interface FieldPolicy {
  allow?: string[] // whitelist
  deny?: string[] // blacklist
  readOnly?: string[] // readable, never writable
  writeOnly?: string[] // writable, never returned
}

export interface DefaultContext {
  user: {
    id: string
    role: string
    [key: string]: unknown
  }
  tenant?: {
    id: string
    [key: string]: unknown
  }
  [key: string]: unknown
}
