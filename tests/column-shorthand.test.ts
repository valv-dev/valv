import { describe, it, expect } from "vitest"
import { createValv } from "@valv/clickhouse"
import type { SchemaMap, DefaultContext } from "@valv/core"
import { fakeClient, field } from "./helpers"

// A column can be written one way everywhere. Historically `{ col: "x" }` worked
// in `select` and function args, but a `where` comparison operand required the
// verbose `{ kind: "col", name: "x" }` — a mid-query switch smaller models trip
// on. Both forms must now parse to the same tagged node.

const schema: SchemaMap = {
  resources: {
    orders: {
      name: "orders",
      tableName: "orders",
      relations: {},
      fields: {
        region: field("region", "string", "String"),
        total: field("total", "number", "Int64"),
      },
    },
  },
}

const ctx: DefaultContext = { user: { id: "u", role: "member" } }

async function run(where: unknown) {
  const client = fakeClient([])
  const valv = await createValv<DefaultContext>(client, { schema, defaultPolicy: "allow-all" })
  await valv.runTool("query", { from: "orders", select: [{ col: "region" }], where }, ctx)
  return client.calls[0]!.query
}

describe("column shorthand in a where", () => {
  it("accepts { col } as a cmp operand", async () => {
    const shorthand = {
      kind: "cmp",
      op: "=",
      left: { col: "region" },
      right: { kind: "value", value: "EU" },
    }
    const tagged = {
      kind: "cmp",
      op: "=",
      left: { kind: "col", name: "region" },
      right: { kind: "value", value: "EU" },
    }
    // Both forms compile to identical SQL.
    expect(await run(shorthand)).toBe(await run(tagged))
    expect(await run(shorthand)).toMatch(/`region` =/)
  })

  it("accepts { col } nested inside a boolean tree", async () => {
    const where = {
      kind: "or",
      args: [
        { kind: "cmp", op: ">", left: { col: "total" }, right: { kind: "value", value: 100 } },
        { kind: "cmp", op: "=", left: { col: "region" }, right: { kind: "value", value: "EU" } },
      ],
    }
    const sql = await run(where)
    expect(sql).toContain(" OR ")
    expect(sql).toMatch(/`total` >/)
    expect(sql).toMatch(/`region` =/)
  })
})
