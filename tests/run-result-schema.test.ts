import { describe, it, expect } from "vitest"
import { createValv } from "@valv/clickhouse"
import type { SchemaMap, DefaultContext, FieldSchema, Query } from "@valv/core"
import { fakeClient } from "./helpers"

const f = (name: string, type: FieldSchema["type"], nativeType: string): FieldSchema => ({
  name,
  type,
  nativeType,
  isNullable: false,
  isId: false,
})

const schema: SchemaMap = {
  resources: {
    events: {
      name: "events",
      tableName: "events_t",
      relations: {},
      fields: {
        tenant_id: f("tenant_id", "string", "String"),
        plan: f("plan", "string", "String"),
        latency: f("latency", "number", "UInt32"),
        ts: f("ts", "date", "DateTime"),
      },
    },
  },
}

const col = (name: string) => ({ kind: "col" as const, name })
const val = (value: string | number) => ({ kind: "value" as const, value })

async function setup() {
  const client = fakeClient([{ plan: "pro" }])
  const valv = await createValv<DefaultContext>(client, { schema })
  valv.policy("events", (c) => ({ read: { tenant_id: c.tenant!.id } }))
  return { valv, calls: client.calls }
}

const ctxFor = (tenant: string): DefaultContext => ({
  user: { id: "u1", role: "member" },
  tenant: { id: tenant },
})

describe("run() — the read primitive", () => {
  it("runs a query through the full pipeline, returning serialized rows", async () => {
    const { valv, calls } = await setup()
    const query: Query = { from: "events", select: [{ col: "plan" }] }
    const rows = await valv.run(query, ctxFor("acme"))

    expect(rows).toEqual([{ plan: "pro" }])
    expect(calls[0].query).toBe(
      "SELECT `plan` FROM `events_t` WHERE (`tenant_id` = {p0:String}) LIMIT 100",
    )
  })

  it("re-scopes a stored query to the current context on every replay (saved-query path)", async () => {
    const { valv, calls } = await setup()
    // The same stored query object, replayed under two different tenants.
    const query: Query = { from: "events", select: [{ col: "plan" }] }
    await valv.run(query, ctxFor("acme"))
    await valv.run(query, ctxFor("globex"))

    expect(calls[0].query_params).toEqual({ p0: "acme" })
    expect(calls[1].query_params).toEqual({ p0: "globex" })
  })
})

describe("resultSchema() — predicted output shape", () => {
  it("derives columns + coarse types without executing", async () => {
    const { valv, calls } = await setup()
    const cols = valv.resultSchema({
      from: "events",
      select: [
        { col: "plan" },
        { fn: "count", args: [], as: "hits" },
        { fn: "toStartOfInterval", args: [col("ts"), val(1), val("hour")], as: "bucket" },
        { fn: "max", args: [col("latency")], as: "peak" }, // passthrough → number
        { fn: "max", args: [col("plan")], as: "top" }, // passthrough → string
      ],
    })

    expect(cols).toEqual([
      { name: "plan", type: "string" },
      { name: "hits", type: "number" },
      { name: "bucket", type: "date" },
      { name: "peak", type: "number" },
      { name: "top", type: "string" },
    ])
    expect(calls).toHaveLength(0) // never touched the database
  })

  it("falls back to the function name when an aggregate isn't aliased", async () => {
    const { valv } = await setup()
    expect(valv.resultSchema({ from: "events", select: [{ fn: "count", args: [] }] })).toEqual([
      { name: "count", type: "number" },
    ])
  })

  it("throws on an unknown resource", async () => {
    const { valv } = await setup()
    expect(() => valv.resultSchema({ from: "nope", select: [{ col: "plan" }] })).toThrow(
      /Unknown resource/,
    )
  })
})
