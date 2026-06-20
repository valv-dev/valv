// The Policy model: what a developer writes to gate access, and the context it
// runs against. The query path turns these rules into row filters and field
// allowlists injected before SQL is emitted.

export type PolicyFn<TContext = DefaultContext> = (ctx: TContext) => PolicyResult

/**
 * An operation rule:
 *   true / false        → allow / deny
 *   { field: value }    → a row predicate, using the same operator vocabulary
 *                         the query schema exposes (eq/in/lt/…) plus OR/AND/NOT.
 *
 * Reads/deletes use the predicate as a WHERE filter; writes force its scalar
 * equalities into the row and use the full predicate as a guard.
 */
export type PolicyRule = boolean | Record<string, unknown>

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
