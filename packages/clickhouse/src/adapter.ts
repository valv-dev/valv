import type { ValvAdapter, SchemaMap } from "@valv/core"
import { introspectClickHouse, type ClickHouseClient } from "./introspection"

export interface ClickHouseAdapterOptions {
  database?: string
}

export class ClickHouseAdapter implements ValvAdapter {
  private schemaCache: SchemaMap | null = null

  constructor(
    private client: ClickHouseClient,
    private options: ClickHouseAdapterOptions = {},
  ) {}

  async introspect(): Promise<SchemaMap> {
    if (!this.schemaCache) {
      this.schemaCache = await introspectClickHouse(this.client, this.options.database)
    }
    return this.schemaCache
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
