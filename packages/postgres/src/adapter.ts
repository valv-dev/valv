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
      // SET LOCAL scopes the timeout to this transaction. The value is our own
      // hardcoded integer (never user input), so inlining it is safe.
      await tx.unsafe(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`)
      const rows = await tx.unsafe(sql, parameters)
      return rows as unknown[]
    })
  }
}
