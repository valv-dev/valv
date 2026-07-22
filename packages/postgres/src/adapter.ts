import type { ValvAdapter, SchemaMap, Query, CompiledQuery, FnDef } from "@valv/core"
import { emit, BASE_FUNCTIONS, postgresDialect, ValidationError } from "@valv/core"
import { introspectPostgres, type PostgresSql } from "./introspection"

export interface PostgresAdapterOptions {
  /** Declare the schema by hand instead of querying information_schema. */
  schema?: SchemaMap
  /** Postgres schema to introspect and qualify tables with. Defaults to `public`. */
  namespace?: string
}

// Per-query wall-clock cap so a structurally-valid query (e.g. a join that scans
// far more than expected) can't run away on the server. Applied via
// `SET LOCAL statement_timeout` inside the transaction that runs the query.
const STATEMENT_TIMEOUT_MS = 10_000

// Postgres reports a `statement_timeout` cancellation as SQLSTATE 57014. In this
// adapter the timeout we set is the only cancellation source, so 57014 means the
// query ran too long — surface that as an actionable ValidationError (which core
// passes through to the caller intact) instead of letting a raw driver error be
// redacted to a generic "could not be processed", which reads to a model like a
// grammar mistake and sends it guessing at syntax.
function isStatementTimeout(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code
  if (code === "57014") return true
  const message = (err as { message?: unknown })?.message
  return typeof message === "string" && /statement timeout/i.test(message)
}

// Read-only adapter: no `mutate`, so core refuses writes. Adding writes is
// emit{Insert,Update,Delete} over the same driver, when a real need appears.
export class PostgresAdapter implements ValvAdapter {
  private schemaCache: SchemaMap | null = null

  constructor(
    private sql: PostgresSql,
    private options: PostgresAdapterOptions = {},
  ) {}

  async introspect(): Promise<SchemaMap> {
    this.schemaCache ??=
      this.options.schema ?? (await introspectPostgres(this.sql, this.options.namespace))
    return this.schemaCache
  }

  compile(query: Query, catalog: SchemaMap): CompiledQuery {
    return emit(query, catalog, postgresDialect, { database: this.options.namespace })
  }

  functions(): Record<string, FnDef> {
    return { ...BASE_FUNCTIONS, ...postgresDialect.functions }
  }

  async execute(sql: string, parameters: unknown[] = []): Promise<unknown[]> {
    try {
      return await this.runInTx(sql, parameters)
    } catch (err) {
      if (isStatementTimeout(err)) {
        throw new ValidationError(
          `Query timed out after ${STATEMENT_TIMEOUT_MS / 1000}s — it scanned too much data. ` +
            "Narrow it with a `where` filter, aggregate over a smaller slice, or reduce `take`, then retry.",
        )
      }
      throw err
    }
  }

  private runInTx(sql: string, parameters: unknown[]): Promise<unknown[]> {
    return this.sql.begin(async (tx) => {
      // SET LOCAL scopes both settings to this transaction. Values are our own
      // hardcoded literals (never user input), so inlining them is safe.
      await tx.unsafe(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`)
      // Pin the session to UTC so date_trunc (and any other tz-sensitive
      // operator) on a `timestamptz` truncates to UTC boundaries instead of the
      // server's local zone. Without this, dateTrunc buckets shift by the
      // server's offset and, worse, depend on where the query runs —
      // monthly/daily grouping would land on the wrong day. UTC also makes the
      // serialized ISO output stable across environments.
      await tx.unsafe(`SET LOCAL TIME ZONE 'UTC'`)
      const rows = await tx.unsafe(sql, parameters)
      return rows as unknown[]
    })
  }
}
