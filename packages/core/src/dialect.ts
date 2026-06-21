import type { FnDef } from "./functions"

// The contract a database adapter implements so the shared emitter can target
// it. It captures only what differs between databases — identifier quoting,
// parameter placeholders, and any extra functions — while clause assembly,
// parenthesisation, and parameter ordering stay in the emitter. Adding a
// database is implementing this interface, not writing a new emitter.
export interface Dialect {
  // Quote an identifier (table/column/alias) for this database's syntax.
  quoteId(id: string): string

  // Render the placeholder for parameter #index (0-based). `type` is the
  // compared column's native type, used by dialects with typed placeholders
  // (ClickHouse `{p0:UInt32}`) and ignored by those that bind positionally
  // (Postgres `$1`, MySQL/SQLite `?`).
  placeholder(index: number, type: string): string

  // Functions this dialect adds on top of the standard aggregates in
  // BASE_FUNCTIONS (e.g. ClickHouse `quantileTiming`). Merged at emit time.
  functions?: Record<string, FnDef>
}
