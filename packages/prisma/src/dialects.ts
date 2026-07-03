import type { Dialect, FnDef } from "@valv/core"
import { postgresDialect } from "@valv/core"

const doubleQuote = (id: string): string => '"' + id.replace(/"/g, '""') + '"'
const backtick = (id: string): string => "`" + id.replace(/`/g, "``") + "`"

// Units a timestamp can be truncated to for time-series bucketing. Kept to the
// grains every supported dialect can express cleanly. The arg is enum-checked
// against this list, so the unit is safe to inline in the rendered SQL.
// ponytail: skipped quarter/week — neither MySQL DATE_FORMAT nor SQLite strftime
// expresses them in one expression; add per-dialect when someone needs them.
const TRUNC_UNITS = ["minute", "hour", "day", "month", "year"] as const

// SQLite strftime / MySQL DATE_FORMAT pattern per unit. Both truncate by
// formatting the timestamp down to the chosen grain (lower components zeroed).
const STRFTIME: Record<(typeof TRUNC_UNITS)[number], string> = {
  minute: "%Y-%m-%d %H:%M:00",
  hour: "%Y-%m-%d %H:00:00",
  day: "%Y-%m-%d",
  month: "%Y-%m-01",
  year: "%Y-01-01",
}
const DATE_FORMAT: Record<(typeof TRUNC_UNITS)[number], string> = {
  minute: "%Y-%m-%d %H:%i:00",
  hour: "%Y-%m-%d %H:00:00",
  day: "%Y-%m-%d",
  month: "%Y-%m-01",
  year: "%Y-01-01",
}

// dateTrunc(col, unit) — the time-series bucketing primitive. The model groups
// by its alias to get completions-per-month etc. instead of one row per raw
// timestamp. unit is enum-checked (safe inlined); col is quoted by the emitter.
const dateTrunc = (render: (col: string, unit: (typeof TRUNC_UNITS)[number]) => string): FnDef => ({
  args: [{ kind: "column" }, { kind: "enum", values: TRUNC_UNITS }],
  returns: "date",
  render: ([c, unit]) => render(c!, unit as (typeof TRUNC_UNITS)[number]),
})

// Postgres/CockroachDB use core's shared `postgresDialect` (imported above), so
// the definition lives in one place. MySQL and SQLite stay here — they're only
// used by this adapter.

// MySQL: `id` quoting, ? placeholders.
export const mysqlDialect: Dialect = {
  quoteId: backtick,
  placeholder: () => "?",
  functions: {
    dateTrunc: dateTrunc((c, unit) => `DATE_FORMAT(${c}, '${DATE_FORMAT[unit]}')`),
  },
}

// SQLite: "id" quoting, ? placeholders.
export const sqliteDialect: Dialect = {
  quoteId: doubleQuote,
  placeholder: () => "?",
  functions: {
    dateTrunc: dateTrunc((c, unit) => `strftime('${STRFTIME[unit]}', ${c})`),
  },
}

export function dialectForProvider(provider: string): Dialect {
  switch (provider) {
    case "postgresql":
    case "postgres":
    case "cockroachdb":
      return postgresDialect
    case "mysql":
      return mysqlDialect
    case "sqlite":
      return sqliteDialect
    default:
      throw new Error(
        `[valv/prisma] unsupported provider "${provider}" (supported: postgresql, mysql, sqlite, cockroachdb)`,
      )
  }
}
