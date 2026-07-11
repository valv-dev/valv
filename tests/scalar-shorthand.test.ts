import { describe, it, expect } from "vitest"
import { createValv } from "@valv/clickhouse"
import type { SchemaMap, DefaultContext } from "@valv/core"
import { fakeClient, field } from "./helpers"

// A literal can be written one way everywhere. Historically a value required the
// verbose `{ kind: "value", value: "month" }`, yet the query tool advertises
// fixed-value arguments as bare tokens (e.g. `toStartOfInterval(column, number,
// ...|hour|...)`) — so a model reading the schema would write `"hour"` and hit a
// parse error. A bare scalar must now normalize to the same tagged value node,
// as a comparison operand and as a function argument (enum or number).

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

async function run(query: object) {
  const client = fakeClient([])
  const valv = await createValv<DefaultContext>(client, { schema, defaultPolicy: "allow-all" })
  await valv.runTool("query", { from: "events", ...query }, ctx)
  return client.calls[0]!.query
}

describe("scalar shorthand", () => {
  it("accepts a bare string as an enum function argument", async () => {
    const shorthand = {
      select: [{ fn: "toStartOfInterval", args: [{ col: "ts" }, 1, "hour"], as: "bucket" }],
    }
    const tagged = {
      select: [
        {
          fn: "toStartOfInterval",
          args: [{ col: "ts" }, { kind: "value", value: 1 }, { kind: "value", value: "hour" }],
          as: "bucket",
        },
      ],
    }
    // Both forms compile to identical SQL.
    expect(await run(shorthand)).toBe(await run(tagged))
    expect(await run(shorthand)).toContain("INTERVAL 1 HOUR")
  })

  it("rejects a bare string that is not an allowed enum value", async () => {
    await expect(
      run({ select: [{ fn: "toStartOfInterval", args: [{ col: "ts" }, 1, "fortnight"] }] }),
    ).rejects.toThrow(/toStartOfInterval/)
  })

  it("accepts a bare number as a numeric function argument", async () => {
    const sql = await run({
      select: [{ fn: "quantileTiming", args: [0.95, { col: "latency" }], as: "p95" }],
    })
    expect(sql).toContain("quantileTiming(0.95)")
  })

  it("accepts a bare scalar as a where comparison operand", async () => {
    const shorthand = {
      select: [{ col: "region" }],
      where: { kind: "cmp", op: "=", left: { col: "region" }, right: "EU" },
    }
    const tagged = {
      select: [{ col: "region" }],
      where: {
        kind: "cmp",
        op: "=",
        left: { col: "region" },
        right: { kind: "value", value: "EU" },
      },
    }
    expect(await run(shorthand)).toBe(await run(tagged))
    expect(await run(shorthand)).toMatch(/`region` =/)
  })

  it("accepts bare scalars nested in a boolean tree", async () => {
    const sql = await run({
      select: [{ col: "region" }],
      where: {
        kind: "or",
        args: [
          { kind: "cmp", op: ">", left: { col: "latency" }, right: 100 },
          { kind: "cmp", op: "=", left: { col: "region" }, right: "EU" },
        ],
      },
    })
    expect(sql).toContain(" OR ")
    expect(sql).toMatch(/`latency` >/)
    expect(sql).toMatch(/`region` =/)
  })
})
