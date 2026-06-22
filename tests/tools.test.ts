import { describe, it, expect } from "vitest"
import { createValv } from "@valv/clickhouse"
import type { SchemaMap, DefaultContext, FieldSchema, RelationSchema } from "@valv/core"
import { fakeClient } from "./helpers"

const f = (name: string, type: FieldSchema["type"], extra: Partial<FieldSchema> = {}): FieldSchema => ({
  name,
  type,
  nativeType: type === "number" ? "UInt32" : "String",
  isNullable: false,
  isId: false,
  ...extra,
})

const rel = (name: string, target: string): RelationSchema => ({
  name,
  targetResource: target,
  type: "belongsTo",
  foreignKey: `${target}_id`,
})

const schema: SchemaMap = {
  resources: {
    orders: {
      name: "orders",
      tableName: "orders_t",
      description: "Customer orders",
      relations: { customer: rel("customer", "users"), log: rel("log", "audit") },
      fields: {
        tenant_id: f("tenant_id", "string"),
        total: f("total", "number"),
        status: f("status", "string"),
        internal_notes: f("internal_notes", "string", { sensitive: true }),
      },
    },
    users: {
      name: "users",
      tableName: "users_t",
      description: "People who place orders",
      relations: {},
      fields: { id: f("id", "string", { isId: true }), email: f("email", "string") },
    },
    audit: {
      name: "audit",
      tableName: "audit_t",
      relations: {},
      fields: { id: f("id", "string"), action: f("action", "string") },
    },
  },
}

const ctx: DefaultContext = { user: { id: "u1", role: "member" }, tenant: { id: "acme" } }

async function setup() {
  const client = fakeClient([{ status: "paid" }])
  // deny-all: orders + users get policies; audit has none → invisible.
  const valv = await createValv<DefaultContext>(client, { schema, defaultPolicy: "deny-all" })
  valv.policy("orders", (c) => ({ read: { tenant_id: c.tenant!.id } }))
  valv.policy("users", () => ({ read: true }))
  return { valv, calls: client.calls }
}

describe("tool layer", () => {
  it("exposes query + the three discovery tools, with a per-tool toggle", async () => {
    const { valv } = await setup()
    expect(valv.tools.neutral(ctx).map((t) => t.name)).toEqual([
      "list_resources",
      "search_resources",
      "describe_resource",
      "query",
    ])
    expect(valv.tools.neutral(ctx, { list: false, search: false }).map((t) => t.name)).toEqual([
      "describe_resource",
      "query",
    ])
    // query always survives, even with every discovery tool off.
    expect(
      valv.tools.neutral(ctx, { list: false, search: false, describe: false }).map((t) => t.name),
    ).toEqual(["query"])
  })

  it("enumerates the available functions in the query tool's `fn` field", async () => {
    const { valv } = await setup()
    const query = valv.tools.neutral(ctx).find((t) => t.name === "query")!
    const params = query.parameters as any
    const fnVariant = params.properties.select.items.anyOf.find((v: any) => v.properties?.fn)
    expect(fnVariant.properties.fn.enum).toContain("count")
    expect(fnVariant.properties.fn.enum).toContain("quantileTiming")
  })

  it("formats per provider (anthropic shape)", async () => {
    const { valv } = await setup()
    const [first] = valv.tools.anthropic(ctx)
    expect(first).toHaveProperty("name")
    expect(first).toHaveProperty("input_schema")
    expect(first).not.toHaveProperty("execute") // execute is local, never sent to the API
  })

  it("policy-filters discovery: an unreadable resource is invisible", async () => {
    const { valv } = await setup()
    const list = valv.tools.neutral(ctx).find((t) => t.name === "list_resources")!
    const names = ((await list.execute({})) as { name: string }[]).map((r) => r.name)
    expect(names.sort()).toEqual(["orders", "users"]) // audit hidden (no policy under deny-all)
  })

  it("describe strips sensitive fields and relations to hidden resources", async () => {
    const { valv } = await setup()
    const detail = (await valv.runTool("describe_resource", { resource: "orders" }, ctx)) as any
    expect(detail.fields.map((f: any) => f.name).sort()).toEqual(["status", "tenant_id", "total"])
    // internal_notes (sensitive) is gone; relation to users (visible) stays, to audit (hidden) is dropped.
    expect(detail.relations.map((r: any) => r.target)).toEqual(["users"])
  })

  it("describe of an inaccessible resource is rejected", async () => {
    const { valv } = await setup()
    await expect(valv.runTool("describe_resource", { resource: "audit" }, ctx)).rejects.toThrow(
      /not accessible/,
    )
  })

  it("search ranks resources by keyword", async () => {
    const { valv } = await setup()
    const hits = (await valv.runTool("search_resources", { query: "order" }, ctx)) as { name: string }[]
    expect(hits[0].name).toBe("orders")
  })

  it("runTool('query', …) runs the query pipeline", async () => {
    const { valv, calls } = await setup()
    const rows = await valv.runTool("query", { from: "orders", select: [{ col: "status" }] }, ctx)
    expect(rows).toEqual([{ status: "paid" }])
    expect(calls[0].query).toContain("WHERE (`tenant_id` = {p0:String})")
  })

  it("rejects an unknown tool name", async () => {
    const { valv } = await setup()
    await expect(valv.runTool("drop_table", {}, ctx)).rejects.toThrow(/Unknown tool/)
  })

  it("formats as a Vercel AI SDK tool set whose tools self-execute", async () => {
    const { valv, calls } = await setup()
    const tools = await valv.tools.aisdk(ctx, { list: false, search: false })
    expect(Object.keys(tools).sort()).toEqual(["describe_resource", "query"])

    const query = tools.query as unknown as { execute: (input: unknown) => Promise<unknown> }
    const rows = await query.execute({ from: "orders", select: [{ col: "status" }] })
    expect(rows).toEqual([{ status: "paid" }])
    expect(calls[0].query).toContain("WHERE (`tenant_id` = {p0:String})")
  })
})
