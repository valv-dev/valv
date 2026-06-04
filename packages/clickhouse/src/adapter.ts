import type { VistalAdapter, SchemaMap, ResolvedQuery } from "@vistal/core"
import { introspectClickHouse, type ClickHouseClient } from "./introspection"
import { compileFilter, formatValue, quoteIdent } from "./sql"

export interface ClickHouseAdapterOptions {
  database?: string
}

export class ClickHouseAdapter implements VistalAdapter {
  private schemaCache: SchemaMap | null = null

  constructor(
    private client: ClickHouseClient,
    private options: ClickHouseAdapterOptions = {}
  ) {}

  async introspect(): Promise<SchemaMap> {
    if (!this.schemaCache) {
      this.schemaCache = await introspectClickHouse(this.client, this.options.database)
    }
    return this.schemaCache
  }

  async execute(query: ResolvedQuery): Promise<unknown> {
    const schema = await this.introspect()
    const resource = schema.resources[query.resource]
    const tableName = resource?.tableName ?? query.resource
    const db = this.options.database
    const table = db ? `${quoteIdent(db)}.${quoteIdent(tableName)}` : quoteIdent(tableName)

    switch (query.operation) {
      case "find":
        return this.executeFind(query, table, false)
      case "findOne":
        return this.executeFind(query, table, true)
      case "create":
        return this.executeCreate(query, tableName, db)
      case "update":
        return this.executeUpdate(query, table)
      case "delete":
        return this.executeDelete(query, table)
      case "aggregate":
        return this.executeAggregate(query, table)
      default:
        throw new Error(`Unsupported operation: ${(query as ResolvedQuery).operation}`)
    }
  }

  private async executeFind(
    query: ResolvedQuery,
    table: string,
    one: boolean
  ): Promise<unknown> {
    if (query.fields.length === 0) {
      throw new Error(`[vistal/clickhouse] find on "${query.resource}" resolved to zero fields — policy may be denying all fields`)
    }

    const selectCols = query.fields.map(quoteIdent).join(", ")
    let sql = `SELECT ${selectCols} FROM ${table}`

    if (query.filters) {
      sql += ` WHERE ${compileFilter(query.filters)}`
    }

    if (query.sort) {
      sql += ` ORDER BY ${quoteIdent(query.sort.field)} ${query.sort.direction.toUpperCase()}`
    }

    if (one) {
      sql += " LIMIT 1"
    } else if (query.pagination) {
      if (query.pagination.limit !== undefined) {
        sql += ` LIMIT ${query.pagination.limit}`
      }
      if (query.pagination.offset !== undefined) {
        sql += ` OFFSET ${query.pagination.offset}`
      }
    }

    const rows = await this.client.query({ query: sql, format: "JSONEachRow" }).then(r => r.json() as Promise<unknown[]>)

    return one ? (rows[0] ?? null) : rows
  }

  private async executeCreate(
    query: ResolvedQuery,
    tableName: string,
    db?: string
  ): Promise<unknown> {
    const data = query.data ?? {}
    const table = db ? `${db}.${tableName}` : tableName

    await (this.client as unknown as {
      insert(params: { table: string; values: unknown[]; format: string }): Promise<unknown>
    }).insert({
      table,
      values: [data],
      format: "JSONEachRow",
    })

    return data
  }

  private async executeUpdate(query: ResolvedQuery, table: string): Promise<unknown> {
    if (!query.filters) {
      throw new Error(`[vistal/clickhouse] update on "${query.resource}" has no WHERE clause — this would affect all rows and is not allowed`)
    }

    const data = query.data ?? {}
    const assignments = Object.entries(data)
      .map(([col, val]) => `${quoteIdent(col)} = ${formatValue(val)}`)
      .join(", ")

    if (!assignments) {
      throw new Error(`[vistal/clickhouse] update on "${query.resource}" has no data fields to set`)
    }

    const where = compileFilter(query.filters)
    const sql = `ALTER TABLE ${table} UPDATE ${assignments} WHERE ${where}`

    await (this.client as unknown as {
      command(params: { query: string; clickhouse_settings?: Record<string, unknown> }): Promise<unknown>
    }).command({
      query: sql,
      clickhouse_settings: { mutations_sync: 2 },
    })

    return { ok: true }
  }

  private async executeDelete(query: ResolvedQuery, table: string): Promise<unknown> {
    if (!query.filters) {
      throw new Error(`[vistal/clickhouse] delete on "${query.resource}" has no WHERE clause — this would delete all rows and is not allowed`)
    }

    const where = compileFilter(query.filters)
    const sql = `DELETE FROM ${table} WHERE ${where}`

    await (this.client as unknown as {
      command(params: { query: string }): Promise<unknown>
    }).command({ query: sql })

    return { ok: true }
  }

  private async executeAggregate(query: ResolvedQuery, table: string): Promise<unknown> {
    const aggs = query.aggregations ?? []
    const groupBy = query.groupBy ?? []

    const aggExprs = aggs.map(a => {
      const alias = quoteIdent(a.alias)
      if (a.fn === "count" && (a.field === "*" || a.field === "id")) {
        return `count() AS ${alias}`
      }
      return `${a.fn}(${quoteIdent(a.field)}) AS ${alias}`
    })

    const selectParts = [
      ...groupBy.map(quoteIdent),
      ...aggExprs,
    ]

    if (selectParts.length === 0) {
      selectParts.push("count() AS `count`")
    }

    let sql = `SELECT ${selectParts.join(", ")} FROM ${table}`

    if (query.filters) {
      sql += ` WHERE ${compileFilter(query.filters)}`
    }

    if (groupBy.length > 0) {
      sql += ` GROUP BY ${groupBy.map(quoteIdent).join(", ")}`
    }

    if (query.having) {
      sql += ` HAVING ${compileFilter(query.having)}`
    }

    return this.client.query({ query: sql, format: "JSONEachRow" }).then(r => r.json() as Promise<unknown[]>)
  }
}
