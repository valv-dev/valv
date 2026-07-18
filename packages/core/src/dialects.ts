import type { Dialect } from "./dialect"
import type { FnDef } from "./functions"

// Standard SQL dialects that ship with core. Postgres and MySQL live here
// (rather than in an adapter) because more than one adapter targets each — the
// driver-based @valv/postgres and @valv/mysql, plus the Prisma adapter's
// postgres/mysql providers — so a single definition per dialect avoids drift.

const doubleQuote = (id: string): string => '"' + id.replace(/"/g, '""') + '"'
const backtick = (id: string): string => "`" + id.replace(/`/g, "``") + "`"

// Grains a timestamp can be truncated to for time-series bucketing. The unit is
// enum-checked against this list at emit time, so it's safe to inline in the SQL.
const TRUNC_UNITS = ["minute", "hour", "day", "month", "year"] as const

// dateTrunc(col, unit) — the time-series bucketing primitive. The model groups by
// its alias to get e.g. revenue-per-month instead of one row per raw timestamp.
// unit is enum-checked (safe inlined); col is quoted by the emitter.
// Postgres's date_trunc on a `timestamptz` truncates in the SESSION timezone, so
// the adapters pin the session to UTC (SET LOCAL TIME ZONE 'UTC') before running
// — otherwise buckets shift by the server's offset and depend on where it runs.
const dateTruncPg: FnDef = {
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
  functions: { dateTrunc: dateTruncPg },
}

// MySQL truncates by DATE_FORMAT-ing the timestamp down to the chosen grain
// (lower components zeroed). MySQL converts TIMESTAMP columns to the session
// zone on read, so the adapter pins the session to UTC (SET time_zone = '+00:00')
// before running — same reasoning as Postgres above.
const DATE_FORMAT: Record<(typeof TRUNC_UNITS)[number], string> = {
  minute: "%Y-%m-%d %H:%i:00",
  hour: "%Y-%m-%d %H:00:00",
  day: "%Y-%m-%d",
  month: "%Y-%m-01",
  year: "%Y-01-01",
}
const dateTruncMysql: FnDef = {
  args: [{ kind: "column" }, { kind: "enum", values: TRUNC_UNITS }],
  returns: "date",
  render: ([c, unit]) =>
    `DATE_FORMAT(${c}, '${DATE_FORMAT[unit as (typeof TRUNC_UNITS)[number]]}')`,
}

// MySQL / MariaDB: `id` backtick quoting, ? positional placeholders (type
// ignored — MySQL binds positionally).
export const mysqlDialect: Dialect = {
  quoteId: backtick,
  placeholder: () => "?",
  functions: { dateTrunc: dateTruncMysql },
  ilike: "LIKE", // MySQL has no ILIKE; its LIKE is case-insensitive by collation.
}
