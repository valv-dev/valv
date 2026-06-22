import type { Dialect } from "@valv/core"

const doubleQuote = (id: string): string => '"' + id.replace(/"/g, '""') + '"'
const backtick = (id: string): string => "`" + id.replace(/`/g, "``") + "`"

// Postgres/CockroachDB: "id" quoting, $1 placeholders.
export const postgresDialect: Dialect = {
  quoteId: doubleQuote,
  placeholder: (index) => `$${index + 1}`,
}

// MySQL: `id` quoting, ? placeholders.
export const mysqlDialect: Dialect = {
  quoteId: backtick,
  placeholder: () => "?",
}

// SQLite: "id" quoting, ? placeholders.
export const sqliteDialect: Dialect = {
  quoteId: doubleQuote,
  placeholder: () => "?",
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
