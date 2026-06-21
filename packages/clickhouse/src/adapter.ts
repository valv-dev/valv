import type { ValvAdapter, SchemaMap, Query, CompiledQuery } from "@valv/core"
import { emit } from "@valv/core"
import { introspectClickHouse, type ClickHouseClient } from "./introspection"
import { clickhouseDialect } from "./emit"

export interface ClickHouseAdapterOptions {
  database?: string
  /** Declare the schema by hand instead of querying system.* to introspect it. */
  schema?: SchemaMap
}

// Per-query safety caps so a structurally-valid query can't run away on the
// server. They bound wall-clock and result size — a tiny `WHERE col > x` that
// would otherwise full-scan a billion-row table is killed at 30s. Conservative
// defaults; raise per deployment if real analytics needs more headroom.
const QUERY_SETTINGS = {
  max_execution_time: 30,
  max_result_rows: 10000,
  max_result_bytes: 100_000_000,
  result_overflow_mode: "throw",
} as const

export class ClickHouseAdapter implements ValvAdapter {
  private schemaCache: SchemaMap | null = null

  constructor(
    private client: ClickHouseClient,
    private options: ClickHouseAdapterOptions = {},
  ) {}

  async introspect(): Promise<SchemaMap> {
    this.schemaCache ??=
      this.options.schema ?? (await introspectClickHouse(this.client, this.options.database))
    return this.schemaCache
  }

  compile(query: Query, catalog: SchemaMap): CompiledQuery {
    return emit(query, catalog, clickhouseDialect, { database: this.options.database })
  }

  /**
   * Run a compiled, parameterized SQL statement and return rows. Positional
   * parameters are bound as named ClickHouse query params (`p0`, `p1`, …); the
   * SQL emitter (Kysely ClickHouse dialect) produces matching placeholders.
   */
  async execute(sql: string, parameters: unknown[] = []): Promise<unknown[]> {
    const result = await this.client.query({
      query: sql,
      format: "JSONEachRow",
      clickhouse_settings: QUERY_SETTINGS,
      ...(parameters.length ? { query_params: toQueryParams(parameters) } : {}),
    })
    return (await result.json()) as unknown[]
  }
}

function toQueryParams(parameters: unknown[]): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  parameters.forEach((value, i) => {
    params[`p${i}`] = value
  })
  return params
}
