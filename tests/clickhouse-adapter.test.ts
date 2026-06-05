import { describe, it, expect, vi } from "vitest"
import {
  compileFilter,
  formatValue,
  escapeString,
  escapeLikePattern,
  quoteIdent,
} from "@vistal/clickhouse"
import { ClickHouseAdapter, introspectClickHouse } from "@vistal/clickhouse"
import type { ResolvedQuery } from "@vistal/core"

// ── SQL helpers ───────────────────────────────────────────────────────────────

describe("quoteIdent", () => {
  it("wraps in backticks", () => {
    expect(quoteIdent("status")).toBe("`status`")
  })
  it("doubles embedded backticks", () => {
    expect(quoteIdent("col`name")).toBe("`col``name`")
  })
})

describe("escapeString", () => {
  it("escapes single quotes", () => {
    expect(escapeString("it's")).toBe("it\\'s")
  })
  it("escapes backslashes", () => {
    expect(escapeString("a\\b")).toBe("a\\\\b")
  })
  it("escapes backslash-quote together", () => {
    expect(escapeString("a\\'b")).toBe("a\\\\\\'b")
  })
  it("SQL injection payload: OR 1=1 --", () => {
    const payload = "' OR 1=1 --"
    expect(escapeString(payload)).toBe("\\' OR 1=1 --")
  })
})

describe("escapeLikePattern", () => {
  it("escapes % and _ wildcards", () => {
    expect(escapeLikePattern("100%")).toBe("100\\%")
    expect(escapeLikePattern("file_name")).toBe("file\\_name")
  })
  it("escapes backslash", () => {
    expect(escapeLikePattern("a\\b")).toBe("a\\\\b")
  })
})

describe("formatValue", () => {
  it("NULL for null/undefined", () => {
    expect(formatValue(null)).toBe("NULL")
    expect(formatValue(undefined)).toBe("NULL")
  })
  it("booleans as 1/0", () => {
    expect(formatValue(true)).toBe("1")
    expect(formatValue(false)).toBe("0")
  })
  it("numbers as plain literals", () => {
    expect(formatValue(42)).toBe("42")
    expect(formatValue(3.14)).toBe("3.14")
    expect(formatValue(-1)).toBe("-1")
    expect(formatValue(0)).toBe("0")
  })
  it("throws on non-finite numbers", () => {
    expect(() => formatValue(Infinity)).toThrow()
    expect(() => formatValue(NaN)).toThrow()
    expect(() => formatValue(-Infinity)).toThrow()
  })
  it("strings are single-quoted and escaped", () => {
    expect(formatValue("hello")).toBe("'hello'")
    expect(formatValue("it's")).toBe("'it\\'s'")
    expect(formatValue("a\\b")).toBe("'a\\\\b'")
  })
  it("SQL injection via string", () => {
    const payload = "'; DROP TABLE orders; --"
    const result = formatValue(payload)
    // must not contain unescaped single quote after the opening one
    expect(result).toBe("'\\'; DROP TABLE orders; --'")
  })
  it("Date formats as UTC datetime string", () => {
    const d = new Date("2024-03-15T10:30:00Z")
    expect(formatValue(d)).toBe("'2024-03-15 10:30:00'")
  })
  it("objects become JSON strings", () => {
    const result = formatValue({ a: 1 })
    expect(result).toBe("'{\"a\":1}'")
  })
})

// ── compileFilter ─────────────────────────────────────────────────────────────

describe("compileFilter", () => {
  it("eq: basic equality", () => {
    expect(compileFilter({ type: "eq", field: "status", value: "active" })).toBe(
      "`status` = 'active'",
    )
  })
  it("eq: NULL value uses IS NULL", () => {
    expect(compileFilter({ type: "eq", field: "deleted_at", value: null })).toBe(
      "`deleted_at` IS NULL",
    )
  })
  it("eq: numeric value", () => {
    expect(compileFilter({ type: "eq", field: "amount", value: 100 })).toBe("`amount` = 100")
  })

  it("in: normal list", () => {
    expect(compileFilter({ type: "in", field: "status", values: ["a", "b"] })).toBe(
      "`status` IN ('a', 'b')",
    )
  })
  it("in: empty list → 1 = 0", () => {
    expect(compileFilter({ type: "in", field: "status", values: [] })).toBe("1 = 0")
  })

  it("range: gte and lte", () => {
    expect(compileFilter({ type: "range", field: "amount", gte: 10, lte: 100 })).toBe(
      "`amount` >= 10 AND `amount` <= 100",
    )
  })
  it("range: only gt", () => {
    expect(compileFilter({ type: "range", field: "amount", gt: 5 })).toBe("`amount` > 5")
  })
  it("range: lt only", () => {
    expect(compileFilter({ type: "range", field: "total", lt: 50000 })).toBe("`total` < 50000")
  })

  it("like: contains (default) → %pattern%", () => {
    expect(compileFilter({ type: "like", field: "name", value: "foo", mode: "contains" })).toBe(
      "`name` ILIKE '%foo%'",
    )
  })
  it("like: startsWith → pattern%", () => {
    expect(compileFilter({ type: "like", field: "name", value: "foo", mode: "startsWith" })).toBe(
      "`name` ILIKE 'foo%'",
    )
  })
  it("like: endsWith → %pattern", () => {
    expect(compileFilter({ type: "like", field: "name", value: "foo", mode: "endsWith" })).toBe(
      "`name` ILIKE '%foo'",
    )
  })
  it("like: % in user input is escaped so it matches literally", () => {
    // escapeLikePattern turns "100%" → "100\%"; then escapeString turns "\" → "\\"
    // in the SQL string literal, so ClickHouse receives pattern %100\%% where \% is literal %.
    expect(compileFilter({ type: "like", field: "name", value: "100%", mode: "contains" })).toBe(
      "`name` ILIKE '%100\\\\%%'",
    )
  })
  it("like: case-insensitive via ILIKE not LIKE", () => {
    const sql = compileFilter({ type: "like", field: "name", value: "Test" })
    expect(sql).toContain("ILIKE")
  })

  it("null: IS NULL", () => {
    expect(compileFilter({ type: "null", field: "deleted_at", isNull: true })).toBe(
      "`deleted_at` IS NULL",
    )
  })
  it("null: IS NOT NULL", () => {
    expect(compileFilter({ type: "null", field: "deleted_at", isNull: false })).toBe(
      "`deleted_at` IS NOT NULL",
    )
  })

  it("and: joins with AND, parenthesized", () => {
    expect(
      compileFilter({
        type: "and",
        filters: [
          { type: "eq", field: "status", value: "active" },
          { type: "eq", field: "tenant_id", value: "t1" },
        ],
      }),
    ).toBe("(`status` = 'active' AND `tenant_id` = 't1')")
  })
  it("and: empty → 1 = 1", () => {
    expect(compileFilter({ type: "and", filters: [] })).toBe("1 = 1")
  })

  it("or: joins with OR, parenthesized", () => {
    expect(
      compileFilter({
        type: "or",
        filters: [
          { type: "eq", field: "status", value: "a" },
          { type: "eq", field: "status", value: "b" },
        ],
      }),
    ).toBe("(`status` = 'a' OR `status` = 'b')")
  })
  it("or: empty → 1 = 0", () => {
    expect(compileFilter({ type: "or", filters: [] })).toBe("1 = 0")
  })

  it("not: wraps in NOT (...)", () => {
    expect(
      compileFilter({
        type: "not",
        filter: { type: "eq", field: "status", value: "deleted" },
      }),
    ).toBe("NOT (`status` = 'deleted')")
  })

  it("deeply nested: AND(tenant_id=t1, OR(total>=10000, status=pending))", () => {
    expect(
      compileFilter({
        type: "and",
        filters: [
          { type: "eq", field: "tenant_id", value: "t1" },
          {
            type: "or",
            filters: [
              { type: "range", field: "total", gte: 10000 },
              { type: "eq", field: "status", value: "pending" },
            ],
          },
        ],
      }),
    ).toBe("(`tenant_id` = 't1' AND (`total` >= 10000 OR `status` = 'pending'))")
  })

  it("not(and(eq, like)) — negated compound", () => {
    expect(
      compileFilter({
        type: "not",
        filter: {
          type: "and",
          filters: [
            { type: "eq", field: "status", value: "cancelled" },
            { type: "like", field: "name", value: "test", mode: "contains" },
          ],
        },
      }),
    ).toBe("NOT ((`status` = 'cancelled' AND `name` ILIKE '%test%'))")
  })
})

// ── ClickHouseAdapter.execute ─────────────────────────────────────────────────

function makeClient() {
  const rows: unknown[] = []
  const query = vi.fn().mockResolvedValue({ json: () => Promise.resolve(rows) })
  const insert = vi.fn().mockResolvedValue(undefined)
  const command = vi.fn().mockResolvedValue(undefined)
  return { client: { query, insert, command }, mocks: { query, insert, command } }
}

function makeAdapterWithSchema() {
  const { client, mocks } = makeClient()

  // Patch introspect so tests don't need to mock system.columns
  const adapter = new ClickHouseAdapter(client as never, { database: "analytics" })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(adapter as any).schemaCache = {
    resources: {
      orders: {
        name: "orders",
        tableName: "orders",
        fields: {
          id: { name: "id", type: "uuid", isNullable: false, isId: true },
          status: { name: "status", type: "string", isNullable: false, isId: false },
          total: { name: "total", type: "number", isNullable: false, isId: false },
          tenant_id: { name: "tenant_id", type: "string", isNullable: false, isId: false },
        },
        relations: {},
      },
    },
  }
  return { adapter, mocks }
}

describe("ClickHouseAdapter.execute", () => {
  it("find → SELECT quoted fields WHERE and ORDER BY and LIMIT/OFFSET", async () => {
    const { adapter, mocks } = makeAdapterWithSchema()
    const query: ResolvedQuery = {
      resource: "orders",
      operation: "find",
      fields: ["id", "status", "total"],
      filters: { type: "eq", field: "tenant_id", value: "t1" },
      sort: { field: "total", direction: "desc" },
      pagination: { limit: 10, offset: 20 },
    }
    await adapter.execute(query)
    const sql: string = mocks.query.mock.calls[0][0].query
    expect(sql).toContain("SELECT `id`, `status`, `total`")
    expect(sql).toContain("FROM `analytics`.`orders`")
    expect(sql).toContain("WHERE `tenant_id` = 't1'")
    // sort field + primary-key tiebreaker for stable keyset ordering
    expect(sql).toContain("ORDER BY `total` DESC, `id` DESC")
    // LIMIT is limit + 1 (one extra row probes for a next page)
    expect(sql).toContain("LIMIT 11")
    expect(sql).toContain("OFFSET 20")
  })

  it("find with cursor → keyset WHERE, pk tiebreaker ORDER BY, LIMIT+1", async () => {
    const { adapter, mocks } = makeAdapterWithSchema()
    const query: ResolvedQuery = {
      resource: "orders",
      operation: "find",
      fields: ["id", "total"],
      filters: { type: "eq", field: "tenant_id", value: "t1" },
      sort: { field: "total", direction: "asc" },
      pagination: {
        limit: 10,
        primaryKey: "id",
        cursorField: "total",
        keyset: { sortField: "total", direction: "asc", sortValue: 50, id: "o9" },
      },
    }
    await adapter.execute(query)
    const sql: string = mocks.query.mock.calls[0][0].query
    expect(sql).toContain(
      "WHERE `tenant_id` = 't1' AND (`total` > 50 OR (`total` = 50 AND `id` > 'o9'))",
    )
    expect(sql).toContain("ORDER BY `total` ASC, `id` ASC")
    expect(sql).toContain("LIMIT 11")
    expect(sql).not.toContain("OFFSET")
  })

  it("find returns a { data, nextCursor, hasMore } envelope", async () => {
    const { client, mocks } = makeClient()
    mocks.query.mockResolvedValue({
      json: () =>
        Promise.resolve([
          { id: "a", total: 1 },
          { id: "b", total: 2 },
          { id: "c", total: 3 },
        ]),
    })
    const adapter = new ClickHouseAdapter(client as never, { database: "analytics" })
    ;(adapter as never as { schemaCache: unknown }).schemaCache = {
      resources: {
        orders: {
          name: "orders",
          tableName: "orders",
          relations: {},
          fields: {
            id: { name: "id", type: "uuid", isNullable: false, isId: true },
            total: { name: "total", type: "number", isNullable: false, isId: false },
          },
        },
      },
    }
    const res = (await adapter.execute({
      resource: "orders",
      operation: "find",
      fields: ["id", "total"],
      sort: { field: "total", direction: "asc" },
      pagination: { limit: 2, primaryKey: "id", cursorField: "total" },
    })) as { data: unknown[]; nextCursor?: string; hasMore: boolean }
    expect(res.data).toHaveLength(2)
    expect(res.hasMore).toBe(true)
    expect(res.nextCursor).toBeDefined()
  })

  it("find without filters — no WHERE clause emitted", async () => {
    const { adapter, mocks } = makeAdapterWithSchema()
    const query: ResolvedQuery = {
      resource: "orders",
      operation: "find",
      fields: ["id"],
    }
    await adapter.execute(query)
    const sql: string = mocks.query.mock.calls[0][0].query
    expect(sql).not.toContain("WHERE")
  })

  it("find with empty fields throws", async () => {
    const { adapter } = makeAdapterWithSchema()
    const query: ResolvedQuery = {
      resource: "orders",
      operation: "find",
      fields: [],
    }
    await expect(adapter.execute(query)).rejects.toThrow("zero fields")
  })

  it("findOne → SELECT ... LIMIT 1, returns first row or null", async () => {
    const { client, mocks } = makeClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new ClickHouseAdapter(client as any, { database: "analytics" })
    ;(adapter as any).schemaCache = {
      resources: {
        orders: {
          name: "orders",
          tableName: "orders",
          fields: { id: { name: "id", type: "uuid", isNullable: false, isId: true } },
          relations: {},
        },
      },
    }

    mocks.query.mockResolvedValueOnce({ json: () => Promise.resolve([{ id: "abc" }]) })
    const result = await adapter.execute({
      resource: "orders",
      operation: "findOne",
      fields: ["id"],
      filters: { type: "eq", field: "id", value: "abc" },
    })
    expect(result).toEqual({ id: "abc" })
    const sql: string = mocks.query.mock.calls[0][0].query
    expect(sql).toContain("LIMIT 1")
  })

  it("findOne → null when no rows", async () => {
    const { adapter } = makeAdapterWithSchema()
    const result = await adapter.execute({
      resource: "orders",
      operation: "findOne",
      fields: ["id"],
      filters: { type: "eq", field: "id", value: "missing" },
    })
    expect(result).toBeNull()
  })

  it("create → client.insert called with values array; returns data", async () => {
    const { adapter, mocks } = makeAdapterWithSchema()
    const data = { status: "pending", total: 9999, tenant_id: "t1" }
    const result = await adapter.execute({
      resource: "orders",
      operation: "create",
      fields: ["status", "total", "tenant_id"],
      data,
    })
    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        table: "analytics.orders",
        values: [data],
        format: "JSONEachRow",
      }),
    )
    expect(result).toEqual(data)
  })

  it("update → ALTER TABLE ... UPDATE ... WHERE, uses mutations_sync: 2", async () => {
    const { adapter, mocks } = makeAdapterWithSchema()
    await adapter.execute({
      resource: "orders",
      operation: "update",
      fields: ["status"],
      filters: {
        type: "and",
        filters: [
          { type: "eq", field: "id", value: "order-1" },
          { type: "eq", field: "tenant_id", value: "t1" },
        ],
      },
      data: { status: "shipped" },
    })
    const call = mocks.command.mock.calls[0]
    const sql: string = call[0].query
    expect(sql).toMatch(/ALTER TABLE .* UPDATE `status` = 'shipped' WHERE/)
    expect(sql).toContain("`id` = 'order-1'")
    expect(sql).toContain("`tenant_id` = 't1'")
    expect(call[0].clickhouse_settings?.mutations_sync).toBe(2)
    const result = await adapter.execute({
      resource: "orders",
      operation: "update",
      fields: ["status"],
      filters: { type: "eq", field: "id", value: "x" },
      data: { status: "x" },
    })
    expect(result).toEqual({ ok: true })
  })

  it("update without WHERE throws", async () => {
    const { adapter } = makeAdapterWithSchema()
    await expect(
      adapter.execute({
        resource: "orders",
        operation: "update",
        fields: ["status"],
        data: { status: "boom" },
      }),
    ).rejects.toThrow("no WHERE clause")
  })

  it("delete → DELETE FROM ... WHERE", async () => {
    const { adapter, mocks } = makeAdapterWithSchema()
    await adapter.execute({
      resource: "orders",
      operation: "delete",
      fields: [],
      filters: { type: "eq", field: "id", value: "order-1" },
    })
    const sql: string = mocks.command.mock.calls[0][0].query
    expect(sql).toMatch(/DELETE FROM .* WHERE/)
    expect(sql).toContain("`id` = 'order-1'")
  })

  it("delete without WHERE throws", async () => {
    const { adapter } = makeAdapterWithSchema()
    await expect(
      adapter.execute({
        resource: "orders",
        operation: "delete",
        fields: [],
      }),
    ).rejects.toThrow("no WHERE clause")
  })

  it("aggregate flat count → count() AS `total`", async () => {
    const { adapter, mocks } = makeAdapterWithSchema()
    await adapter.execute({
      resource: "orders",
      operation: "aggregate",
      fields: [],
      filters: { type: "eq", field: "tenant_id", value: "t1" },
      aggregations: [{ fn: "count", field: "id", alias: "total" }],
    })
    const sql: string = mocks.query.mock.calls[0][0].query
    expect(sql).toContain("count() AS `total`")
    expect(sql).toContain("WHERE `tenant_id` = 't1'")
  })

  it("aggregate sum + avg → sum(`total`) + avg(`total`)", async () => {
    const { adapter, mocks } = makeAdapterWithSchema()
    await adapter.execute({
      resource: "orders",
      operation: "aggregate",
      fields: [],
      aggregations: [
        { fn: "sum", field: "total", alias: "revenue" },
        { fn: "avg", field: "total", alias: "avg_order" },
      ],
    })
    const sql: string = mocks.query.mock.calls[0][0].query
    expect(sql).toContain("sum(`total`) AS `revenue`")
    expect(sql).toContain("avg(`total`) AS `avg_order`")
  })

  it("aggregate groupBy → GROUP BY clause", async () => {
    const { adapter, mocks } = makeAdapterWithSchema()
    await adapter.execute({
      resource: "orders",
      operation: "aggregate",
      fields: [],
      filters: { type: "eq", field: "tenant_id", value: "t1" },
      aggregations: [{ fn: "sum", field: "total", alias: "revenue" }],
      groupBy: ["status"],
    })
    const sql: string = mocks.query.mock.calls[0][0].query
    expect(sql).toContain("GROUP BY `status`")
    expect(sql).toContain("WHERE `tenant_id` = 't1'")
    expect(sql).toMatch(/SELECT.*`status`.*sum\(`total`\)/)
  })

  it("aggregate groupBy multi-field", async () => {
    const { adapter, mocks } = makeAdapterWithSchema()
    await adapter.execute({
      resource: "orders",
      operation: "aggregate",
      fields: [],
      aggregations: [
        { fn: "count", field: "id", alias: "order_count" },
        { fn: "sum", field: "total", alias: "revenue" },
      ],
      groupBy: ["status", "tenant_id"],
    })
    const sql: string = mocks.query.mock.calls[0][0].query
    expect(sql).toContain("GROUP BY `status`, `tenant_id`")
    expect(sql).toContain("count() AS `order_count`")
    expect(sql).toContain("sum(`total`) AS `revenue`")
  })

  it("find uses JSONEachRow format", async () => {
    const { adapter, mocks } = makeAdapterWithSchema()
    await adapter.execute({ resource: "orders", operation: "find", fields: ["id"] })
    expect(mocks.query.mock.calls[0][0].format).toBe("JSONEachRow")
  })

  it("SELECT never uses *", async () => {
    const { adapter, mocks } = makeAdapterWithSchema()
    await adapter.execute({ resource: "orders", operation: "find", fields: ["id", "status"] })
    const sql: string = mocks.query.mock.calls[0][0].query
    expect(sql).not.toMatch(/SELECT \*/)
  })
})

// ── introspectClickHouse ──────────────────────────────────────────────────────

describe("introspectClickHouse", () => {
  function makeIntrospectClient(columns: object[], tables: object[] = []) {
    return {
      query: vi.fn().mockImplementation(({ query }: { query: string }) => {
        if (query.includes("system.columns")) {
          return Promise.resolve({ json: () => Promise.resolve(columns) })
        }
        if (query.includes("system.tables")) {
          return Promise.resolve({ json: () => Promise.resolve(tables) })
        }
        if (query.includes("currentDatabase")) {
          return Promise.resolve({ json: () => Promise.resolve([{ db: "analytics" }]) })
        }
        return Promise.resolve({ json: () => Promise.resolve([]) })
      }),
    }
  }

  it("maps String → string, Int32 → number, Bool → boolean, Date → date, UUID → uuid", async () => {
    const client = makeIntrospectClient([
      {
        table: "events",
        name: "id",
        type: "UUID",
        position: 1,
        default_kind: "",
        is_in_primary_key: 1,
        comment: "",
      },
      {
        table: "events",
        name: "name",
        type: "String",
        position: 2,
        default_kind: "",
        is_in_primary_key: 0,
        comment: "",
      },
      {
        table: "events",
        name: "count",
        type: "Int32",
        position: 3,
        default_kind: "",
        is_in_primary_key: 0,
        comment: "",
      },
      {
        table: "events",
        name: "active",
        type: "Bool",
        position: 4,
        default_kind: "",
        is_in_primary_key: 0,
        comment: "",
      },
      {
        table: "events",
        name: "created_at",
        type: "DateTime",
        position: 5,
        default_kind: "",
        is_in_primary_key: 0,
        comment: "",
      },
    ])
    const schema = await introspectClickHouse(client as never, "analytics")
    const fields = schema.resources["events"].fields
    expect(fields["id"].type).toBe("uuid")
    expect(fields["name"].type).toBe("string")
    expect(fields["count"].type).toBe("number")
    expect(fields["active"].type).toBe("boolean")
    expect(fields["created_at"].type).toBe("date")
  })

  it("Nullable(String) → isNullable: true", async () => {
    const client = makeIntrospectClient([
      {
        table: "t",
        name: "deleted_at",
        type: "Nullable(DateTime)",
        position: 1,
        default_kind: "",
        is_in_primary_key: 0,
        comment: "",
      },
    ])
    const schema = await introspectClickHouse(client as never, "analytics")
    expect(schema.resources["t"].fields["deleted_at"].isNullable).toBe(true)
    expect(schema.resources["t"].fields["deleted_at"].type).toBe("date")
  })

  it("LowCardinality(String) → string", async () => {
    const client = makeIntrospectClient([
      {
        table: "t",
        name: "status",
        type: "LowCardinality(String)",
        position: 1,
        default_kind: "",
        is_in_primary_key: 0,
        comment: "",
      },
    ])
    const schema = await introspectClickHouse(client as never, "analytics")
    expect(schema.resources["t"].fields["status"].type).toBe("string")
  })

  it("column named 'id' is always isId, even if not in primary key", async () => {
    const client = makeIntrospectClient([
      {
        table: "t",
        name: "id",
        type: "UUID",
        position: 1,
        default_kind: "",
        is_in_primary_key: 0,
        comment: "",
      },
      {
        table: "t",
        name: "val",
        type: "String",
        position: 2,
        default_kind: "",
        is_in_primary_key: 1,
        comment: "",
      },
    ])
    const schema = await introspectClickHouse(client as never, "analytics")
    expect(schema.resources["t"].fields["id"].isId).toBe(true)
    expect(schema.resources["t"].fields["val"].isId).toBe(false)
  })

  it("first primary-key column is isId when no 'id' column exists", async () => {
    const client = makeIntrospectClient([
      {
        table: "t",
        name: "pk_col",
        type: "UUID",
        position: 1,
        default_kind: "",
        is_in_primary_key: 1,
        comment: "",
      },
      {
        table: "t",
        name: "other",
        type: "String",
        position: 2,
        default_kind: "",
        is_in_primary_key: 0,
        comment: "",
      },
    ])
    const schema = await introspectClickHouse(client as never, "analytics")
    expect(schema.resources["t"].fields["pk_col"].isId).toBe(true)
    expect(schema.resources["t"].fields["other"].isId).toBe(false)
  })

  it("non-empty default_kind → hasDefaultValue: true", async () => {
    const client = makeIntrospectClient([
      {
        table: "t",
        name: "created_at",
        type: "DateTime",
        position: 1,
        default_kind: "DEFAULT",
        is_in_primary_key: 0,
        comment: "",
      },
      {
        table: "t",
        name: "name",
        type: "String",
        position: 2,
        default_kind: "",
        is_in_primary_key: 0,
        comment: "",
      },
    ])
    const schema = await introspectClickHouse(client as never, "analytics")
    expect(schema.resources["t"].fields["created_at"].hasDefaultValue).toBe(true)
    expect(schema.resources["t"].fields["name"].hasDefaultValue).toBe(false)
  })

  it("@vistal:sensitive comment → sensitive: true", async () => {
    const client = makeIntrospectClient([
      {
        table: "users",
        name: "password_hash",
        type: "String",
        position: 1,
        default_kind: "",
        is_in_primary_key: 0,
        comment: "@vistal:sensitive",
      },
      {
        table: "users",
        name: "email",
        type: "String",
        position: 2,
        default_kind: "",
        is_in_primary_key: 0,
        comment: "",
      },
    ])
    const schema = await introspectClickHouse(client as never, "analytics")
    expect(schema.resources["users"].fields["password_hash"].sensitive).toBe(true)
    expect(schema.resources["users"].fields["email"].sensitive).toBe(false)
  })

  it("@vistal:description comment → description string", async () => {
    const client = makeIntrospectClient([
      {
        table: "orders",
        name: "total",
        type: "Int64",
        position: 1,
        default_kind: "",
        is_in_primary_key: 0,
        comment: '@vistal:description "Order total in cents"',
      },
    ])
    const schema = await introspectClickHouse(client as never, "analytics")
    expect(schema.resources["orders"].fields["total"].description).toBe("Order total in cents")
  })

  it("table description from system.tables comment", async () => {
    const client = makeIntrospectClient(
      [
        {
          table: "orders",
          name: "id",
          type: "UUID",
          position: 1,
          default_kind: "",
          is_in_primary_key: 1,
          comment: "",
        },
      ],
      [{ name: "orders", comment: '@vistal:description "Customer orders"' }],
    )
    const schema = await introspectClickHouse(client as never, "analytics")
    expect(schema.resources["orders"].description).toBe("Customer orders")
  })

  it("Enum8 → enum with values parsed", async () => {
    const client = makeIntrospectClient([
      {
        table: "orders",
        name: "status",
        type: "Enum8('pending' = 1, 'shipped' = 2, 'delivered' = 3)",
        position: 1,
        default_kind: "",
        is_in_primary_key: 0,
        comment: "",
      },
    ])
    const schema = await introspectClickHouse(client as never, "analytics")
    const f = schema.resources["orders"].fields["status"]
    expect(f.type).toBe("enum")
    expect(f.enumValues).toEqual(["pending", "shipped", "delivered"])
  })

  it("unknown ClickHouse types are skipped", async () => {
    const client = makeIntrospectClient([
      {
        table: "t",
        name: "id",
        type: "UUID",
        position: 1,
        default_kind: "",
        is_in_primary_key: 1,
        comment: "",
      },
      {
        table: "t",
        name: "data",
        type: "Ring",
        position: 2,
        default_kind: "",
        is_in_primary_key: 0,
        comment: "",
      },
    ])
    const schema = await introspectClickHouse(client as never, "analytics")
    expect(schema.resources["t"].fields["data"]).toBeUndefined()
    expect(schema.resources["t"].fields["id"]).toBeDefined()
  })

  it("resolves currentDatabase() when no database argument given", async () => {
    const client = makeIntrospectClient([])
    await introspectClickHouse(client as never)
    const queries: string[] = client.query.mock.calls.map((c: [{ query: string }]) => c[0].query)
    expect(queries.some((q) => q.includes("currentDatabase"))).toBe(true)
  })
})
