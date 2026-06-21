import { describe, it, expect } from "vitest"
import { createValv, type ClickHouseClient } from "@valv/clickhouse"
import type { SchemaMap, DefaultContext } from "@valv/core"

const schema: SchemaMap = {
  resources: {
    events: {
      name: "events",
      tableName: "events",
      relations: {},
      fields: {
        tenant_id: { name: "tenant_id", type: "string", nativeType: "String", isNullable: false, isId: false },
        plan: { name: "plan", type: "string", nativeType: "String", isNullable: false, isId: false },
      },
    },
  },
}

const ctx = (tenant?: string): DefaultContext => ({
  user: { id: "u", role: "member" },
  ...(tenant ? { tenant: { id: tenant } } : {}),
})

async function setup(onError?: (e?: Error) => void) {
  const calls: { query: string; query_params?: Record<string, unknown> }[] = []
  const client: ClickHouseClient = {
    async query(p) {
      calls.push({ query: p.query, query_params: p.query_params })
      return { json: async () => [] }
    },
  }
  const valv = await createValv<DefaultContext>(client, {
    schema,
    onQuery: onError ? (e) => onError(e.error) : undefined,
  })
  // Policy filter value comes from optional context — undefined when no tenant.
  valv.policy("events", (c) => ({ read: { tenant_id: c.tenant?.id } }))
  return { valv, calls }
}

describe("security hardening", () => {
  it("fails closed when a policy filter value is undefined (no leak)", async () => {
    const { valv, calls } = await setup()
    await expect(
      valv.executeTool("query", { from: "events", select: [{ col: "plan" }] }, ctx(undefined)),
    ).rejects.toThrow(/refusing to run an unscoped query/)
    expect(calls).toHaveLength(0) // never reached the database
  })

  it("rejects a pathologically deep query without crashing", async () => {
    let node: unknown = { kind: "col", name: "plan" }
    for (let i = 0; i < 3000; i++) node = { kind: "not", arg: node }
    const { valv } = await setup()
    await expect(
      valv.executeTool("query", { from: "events", select: [{ col: "plan" }], where: node }, ctx("acme")),
    ).rejects.toThrow(/too deeply nested|too large/)
  })

  it("rejects a pathologically wide query", async () => {
    const args = Array.from({ length: 20000 }, () => ({ kind: "col", name: "plan" }))
    const { valv } = await setup()
    await expect(
      valv.executeTool("query", { from: "events", select: [{ col: "plan" }], where: { kind: "and", args } }, ctx("acme")),
    ).rejects.toThrow(/too large|too deeply nested/)
  })

  it("rejects a non-scalar parameter value", async () => {
    const { valv } = await setup()
    await expect(
      valv.executeTool(
        "query",
        { from: "events", select: [{ col: "plan" }], where: { kind: "cmp", op: "=", left: { kind: "col", name: "plan" }, right: { kind: "value", value: {} } } },
        ctx("acme"),
      ),
    ).rejects.toThrow()
  })

  it("does not leak internal errors, but keeps the original for logging", async () => {
    let logged: Error | undefined
    const client: ClickHouseClient = {
      async query() {
        throw new Error("CH internal: node-7 down, SQL=SELECT secret FROM users")
      },
    }
    const valv = await createValv<DefaultContext>(client, { schema, onQuery: (e) => (logged = e.error) })
    valv.policy("events", (c) => ({ read: { tenant_id: c.tenant?.id } }))

    await expect(
      valv.executeTool("query", { from: "events", select: [{ col: "plan" }] }, ctx("acme")),
    ).rejects.toThrow(/could not be processed/)
    expect(logged?.message).toMatch(/CH internal/) // raw error preserved server-side
  })

  it("handles dangerous prototype keys cleanly", async () => {
    const { valv } = await setup()
    await expect(
      valv.executeTool("query", { from: "constructor", select: [{ col: "plan" }] }, ctx("acme")),
    ).rejects.toThrow(/Unknown resource/)
    await expect(
      valv.executeTool("query", { from: "events", select: [{ col: "toString" }] }, ctx("acme")),
    ).rejects.toThrow(/not accessible/)
  })

  it("rejects a deeply nested result value instead of overflowing", async () => {
    let deep: unknown = "leaf"
    for (let i = 0; i < 200; i++) deep = { n: deep }
    const client: ClickHouseClient = {
      async query() {
        return { json: async () => [{ data: deep }] }
      },
    }
    const valv = await createValv<DefaultContext>(client, { schema })
    valv.policy("events", (c) => ({ read: { tenant_id: c.tenant?.id } }))
    await expect(
      valv.executeTool("query", { from: "events", select: [{ col: "plan" }] }, ctx("acme")),
    ).rejects.toThrow()
  })

  it("rejects a column with an unsafe native type", async () => {
    const badSchema: SchemaMap = {
      resources: {
        events: {
          name: "events",
          tableName: "events",
          relations: {},
          fields: {
            tenant_id: { name: "tenant_id", type: "string", nativeType: "String", isNullable: false, isId: false },
            plan: { name: "plan", type: "string", nativeType: "String} = 1 OR 1=1 --", isNullable: false, isId: false },
          },
        },
      },
    }
    const client: ClickHouseClient = { async query() { return { json: async () => [] } } }
    const valv = await createValv<DefaultContext>(client, { schema: badSchema })
    valv.policy("events", (c) => ({ read: { tenant_id: c.tenant?.id } }))
    await expect(
      valv.executeTool(
        "query",
        { from: "events", select: [{ col: "plan" }], where: { kind: "cmp", op: "=", left: { kind: "col", name: "plan" }, right: { kind: "value", value: "x" } } },
        ctx("acme"),
      ),
    ).rejects.toThrow()
  })

  it("rejects a malformed alias and empty boolean groups", async () => {
    const { valv } = await setup()
    await expect(
      valv.executeTool("query", { from: "events", select: [{ col: "plan", as: "x); DROP" }] }, ctx("acme")),
    ).rejects.toThrow()
    await expect(
      valv.executeTool("query", { from: "events", select: [{ col: "plan" }], where: { kind: "and", args: [] } }, ctx("acme")),
    ).rejects.toThrow()
  })

  it("keeps the tenant filter AND-ed even under a top-level OR", async () => {
    const { valv, calls } = await setup()
    await valv.executeTool(
      "query",
      {
        from: "events",
        select: [{ col: "plan" }],
        where: {
          kind: "or",
          args: [
            { kind: "cmp", op: "=", left: { kind: "col", name: "plan" }, right: { kind: "value", value: "free" } },
            { kind: "cmp", op: "=", left: { kind: "col", name: "plan" }, right: { kind: "value", value: "pro" } },
          ],
        },
      },
      ctx("acme"),
    )
    // The OR-tree is fully parenthesised and AND-ed with the tenant filter — no escape.
    expect(calls[0].query).toContain(" OR ")
    expect(calls[0].query).toContain(") AND (`tenant_id` = {p")
  })
})
