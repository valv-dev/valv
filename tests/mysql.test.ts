import { describe, it, expect } from "vitest"
import { MySqlAdapter, createValv, introspectMysql, type MySqlClient } from "@valv/mysql"
import type { SchemaMap, Query, DefaultContext } from "@valv/core"

// A fake mysql2/promise connection: routes introspection queries to canned rows
// by inspecting the SQL, records every call, and returns `[rows, fields]` like
// the real driver. The structural MySqlClient means no mysql2 install is needed.
function fakeMysql(handler: (sql: string) => unknown[] = () => []) {
  const calls: { sql: string; values?: unknown[] }[] = []
  const client: MySqlClient & { calls: typeof calls } = {
    calls,
    async query(sql: string, values?: unknown[]): Promise<[unknown, unknown]> {
      calls.push({ sql, values })
      return [handler(sql), []]
    },
  }
  return client
}

const ctx: DefaultContext = { user: { id: "u1", role: "member" }, tenant: { id: "acme" } }

// ── compile ──────────────────────────────────────────────────────────────────

const schema: SchemaMap = {
  resources: {
    orders: {
      name: "orders",
      tableName: "orders",
      relations: {},
      fields: {
        id: { name: "id", type: "number", nativeType: "int", isNullable: false, isId: true },
        tenant_id: {
          name: "tenant_id",
          type: "string",
          nativeType: "varchar(64)",
          isNullable: false,
          isId: false,
        },
        region: {
          name: "region",
          type: "string",
          nativeType: "varchar(64)",
          isNullable: false,
          isId: false,
        },
        created_at: {
          name: "created_at",
          type: "date",
          nativeType: "datetime",
          isNullable: false,
          isId: false,
        },
      },
    },
  },
}

describe("mysql adapter compile", () => {
  const adapter = new MySqlAdapter({} as MySqlClient, { schema })

  it("emits backtick identifiers and ? placeholders", () => {
    const query: Query = {
      from: "orders",
      select: [{ col: "region" }],
      where: {
        kind: "cmp",
        op: "=",
        left: { kind: "col", name: "id" },
        right: { kind: "value", value: 1 },
      },
      limit: 10,
    }
    const compiled = adapter.compile(query, schema)
    expect(compiled.sql).toBe("SELECT `region` FROM `orders` WHERE (`id` = ?) LIMIT 10")
    expect(compiled.params.map((p) => p.value)).toEqual([1])
  })

  it("renders ilike as LIKE (MySQL has no ILIKE keyword)", () => {
    const query: Query = {
      from: "orders",
      select: [{ col: "region" }],
      where: {
        kind: "cmp",
        op: "ilike",
        left: { kind: "col", name: "region" },
        right: { kind: "value", value: "e%" },
      },
    }
    const compiled = adapter.compile(query, schema)
    expect(compiled.sql).toBe("SELECT `region` FROM `orders` WHERE (`region` LIKE ?)")
    expect(compiled.params.map((p) => p.value)).toEqual(["e%"])
  })

  it("buckets by month with DATE_FORMAT (dateTrunc)", () => {
    const monthly: Query = {
      from: "orders",
      select: [
        {
          fn: "dateTrunc",
          args: [
            { kind: "col", name: "created_at" },
            { kind: "value", value: "month" },
          ],
          as: "bucket",
        },
        { fn: "count", args: [], as: "orders" },
      ],
      groupBy: ["bucket"],
    }
    const { sql } = adapter.compile(monthly, schema)
    expect(sql).toBe(
      "SELECT DATE_FORMAT(`created_at`, '%Y-%m-01') AS `bucket`, count(*) AS `orders` FROM `orders` GROUP BY `bucket`",
    )
  })
})

// ── introspection ────────────────────────────────────────────────────────────

const columnRows = [
  row("orders", "id", "int", "int", "NO", "PRI", 0),
  row("orders", "customer_id", "int", "int", "NO", "MUL", 0),
  row("orders", "status", "enum", "enum('pending','shipped','delivered')", "NO", "", 0),
  row("orders", "total", "decimal", "decimal(10,2)", "YES", "", 0),
  row("orders", "created_at", "datetime", "datetime", "YES", "", 1),
  row("orders", "is_paid", "tinyint", "tinyint(1)", "NO", "", 1),
  row("customers", "id", "int", "int", "NO", "PRI", 0),
  row("customers", "name", "varchar", "varchar(255)", "NO", "", 0),
  // Composite-PK table whose FK back to orders+customers is composite → skipped.
  row("order_lines", "order_id", "int", "int", "NO", "PRI", 0),
  row("order_lines", "line_no", "int", "int", "NO", "PRI", 0),
]

const fkRows = [
  fk("orders", "customer_id", "fk_orders_customer", "customers", "id"),
  // Two rows, same constraint → composite FK, must be dropped.
  fk("order_lines", "order_id", "fk_lines_order", "orders", "id"),
  fk("order_lines", "line_no", "fk_lines_order", "orders", "line_no"),
]

function row(
  table: string,
  column: string,
  dataType: string,
  columnType: string,
  nullable: string,
  key: string,
  hasDefault: number,
) {
  return {
    table_name: table,
    column_name: column,
    data_type: dataType,
    column_type: columnType,
    is_nullable: nullable,
    column_key: key,
    has_default: hasDefault,
  }
}

function fk(table: string, column: string, name: string, ftable: string, fcolumn: string) {
  return {
    table_name: table,
    column_name: column,
    constraint_name: name,
    foreign_table_name: ftable,
    foreign_column_name: fcolumn,
  }
}

const introspectHandler = (sql: string): unknown[] =>
  sql.includes("key_column_usage") ? fkRows : columnRows

describe("mysql introspection", () => {
  it("maps columns, types, enums, and keys", async () => {
    const map = await introspectMysql(fakeMysql(introspectHandler))
    const o = map.resources.orders
    expect(o).toBeDefined()

    expect(o.fields.id.isId).toBe(true)
    expect(o.fields.id.isPrimaryKeyPart).toBe(true)
    expect(o.fields.customer_id.isPrimaryKeyPart).toBe(false)

    expect(o.fields.status.type).toBe("enum")
    expect(o.fields.status.enumValues).toEqual(["pending", "shipped", "delivered"])

    expect(o.fields.total.type).toBe("number")
    expect(o.fields.total.isNullable).toBe(true)

    expect(o.fields.created_at.type).toBe("date")
    expect(o.fields.created_at.hasDefaultValue).toBe(true)

    // tinyint(1) is MySQL's idiomatic boolean.
    expect(o.fields.is_paid.type).toBe("boolean")
  })

  it("builds belongsTo/hasMany from a single-column FK", async () => {
    const map = await introspectMysql(fakeMysql(introspectHandler))
    // orders.customer_id → customers.id, named off the "_id" column.
    const belongsTo = map.resources.orders.relations.customer
    expect(belongsTo).toMatchObject({
      targetResource: "customers",
      type: "belongsTo",
      foreignKey: "customer_id",
      targetKey: "id",
    })
    const hasMany = map.resources.customers.relations.orders
    expect(hasMany).toMatchObject({
      targetResource: "orders",
      type: "hasMany",
      foreignKey: "customer_id",
    })
  })

  it("drops composite foreign keys (not representable as a single join key)", async () => {
    const map = await introspectMysql(fakeMysql(introspectHandler))
    // The only relation onto orders is the single-column customers one; the
    // composite order_lines FK must not have produced a relation.
    expect(Object.keys(map.resources.order_lines.relations)).toHaveLength(0)
    expect(map.resources.orders.relations.order_lines).toBeUndefined()
  })
})

describe("mysql introspection database option", () => {
  it("scopes to the current database() by default", async () => {
    const client = fakeMysql(introspectHandler)
    await introspectMysql(client)
    expect(client.calls.every((c) => c.sql.includes("table_schema = database()"))).toBe(true)
  })

  it("scopes to a named database and qualifies emitted tables", async () => {
    const client = fakeMysql(introspectHandler)
    const adapter = new MySqlAdapter(client, { database: "otherdb" })
    const catalog = await adapter.introspect()

    // Both introspection queries target the named database, not database().
    expect(client.calls.every((c) => c.sql.includes("table_schema = 'otherdb'"))).toBe(true)
    expect(client.calls.some((c) => c.sql.includes("database()"))).toBe(false)

    // Compiled SQL qualifies the table as `otherdb`.`orders`.
    const compiled = adapter.compile({ from: "orders", select: [{ col: "id" }] }, catalog)
    expect(compiled.sql).toContain("`otherdb`.`orders`")
  })
})

// ── execute (session settings) ───────────────────────────────────────────────

describe("mysql adapter execute", () => {
  it("pins timeout + UTC on the session before running, and returns rows", async () => {
    const client = fakeMysql((sql) => (sql.startsWith("SELECT") ? [{ n: 1 }] : []))
    const adapter = new MySqlAdapter(client, { schema })
    const out = await adapter.execute("SELECT `region` FROM `orders`", [])
    expect(out).toEqual([{ n: 1 }])

    const issued = client.calls.map((c) => c.sql)
    expect(issued[0]).toMatch(/max_execution_time = 10000/)
    expect(issued[1]).toBe("SET time_zone = '+00:00'")
    expect(issued[2]).toBe("SELECT `region` FROM `orders`")
  })
})

// ── end to end: policy injection through the query tool ──────────────────────

describe("mysql createValv end to end", () => {
  it("injects the row-scope predicate as a bound ? param", async () => {
    const client = fakeMysql(() => [])
    const valv = await createValv<DefaultContext>(client, { schema, defaultPolicy: "deny-all" })
    valv.policy("orders", (c) => ({ read: { tenant_id: c.tenant!.id } }))

    await valv.runTool("query", { from: "orders", select: { region: true } }, ctx)

    const queryCall = client.calls.find((c) => c.sql.startsWith("SELECT"))!
    expect(queryCall.sql).toContain("`region`")
    expect(queryCall.sql).toMatch(/WHERE .*`tenant_id` = \?/)
    // The tenant id reaches SQL only as a bound parameter, never inlined.
    expect(queryCall.values).toEqual(["acme"])
  })
})
