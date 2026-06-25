import { describe, it, expect } from "vitest"
import { PrismaAdapter } from "@valv/prisma"
import type { PrismaClient } from "@prisma/client"
import type { SchemaMap, Query } from "@valv/core"

const schema: SchemaMap = {
  resources: {
    users: {
      name: "users",
      tableName: "users",
      relations: {},
      fields: {
        id: { name: "id", type: "number", nativeType: "Int", isNullable: false, isId: true },
        email: {
          name: "email",
          type: "string",
          nativeType: "String",
          isNullable: false,
          isId: false,
        },
      },
    },
  },
}

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

// compile() never touches the client, so a stub is fine for these unit tests.
const stub = {} as PrismaClient

describe("prisma adapter compile (shared emitter, per-provider dialect)", () => {
  it("emits Postgres dialect SQL", () => {
    const adapter = new PrismaAdapter(stub, { provider: "postgresql" })
    const compiled = adapter.compile(query, schema)
    expect(compiled.sql).toBe('SELECT "email" FROM "users" WHERE ("id" = $1) LIMIT 10')
    expect(compiled.params.map((p) => p.value)).toEqual([1])
  })

  it("emits MySQL dialect SQL", () => {
    const adapter = new PrismaAdapter(stub, { provider: "mysql" })
    const compiled = adapter.compile(query, schema)
    expect(compiled.sql).toBe("SELECT `email` FROM `users` WHERE (`id` = ?) LIMIT 10")
  })

  // Time-series bucketing: without dateTrunc, grouping by a raw timestamp yields
  // one row per distinct value. dateTrunc(col, unit) + groupBy alias buckets it.
  const monthly: Query = {
    from: "users",
    select: [
      {
        fn: "dateTrunc",
        args: [
          { kind: "col", name: "id" },
          { kind: "value", value: "month" },
        ],
        as: "bucket",
      },
      { fn: "count", args: [], as: "completions" },
    ],
    groupBy: ["bucket"],
  }

  it("buckets by month on Postgres (date_trunc)", () => {
    const adapter = new PrismaAdapter(stub, { provider: "postgresql" })
    const { sql } = adapter.compile(monthly, schema)
    expect(sql).toBe(
      `SELECT date_trunc('month', "id") AS "bucket", count(*) AS "completions" FROM "users" GROUP BY "bucket"`,
    )
  })

  it("buckets by month on MySQL (DATE_FORMAT)", () => {
    const adapter = new PrismaAdapter(stub, { provider: "mysql" })
    const { sql } = adapter.compile(monthly, schema)
    expect(sql).toBe(
      "SELECT DATE_FORMAT(`id`, '%Y-%m-01') AS `bucket`, count(*) AS `completions` FROM `users` GROUP BY `bucket`",
    )
  })

  it("buckets by month on SQLite (strftime)", () => {
    const adapter = new PrismaAdapter(stub, { provider: "sqlite" })
    const { sql } = adapter.compile(monthly, schema)
    expect(sql).toBe(
      `SELECT strftime('%Y-%m-01', "id") AS "bucket", count(*) AS "completions" FROM "users" GROUP BY "bucket"`,
    )
  })

  it("rejects an unknown trunc unit", () => {
    const adapter = new PrismaAdapter(stub, { provider: "postgresql" })
    const bad: Query = {
      from: "users",
      select: [
        {
          fn: "dateTrunc",
          args: [
            { kind: "col", name: "id" },
            { kind: "value", value: "decade" },
          ],
        },
      ],
    }
    expect(() => adapter.compile(bad, schema)).toThrow(/one of/)
  })

  it("rejects an unsupported provider", () => {
    const adapter = new PrismaAdapter(stub, { provider: "mongodb" })
    expect(() => adapter.compile(query, schema)).toThrow(/unsupported provider/)
  })

  it("rejects a ClickHouse-only function on Postgres (base functions only)", () => {
    const adapter = new PrismaAdapter(stub, { provider: "postgresql" })
    const aggQuery: Query = {
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
    expect(() => adapter.compile(aggQuery, schema)).toThrow(/not available/)
  })
})
