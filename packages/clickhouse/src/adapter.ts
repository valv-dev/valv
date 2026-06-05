import type { VistalAdapter, SchemaMap, ResolvedQuery } from "@vistal/core"
import { encodeCursor } from "@vistal/core"
import { introspectClickHouse, type ClickHouseClient } from "./introspection"
import { compileFilter, formatValue, quoteIdent } from "./sql"

export interface ClickHouseAdapterOptions {
  database?: string
}

export class ClickHouseAdapter implements VistalAdapter {
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

  private async executeFind(query: ResolvedQuery, table: string, one: boolean): Promise<unknown> {
    if (query.fields.length === 0) {
      throw new Error(
        `[vistal/clickhouse] find on "${query.resource}" resolved to zero fields — policy may be denying all fields`,
      )
    }

    const selectCols = query.fields.map(quoteIdent).join(", ")

    // findOne: simple SELECT ... LIMIT 1, returned unwrapped.
    if (one) {
      let sql = `SELECT ${selectCols} FROM ${table}`
      if (query.filters) sql += ` WHERE ${compileFilter(query.filters)}`
      if (query.sort) {
        sql += ` ORDER BY ${quoteIdent(query.sort.field)} ${query.sort.direction.toUpperCase()}`
      }
      sql += " LIMIT 1"
      const rows = await this.client
        .query({ query: sql, format: "JSONEachRow" })
        .then((r) => r.json() as Promise<unknown[]>)
      return rows[0] ?? null
    }

    // find: the builder guarantees sort + pagination (with primaryKey/cursorField);
    // fall back defensively for directly-constructed queries.
    const pag = query.pagination
    const pk = pag?.primaryKey ?? "id"
    const sort = query.sort ?? { field: pk, direction: "asc" as const }
    const dir = sort.direction.toUpperCase()
    const op = sort.direction === "asc" ? ">" : "<"

    const whereParts: string[] = []
    if (query.filters) whereParts.push(compileFilter(query.filters))
    if (pag?.keyset) {
      const ks = pag.keyset
      whereParts.push(
        sort.field === pk
          ? `${quoteIdent(pk)} ${op} ${formatValue(ks.id)}`
          : `(${quoteIdent(sort.field)} ${op} ${formatValue(ks.sortValue)} OR ` +
              `(${quoteIdent(sort.field)} = ${formatValue(ks.sortValue)} AND ${quoteIdent(pk)} ${op} ${formatValue(ks.id)}))`,
      )
    }

    let sql = `SELECT ${selectCols} FROM ${table}`
    if (whereParts.length > 0) sql += ` WHERE ${whereParts.join(" AND ")}`
    sql +=
      sort.field === pk
        ? ` ORDER BY ${quoteIdent(pk)} ${dir}`
        : ` ORDER BY ${quoteIdent(sort.field)} ${dir}, ${quoteIdent(pk)} ${dir}`

    const limit = pag?.limit
    if (limit !== undefined) sql += ` LIMIT ${limit + 1}`
    if (!pag?.keyset && pag?.offset !== undefined) sql += ` OFFSET ${pag.offset}`

    let rows = await this.client
      .query({ query: sql, format: "JSONEachRow" })
      .then((r) => r.json() as Promise<Record<string, unknown>[]>)
    const hasMore = limit !== undefined && rows.length > limit
    if (hasMore) rows = rows.slice(0, limit)

    let nextCursor: string | undefined
    if (hasMore && rows.length > 0) {
      const last = rows[rows.length - 1]
      nextCursor = encodeCursor({
        sortField: sort.field,
        direction: sort.direction,
        sortValue: last[sort.field],
        id: last[pk],
      })
    }

    if (query.internalFields?.length) {
      for (const row of rows) {
        for (const f of query.internalFields) delete row[f]
      }
    }

    return { data: rows, nextCursor, hasMore }
  }

  private async executeCreate(
    query: ResolvedQuery,
    tableName: string,
    db?: string,
  ): Promise<unknown> {
    const data = query.data ?? {}
    const table = db ? `${db}.${tableName}` : tableName

    await (
      this.client as unknown as {
        insert(params: { table: string; values: unknown[]; format: string }): Promise<unknown>
      }
    ).insert({
      table,
      values: [data],
      format: "JSONEachRow",
    })

    return data
  }

  private async executeUpdate(query: ResolvedQuery, table: string): Promise<unknown> {
    if (!query.filters) {
      throw new Error(
        `[vistal/clickhouse] update on "${query.resource}" has no WHERE clause — this would affect all rows and is not allowed`,
      )
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

    await (
      this.client as unknown as {
        command(params: {
          query: string
          clickhouse_settings?: Record<string, unknown>
        }): Promise<unknown>
      }
    ).command({
      query: sql,
      clickhouse_settings: { mutations_sync: 2 },
    })

    return { ok: true }
  }

  private async executeDelete(query: ResolvedQuery, table: string): Promise<unknown> {
    if (!query.filters) {
      throw new Error(
        `[vistal/clickhouse] delete on "${query.resource}" has no WHERE clause — this would delete all rows and is not allowed`,
      )
    }

    const where = compileFilter(query.filters)
    const sql = `DELETE FROM ${table} WHERE ${where}`

    await (
      this.client as unknown as {
        command(params: { query: string }): Promise<unknown>
      }
    ).command({ query: sql })

    return { ok: true }
  }

  private async executeAggregate(query: ResolvedQuery, table: string): Promise<unknown> {
    const aggs = query.aggregations ?? []
    const groupBy = query.groupBy ?? []

    const aggExprs = aggs.map((a) => {
      const alias = quoteIdent(a.alias)
      if (a.fn === "count" && (a.field === "*" || a.field === "id")) {
        return `count() AS ${alias}`
      }
      return `${a.fn}(${quoteIdent(a.field)}) AS ${alias}`
    })

    const selectParts = [...groupBy.map(quoteIdent), ...aggExprs]

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

    return this.client
      .query({ query: sql, format: "JSONEachRow" })
      .then((r) => r.json() as Promise<unknown[]>)
  }
}
