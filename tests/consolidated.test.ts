import { describe, it, expect } from "vitest"
import { Vistal } from "@vistal/core"
import type { VistalAdapter, SchemaMap, ResolvedQuery, DefaultContext } from "@vistal/core"

const ctx: DefaultContext = { user: { id: "u1", role: "admin" } }

const schema: SchemaMap = {
  resources: {
    order: {
      name: "order",
      tableName: "Order",
      fields: {
        id: { name: "id", type: "uuid", isNullable: false, isId: true, hasDefaultValue: true },
        amount: { name: "amount", type: "number", isNullable: false, isId: false },
        status: { name: "status", type: "string", isNullable: false, isId: false },
        tenant_id: { name: "tenant_id", type: "string", isNullable: false, isId: false },
        secret: { name: "secret", type: "string", isNullable: true, isId: false, sensitive: true },
      },
      relations: {
        customer: {
          name: "customer",
          targetResource: "customer",
          type: "belongsTo",
          foreignKey: "customer_id",
        },
      },
    },
    customer: {
      name: "customer",
      tableName: "Customer",
      fields: {
        id: { name: "id", type: "uuid", isNullable: false, isId: true, hasDefaultValue: true },
        name: { name: "name", type: "string", isNullable: false, isId: false },
      },
      relations: {},
    },
    audit_log: {
      name: "audit_log",
      tableName: "AuditLog",
      fields: {
        id: { name: "id", type: "uuid", isNullable: false, isId: true, hasDefaultValue: true },
        message: { name: "message", type: "string", isNullable: false, isId: false },
      },
      relations: {},
    },
  },
}

class MockAdapter implements VistalAdapter {
  lastQuery?: ResolvedQuery
  async introspect(): Promise<SchemaMap> {
    return schema
  }
  async execute(query: ResolvedQuery): Promise<unknown> {
    this.lastQuery = query
    return []
  }
}

function makeVistal(adapter: MockAdapter) {
  return new Vistal({ adapter })
    .policy("order", () => ({
      read: { tenant_id: "t1" },
      write: { tenant_id: "t1" },
      delete: false,
      relations: { customer: true },
    }))
    .policy("customer", () => ({ read: true, write: false, delete: false }))
  // audit_log: no policy → deny-all (defaultPolicy = "deny-all")
}

describe("consolidated mode — tool generation", () => {
  it("yields ≤8 tools regardless of resource count", async () => {
    const bigSchema: SchemaMap = {
      resources: Object.fromEntries(
        Array.from({ length: 200 }, (_, i) => {
          const name = `resource_${i}`
          return [
            name,
            {
              name,
              tableName: name,
              fields: {
                id: {
                  name: "id",
                  type: "uuid" as const,
                  isNullable: false,
                  isId: true,
                  hasDefaultValue: true,
                },
              },
              relations: {},
            },
          ]
        }),
      ),
    }
    class BigAdapter implements VistalAdapter {
      async introspect() {
        return bigSchema
      }
      async execute() {
        return []
      }
    }
    const v = new Vistal({ adapter: new BigAdapter(), defaultPolicy: "allow-all" })
    const tools = await v.tools.openai(ctx, { mode: "consolidated" })
    expect(tools.length).toBeLessThanOrEqual(8)
  })

  it("emits list_resources and describe_resource when any resource is accessible", async () => {
    const v = makeVistal(new MockAdapter())
    const tools = await v.tools.openai(ctx, { mode: "consolidated" })
    const names = tools.map((t) => t.name)
    expect(names).toContain("list_resources")
    expect(names).toContain("describe_resource")
  })

  it("emits query and get for readable resources", async () => {
    const v = makeVistal(new MockAdapter())
    const names = (await v.tools.openai(ctx, { mode: "consolidated" })).map((t) => t.name)
    expect(names).toContain("query")
    expect(names).toContain("get")
  })

  it("does NOT emit create/delete for order (delete: false) but does emit update", async () => {
    const v = makeVistal(new MockAdapter())
    const names = (await v.tools.openai(ctx, { mode: "consolidated" })).map((t) => t.name)
    expect(names).toContain("update")
    expect(names).not.toContain("delete")
  })

  it("resource enum on query includes order and customer but not denied audit_log", async () => {
    const v = makeVistal(new MockAdapter())
    const tools = await v.tools.openai(ctx, { mode: "consolidated" })
    const queryTool = tools.find((t) => t.name === "query")!
    const resourceEnum = (queryTool.definition.function.parameters as any).properties.resource
      .enum as string[]
    expect(resourceEnum).toContain("order")
    expect(resourceEnum).toContain("customer")
    expect(resourceEnum).not.toContain("audit_log")
  })

  it("create tool resource enum does NOT include customer (write: false)", async () => {
    const v = makeVistal(new MockAdapter())
    const tools = await v.tools.openai(ctx, { mode: "consolidated" })
    const createTool = tools.find((t) => t.name === "create")
    // customer has write: false, order has write allowed
    expect(createTool).toBeDefined()
    const resourceEnum = (createTool!.definition.function.parameters as any).properties.resource
      .enum as string[]
    expect(resourceEnum).toContain("order")
    expect(resourceEnum).not.toContain("customer")
  })

  it("emits aggregate only for resources with numeric fields", async () => {
    const v = makeVistal(new MockAdapter())
    const tools = await v.tools.openai(ctx, { mode: "consolidated" })
    const aggTool = tools.find((t) => t.name === "aggregate")!
    // order has 'amount' (number); customer has no numeric fields
    const resourceEnum = (aggTool.definition.function.parameters as any).properties.resource
      .enum as string[]
    expect(resourceEnum).toContain("order")
    expect(resourceEnum).not.toContain("customer")
  })

  it("emits no tools when no resource is accessible", async () => {
    const v = new Vistal({ adapter: new MockAdapter(), defaultPolicy: "deny-all" })
    const tools = await v.tools.openai(ctx, { mode: "consolidated" })
    expect(tools).toHaveLength(0)
  })
})

describe("consolidated mode — list_resources execution", () => {
  it("returns only accessible resources with their allowed operations", async () => {
    const v = makeVistal(new MockAdapter())
    const result = (await v.executeTool("list_resources", {}, ctx)) as {
      name: string
      operations: string[]
    }[]
    const names = result.map((r) => r.name)
    expect(names).toContain("order")
    expect(names).toContain("customer")
    expect(names).not.toContain("audit_log")
    const orderEntry = result.find((r) => r.name === "order")!
    expect(orderEntry.operations).toContain("query")
    expect(orderEntry.operations).toContain("update")
    expect(orderEntry.operations).not.toContain("delete")
  })

  it("reports granular operations: create≠update and aggregate≠read", async () => {
    const v = new Vistal({ adapter: new MockAdapter() })
      // amend-only + analytics-only: update yes, create no; aggregate yes, row reads no.
      .policy("order", () => ({
        read: false,
        aggregate: { tenant_id: "t1" },
        create: false,
        update: { tenant_id: "t1" },
        delete: false,
      }))
    const result = (await v.executeTool("list_resources", {}, ctx)) as {
      name: string
      operations: string[]
    }[]
    const order = result.find((r) => r.name === "order")
    expect(order).toBeDefined()
    expect(order!.operations).toContain("update")
    expect(order!.operations).toContain("aggregate")
    expect(order!.operations).not.toContain("create")
    expect(order!.operations).not.toContain("query")
    expect(order!.operations).not.toContain("get")
  })
})

describe("consolidated mode — describe_resource execution", () => {
  it("omits sensitive fields from field list", async () => {
    const v = makeVistal(new MockAdapter())
    const result = (await v.executeTool("describe_resource", { resource: "order" }, ctx)) as {
      fields: { name: string }[]
    }
    const fieldNames = result.fields.map((f) => f.name)
    expect(fieldNames).not.toContain("secret")
    expect(fieldNames).toContain("amount")
    expect(fieldNames).toContain("status")
  })

  it("includes allowed relations in schema", async () => {
    const v = makeVistal(new MockAdapter())
    const result = (await v.executeTool("describe_resource", { resource: "order" }, ctx)) as {
      relations: { name: string }[]
    }
    expect(result.relations.map((r) => r.name)).toContain("customer")
  })

  it("marks a readOnly field as readable but not writable", async () => {
    const v = new Vistal({ adapter: new MockAdapter() }).policy("order", () => ({
      read: { tenant_id: "t1" },
      write: { tenant_id: "t1" },
      delete: false,
      fields: { readOnly: ["status"] },
    }))
    const result = (await v.executeTool("describe_resource", { resource: "order" }, ctx)) as {
      fields: { name: string; readable: boolean; writable: boolean }[]
    }
    const status = result.fields.find((f) => f.name === "status")!
    expect(status.readable).toBe(true)
    expect(status.writable).toBe(false)
    const amount = result.fields.find((f) => f.name === "amount")!
    expect(amount.writable).toBe(true)
  })

  it("throws for an unknown resource", async () => {
    const v = makeVistal(new MockAdapter())
    await expect(
      v.executeTool("describe_resource", { resource: "nonexistent" }, ctx),
    ).rejects.toThrow()
  })

  it("throws when resource argument is missing", async () => {
    const v = makeVistal(new MockAdapter())
    await expect(v.executeTool("describe_resource", {}, ctx)).rejects.toThrow()
  })
})

describe("consolidated mode — verb tool execution", () => {
  it("query dispatches to query_<resource> with policy row filter applied", async () => {
    const adapter = new MockAdapter()
    const v = makeVistal(adapter)
    await v.executeTool("query", { resource: "order", filters: { status: "shipped" } }, ctx)
    expect(adapter.lastQuery?.resource).toBe("order")
    expect(adapter.lastQuery?.operation).toBe("find")
    // policy row filter tenant_id should be AND-ed in
    expect(JSON.stringify(adapter.lastQuery?.filters)).toContain("tenant_id")
  })

  it("get dispatches to get_<resource>", async () => {
    const adapter = new MockAdapter()
    const v = makeVistal(adapter)
    await v.executeTool("get", { resource: "customer", id: "c1" }, ctx)
    expect(adapter.lastQuery?.resource).toBe("customer")
    expect(adapter.lastQuery?.operation).toBe("findOne")
  })

  it("create lifts data fields and enforces forced write fields", async () => {
    const adapter = new MockAdapter()
    const v = makeVistal(adapter)
    await v.executeTool("create", { resource: "order", data: { amount: 99, status: "new" } }, ctx)
    expect(adapter.lastQuery?.operation).toBe("create")
    // forced write field tenant_id should be injected
    expect(adapter.lastQuery?.data).toMatchObject({ tenant_id: "t1" })
  })

  it("update lifts data fields correctly", async () => {
    const adapter = new MockAdapter()
    const v = makeVistal(adapter)
    await v.executeTool("update", { resource: "order", id: "o1", data: { status: "shipped" } }, ctx)
    expect(adapter.lastQuery?.operation).toBe("update")
    expect(adapter.lastQuery?.data).toMatchObject({ status: "shipped" })
  })

  it("throws when resource argument is missing from a verb call", async () => {
    const v = makeVistal(new MockAdapter())
    await expect(v.executeTool("query", {}, ctx)).rejects.toThrow()
  })
})

describe("consolidated mode — security hardening", () => {
  it("rejects aggregation over a denied/sensitive field", async () => {
    const v = makeVistal(new MockAdapter())
    await expect(
      v.executeTool(
        "aggregate",
        {
          resource: "order",
          aggregations: [{ fn: "sum", field: "secret", alias: "total_secret" }],
        },
        ctx,
      ),
    ).rejects.toThrow()
  })

  it("allows aggregation over an allowed numeric field", async () => {
    const adapter = new MockAdapter()
    const v = makeVistal(adapter)
    await v.executeTool(
      "aggregate",
      {
        resource: "order",
        aggregations: [{ fn: "sum", field: "amount", alias: "total" }],
      },
      ctx,
    )
    expect(adapter.lastQuery?.operation).toBe("aggregate")
  })
})

describe("backward compatibility", () => {
  it("default mode (per-resource) still generates per-resource tools", async () => {
    const v = makeVistal(new MockAdapter())
    const names = (await v.tools.openai(ctx)).map((t) => t.name)
    expect(names).toContain("query_order")
    expect(names).toContain("get_customer")
    expect(names).not.toContain("query")
  })

  it("consolidated mode via anthropic provider also works", async () => {
    const v = makeVistal(new MockAdapter())
    const tools = await v.tools.anthropic(ctx, { mode: "consolidated" })
    const names = tools.map((t) => t.name)
    expect(names).toContain("query")
    expect(names).toContain("list_resources")
  })
})
