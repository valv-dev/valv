import type { ValvAdapter, SchemaMap, Query, CompiledQuery, FnDef } from "@valv/core"
import { emit, BASE_FUNCTIONS, postgresDialect } from "@valv/core"
import { introspectPostgres, type PostgresSql } from "./introspection"

export interface PostgresAdapterOptions {
  /** Declare the schema by hand instead of querying information_schema. */
  schema?: SchemaMap
}

// Per-query wall-clock cap so a structurally-valid query (e.g. a join that scans
// far more than expected) can't run away on the server. Applied via
// `SET LOCAL statement_timeout` inside the transaction that runs the query.
const STATEMENT_TIMEOUT_MS = 10_000

// Read-only adapter: no `mutate`, so core refuses writes. Adding writes is
// emit{Insert,Update,Delete} over the same driver, when a real need appears.
export class PostgresAdapter implements ValvAdapter {
  private schemaCache: SchemaMap | null = null

  constructor(
    private sql: PostgresSql,
    private options: PostgresAdapterOptions = {},
  ) {}

  async introspect(): Promise<SchemaMap> {
    this.schemaCache ??= this.options.schema ?? (await introspectPostgres(this.sql))
    return this.schemaCache
  }

  compile(query: Query, catalog: SchemaMap): CompiledQuery {
    return emit(query, catalog, postgresDialect)
  }

  functions(): Record<string, FnDef> {
    return { ...BASE_FUNCTIONS, ...postgresDialect.functions }
  }

  async execute(sql: string, parameters: unknown[] = []): Promise<unknown[]> {
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
