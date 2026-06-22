import type {
  ValvAdapter,
  SchemaMap,
  Query,
  CompiledQuery,
  FnDef,
  InjectedMutation,
  MutationResult,
} from "@valv/core"
import { emit, BASE_FUNCTIONS, ValidationError } from "@valv/core"
import { introspectClickHouse, type ClickHouseClient } from "./introspection"
import { clickhouseDialect } from "./dialect"

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

  functions(): Record<string, FnDef> {
    return { ...BASE_FUNCTIONS, ...clickhouseDialect.functions }
  }

  // ClickHouse is OLAP: INSERT is the natural write; UPDATE/DELETE are heavy async
  // mutations, so they're not exposed here. Inserts use the client's structured
  // insert (not a SQL statement); the row was already validated + policy-injected.
  async mutate(mutation: InjectedMutation, catalog: SchemaMap): Promise<MutationResult> {
    if (mutation.op !== "insert") {
      throw new ValidationError(`ClickHouse supports inserts only, not ${mutation.op}.`)
    }
    const resource = catalog.resources[mutation.from]
    if (!resource) throw new Error(`[valv/clickhouse] unknown resource "${mutation.from}"`)
    const table = this.options.database
      ? `${this.options.database}.${resource.tableName}`
      : resource.tableName
    await this.client.insert({ table, values: [mutation.values], format: "JSONEachRow" })
    return { affected: 1 }
  }

  /**
   * Run a compiled, parameterized SQL statement and return rows. Positional
   * parameters are bound as named ClickHouse query params (`p0`, `p1`, …),
   * matching the `{pN:Type}` placeholders the dialect emits.
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
