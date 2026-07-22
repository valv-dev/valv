import { describe, it, expect } from "vitest"
import { createValv } from "@valv/clickhouse"
import type { SchemaMap, DefaultContext } from "@valv/core"
import { fakeClient, field } from "./helpers"

// The Prisma-idiomatic input grammar → SQL. These pin the desugaring the model
// relies on: operator objects, in/notIn, the escaped string operators, AND/OR/NOT,
// the select forms, orderBy, and take — each compiled end-to-end so a regression
// in grammar.ts shows up as wrong SQL, not just a wrong tree.

const schema: SchemaMap = {
  resources: {
    events: {
      name: "events",
      tableName: "events",
      relations: {},
      fields: {
        region: field("region", "string", "String"),
        latency: field("latency", "number", "Int64"),
        ts: field("ts", "date", "DateTime"),
      },
    },
  },
}

const ctx: DefaultContext = { user: { id: "u", role: "member" } }

async function compile(query: object) {
  const client = fakeClient([])
  const valv = await createValv<DefaultContext>(client, { schema, defaultPolicy: "allow-all" })
  await valv.runTool("query", { from: "events", ...query }, ctx)
  return client.calls[0]!
}

const sqlOf = async (query: object) => (await compile(query)).query
const paramsOf = async (query: object) => Object.values((await compile(query)).query_params ?? {})

describe("grammar — where", () => {
  it("reads a bare value as equality", async () => {
    const sql = await sqlOf({ select: { region: true }, where: { region: "EU" } })
    expect(sql).toContain("WHERE (`region` = {p0:String})")
  })

  it("ANDs the operators of one field", async () => {
    const sql = await sqlOf({
      select: { latency: true },
      where: { latency: { gte: 100, lt: 200 } },
    })
    expect(sql).toContain("((`latency` >= {p0:Int64}) AND (`latency` < {p1:Int64}))")
  })

  it("ANDs multiple fields", async () => {
    const sql = await sqlOf({
      select: { region: true },
      where: { region: "EU", latency: { gt: 5 } },
    })
    expect(sql).toMatch(/\(`region` = \{p0:String}\) AND \(`latency` > \{p1:Int64}\)/)
  })

  it("desugars `in` to an OR of equalities", async () => {
    const sql = await sqlOf({ select: { region: true }, where: { region: { in: ["EU", "US"] } } })
    expect(sql).toContain("((`region` = {p0:String}) OR (`region` = {p1:String}))")
  })

  it("desugars `notIn` to a negated OR", async () => {
    const sql = await sqlOf({ select: { region: true }, where: { region: { notIn: ["EU"] } } })
    expect(sql).toContain("(NOT (`region` = {p0:String}))")
  })

  it("combines AND / OR / NOT", async () => {
    const sql = await sqlOf({
      select: { region: true },
      where: { OR: [{ region: "EU" }, { NOT: { latency: { gt: 10 } } }] },
    })
    expect(sql).toContain(" OR ")
    expect(sql).toContain("NOT")
  })

  it("maps contains/startsWith/endsWith to LIKE with the right pattern", async () => {
    expect(
      await paramsOf({ select: { region: true }, where: { region: { startsWith: "e" } } }),
    ).toContain("e%")
    expect(
      await paramsOf({ select: { region: true }, where: { region: { endsWith: "u" } } }),
    ).toContain("%u")
    expect(
      await paramsOf({ select: { region: true }, where: { region: { contains: "u" } } }),
    ).toContain("%u%")
  })

  it("escapes LIKE wildcards in a user value (a literal %, not a wildcard)", async () => {
    const params = await paramsOf({
      select: { region: true },
      where: { region: { contains: "50%" } },
    })
    expect(params).toContain("%50\\%%")
  })

  it("uses ILIKE for mode: insensitive", async () => {
    const sql = await sqlOf({
      select: { region: true },
      where: { region: { contains: "eu", mode: "insensitive" } },
    })
    expect(sql).toMatch(/`region` ILIKE \{p0:String}/)
  })

  it("tests IS NULL from a bare null or { equals: null }", async () => {
    expect(await sqlOf({ select: { region: true }, where: { region: null } })).toContain(
      "WHERE (`region` IS NULL)",
    )
    expect(
      await sqlOf({ select: { region: true }, where: { region: { equals: null } } }),
    ).toContain("WHERE (`region` IS NULL)")
  })

  it("tests IS NOT NULL from { not: null }", async () => {
    expect(await sqlOf({ select: { region: true }, where: { region: { not: null } } })).toContain(
      "WHERE (`region` IS NOT NULL)",
    )
  })

  it("binds no parameter for a null check", async () => {
    expect(await paramsOf({ select: { region: true }, where: { region: null } })).toEqual([])
  })

  it("rejects null for a range operator", async () => {
    await expect(
      sqlOf({ select: { region: true }, where: { latency: { gt: null } } }),
    ).rejects.toThrow(/needs a non-null value/)
  })

  it("treats an empty filter as no constraint", async () => {
    const sql = await sqlOf({ select: { region: true }, where: {} })
    expect(sql).not.toContain("WHERE")
  })

  it("rejects an unknown operator with a helpful message", async () => {
    await expect(
      sqlOf({ select: { region: true }, where: { latency: { between: 5 } } }),
    ).rejects.toThrow(/Unknown operator "between".*gte/)
  })
})

describe("grammar — select", () => {
  it("selects a plain column with `true` (no redundant alias)", async () => {
    expect(await sqlOf({ select: { region: true } })).toContain("SELECT `region` FROM")
  })

  it("renames a column via { col }", async () => {
    expect(await sqlOf({ select: { area: { col: "region" } } })).toContain("`region` AS `area`")
  })

  it("aggregates with a function keyed by output name", async () => {
    expect(await sqlOf({ select: { p95: { quantileTiming: [0.95, "latency"] } } })).toContain(
      "quantileTiming(0.95)(`latency`) AS `p95`",
    )
  })

  it("rejects a select entry with more than one key", async () => {
    await expect(sqlOf({ select: { x: { sum: "latency", avg: "latency" } } })).rejects.toThrow(
      /exactly one column or function/,
    )
  })
})

describe("grammar — orderBy / take", () => {
  it("orders by a { column: dir } object", async () => {
    expect(await sqlOf({ select: { region: true }, orderBy: { region: "desc" } })).toContain(
      "ORDER BY `region` DESC",
    )
  })

  it("orders by an array of keys, in order", async () => {
    const sql = await sqlOf({
      select: { region: true, latency: true },
      orderBy: [{ region: "asc" }, { latency: "desc" }],
    })
    expect(sql).toContain("ORDER BY `region` ASC, `latency` DESC")
  })

  it("accepts `take` and the `limit` alias", async () => {
    expect(await sqlOf({ select: { region: true }, take: 5 })).toContain("LIMIT 5")
    expect(await sqlOf({ select: { region: true }, limit: 7 })).toContain("LIMIT 7")
  })

  it("rejects an unknown top-level key", async () => {
    await expect(sqlOf({ select: { region: true }, include: {} })).rejects.toThrow(
      /Unknown query key "include"/,
    )
  })
})
