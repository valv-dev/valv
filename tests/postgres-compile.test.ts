import { describe, it, expect } from "vitest"
import { PostgresAdapter, type PostgresSql } from "@valv/postgres"
import type { SchemaMap, Query } from "@valv/core"

const schema: SchemaMap = {
  resources: {
    users: {
      name: "users",
      tableName: "users",
      relations: {},
      fields: {
        id: { name: "id", type: "number", nativeType: "integer", isNullable: false, isId: true },
        email: {
          name: "email",
          type: "string",
          nativeType: "text",
          isNullable: false,
          isId: false,
        },
        created_at: {
          name: "created_at",
          type: "date",
          nativeType: "timestamp with time zone",
          isNullable: false,
          isId: false,
        },
      },
    },
  },
}

// compile() never touches the client, so a stub is fine here.
const stub = {} as PostgresSql

describe("postgres adapter compile", () => {
  const adapter = new PostgresAdapter(stub, { schema })

  it("emits Postgres dialect SQL with $n placeholders", () => {
    const query: Query = {
      from: "users",
      select: [{ col: "email" }],
      where: {
        kind: "cmp",
        op: "=",
        left: { kind: "col", name: "id" },
        right: { kind: "value", value: 1 },
      },
      limit: 10,
    }
    const compiled = adapter.compile(query, schema)
    expect(compiled.sql).toBe('SELECT "email" FROM "users" WHERE ("id" = $1) LIMIT 10')
    expect(compiled.params.map((p) => p.value)).toEqual([1])
  })

  it("buckets by month with date_trunc", () => {
    const monthly: Query = {
      from: "users",
      select: [
        {
          fn: "dateTrunc",
          args: [
            { kind: "col", name: "created_at" },
            { kind: "value", value: "month" },
          ],
          as: "bucket",
        },
        { fn: "count", args: [], as: "signups" },
      ],
      groupBy: ["bucket"],
    }
    const { sql } = adapter.compile(monthly, schema)
    expect(sql).toBe(
      `SELECT date_trunc('month', "created_at") AS "bucket", count(*) AS "signups" FROM "users" GROUP BY "bucket"`,
    )
  })

  it("rejects an unknown trunc unit", () => {
    const bad: Query = {
      from: "users",
      select: [
        {
          fn: "dateTrunc",
          args: [
            { kind: "col", name: "created_at" },
            { kind: "value", value: "decade" },
          ],
        },
      ],
    }
    expect(() => adapter.compile(bad, schema)).toThrow(/one of/)
  })

  it("rejects a ClickHouse-only function (base + postgres functions only)", () => {
    const bad: Query = {
      from: "users",
      select: [
        {
          fn: "quantileTiming",
          args: [
            { kind: "value", value: 0.95 },
            { kind: "col", name: "id" },
          ],
        },
      ],
    }
    expect(() => adapter.compile(bad, schema)).toThrow(/not available/)
  })
})
