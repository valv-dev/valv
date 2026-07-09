import type { Dialect } from "./dialect"
import type { FnDef } from "./functions"

// Standard SQL dialects that ship with core. Postgres lives here (rather than in
// an adapter) because more than one adapter targets it — the driver-based
// @valv/postgres and the Prisma adapter's postgres provider both use it, so a
// single definition avoids drift.

const doubleQuote = (id: string): string => '"' + id.replace(/"/g, '""') + '"'

// Grains a timestamp can be truncated to for time-series bucketing. The unit is
// enum-checked against this list at emit time, so it's safe to inline in the SQL.
const TRUNC_UNITS = ["minute", "hour", "day", "month", "year"] as const

// dateTrunc(col, unit) — the time-series bucketing primitive. The model groups by
// its alias to get e.g. revenue-per-month instead of one row per raw timestamp.
// unit is enum-checked (safe inlined); col is quoted by the emitter.
// Postgres's date_trunc on a `timestamptz` truncates in the SESSION timezone, so
// the adapters pin the session to UTC (SET LOCAL TIME ZONE 'UTC') before running
// — otherwise buckets shift by the server's offset and depend on where it runs.
const dateTrunc: FnDef = {
  args: [{ kind: "column" }, { kind: "enum", values: TRUNC_UNITS }],
  returns: "date",
  render: ([c, unit]) => `date_trunc('${unit}', ${c})`,
}

// Postgres / CockroachDB: "id" identifier quoting, $1-based positional
// placeholders. The placeholder ignores the column type — Postgres binds
// positionally.
export const postgresDialect: Dialect = {
  quoteId: doubleQuote,
  placeholder: (index) => `$${index + 1}`,
  functions: { dateTrunc },
}
