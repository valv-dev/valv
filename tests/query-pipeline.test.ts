import { describe, it, expect } from "vitest"
import { createValv, type ClickHouseClient } from "@valv/clickhouse"
import type { SchemaMap, DefaultContext, FieldSchema } from "@valv/core"

const f = (name: string, nativeType: string, extra: Partial<FieldSchema> = {}): FieldSchema => ({
  name,
  type: "string",
  nativeType,
  isNullable: false,
  isId: false,
  ...extra,
})

const schema: SchemaMap = {
  resources: {
    events: {
      name: "events",
      tableName: "events_t",
      relations: {},
      fields: {
        tenant_id: f("tenant_id", "String"),
        plan: f("plan", "String"),
        latency: f("latency", "UInt32", { type: "number" }),
        secret: f("secret", "String", { sensitive: true, isNullable: true }),
      },
    },
  },
}

const ctx: DefaultContext = { user: { id: "u1", role: "member" }, tenant: { id: "acme" } }

function setup() {
  const calls: {
    query: string
    query_params?: Record<string, unknown>
    clickhouse_settings?: Record<string, unknown>
  }[] = []
  const client: ClickHouseClient = {
    async query(params) {
      calls.push({
        query: params.query,
        query_params: params.query_params,
        clickhouse_settings: params.clickhouse_settings,
      })
      return { json: async () => [{ plan: "pro", latency: 42 }] }
    },
  }
  const valv = createValv<DefaultContext>(client, { schema })
  valv.policy("events", (c) => ({ read: { tenant_id: c.tenant!.id } }))
  return { valv, calls }
}

describe("query pipeline (slice 1)", () => {
  it("validates, injects the tenant filter, emits typed CH SQL, runs it, serializes", async () => {
    const { valv, calls } = setup()
    const rows = await valv.executeTool(
      "query",
      {
        from: "events",
        select: [{ col: "plan" }, { col: "latency" }],
        where: { kind: "cmp", op: ">", left: { kind: "col", name: "latency" }, right: { kind: "value", value: 10 } },
        limit: 50,
      },
      ctx,
    )

    expect(calls).toHaveLength(1)
    expect(calls[0].query).toBe(
      "SELECT `plan`, `latency` FROM `events_t` " +
        "WHERE ((`latency` > {p0:UInt32}) AND (`tenant_id` = {p1:String})) LIMIT 50",
    )
    expect(calls[0].query_params).toEqual({ p0: 10, p1: "acme" })
    expect(rows).toEqual([{ plan: "pro", latency: 42 }])
  })

  it("applies ClickHouse cost caps on every query", async () => {
    const { valv, calls } = setup()
    await valv.executeTool("query", { from: "events", select: [{ col: "plan" }] }, ctx)
    expect(calls[0].clickhouse_settings).toMatchObject({
      max_execution_time: 30,
      result_overflow_mode: "throw",
    })
  })

  it("rejects a sensitive field", async () => {
    const { valv } = setup()
    await expect(
      valv.executeTool("query", { from: "events", select: [{ col: "secret" }] }, ctx),
    ).rejects.toThrow(/not accessible/)
  })

  it("rejects an unknown column (same message as a denied one)", async () => {
    const { valv } = setup()
    await expect(
      valv.executeTool("query", { from: "events", select: [{ col: "nope" }] }, ctx),
    ).rejects.toThrow(/not accessible/)
  })

  it("defaults the limit and always injects the tenant filter", async () => {
    const { valv, calls } = setup()
    await valv.executeTool("query", { from: "events", select: [{ col: "plan" }] }, ctx)
    expect(calls[0].query).toBe(
      "SELECT `plan` FROM `events_t` WHERE (`tenant_id` = {p0:String}) LIMIT 100",
    )
  })
})
