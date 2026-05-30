import { describe, it, expect } from "vitest"
import { ORMAI, ORMAIAdapter } from "../src/ormai"
import { SchemaMap } from "../src/types"
import { ResolvedQuery } from "../src/ir/types"

const schema: SchemaMap = {
  resources: {
    order: {
      name: "order",
      tableName: "Order",
      fields: {
        id:        { name: "id",        type: "uuid",   isNullable: false, isId: true,  hasDefaultValue: true },
        amount:    { name: "amount",    type: "number", isNullable: false, isId: false },
        tenant_id: { name: "tenant_id", type: "string", isNullable: false, isId: false },
      },
      relations: {},
    },
  },
}

class MockAdapter implements ORMAIAdapter {
  lastQuery?: ResolvedQuery
  async introspect(): Promise<SchemaMap> {
    return schema
  }
  async execute(query: ResolvedQuery): Promise<unknown> {
    this.lastQuery = query
    return [{ id: "o1", amount: 10, tenant_id: "t1" }]
  }
}

function makeOrmai(adapter: MockAdapter) {
  return new ORMAI({ adapter }).policy("order", () => ({
    read: { tenant_id: "t1" },
    write: false,
    delete: false,
  }))
}

describe("ormai.tools namespace", () => {
  it("openai returns { type: 'function', function } definitions", async () => {
    const ormai = makeOrmai(new MockAdapter())
    const tools = await ormai.tools.openai({})
    const query = tools.find(t => t.name === "query_order")!
    expect(query.definition.type).toBe("function")
    expect(query.definition.function.name).toBe("query_order")
    expect(query.definition.function).toHaveProperty("parameters")
  })

  it("anthropic returns input_schema definitions", async () => {
    const ormai = makeOrmai(new MockAdapter())
    const tools = await ormai.tools.anthropic({})
    const query = tools.find(t => t.name === "query_order")!
    expect(query.definition).toHaveProperty("input_schema")
    expect(query.definition.name).toBe("query_order")
  })

  it("gemini and vercel produce their respective shapes", async () => {
    const ormai = makeOrmai(new MockAdapter())
    const gemini = await ormai.tools.gemini({})
    expect(gemini.find(t => t.name === "query_order")!.definition).toHaveProperty("parameters")

    const vercel = await ormai.tools.vercel({})
    const v = vercel.find(t => t.name === "query_order")!.definition
    expect(v).toHaveProperty("description")
    expect(v).toHaveProperty("parameters")
    expect(v).not.toHaveProperty("name")
  })

  it("execute() runs the policy-enforced query via the adapter", async () => {
    const adapter = new MockAdapter()
    const ormai = makeOrmai(adapter)
    const tools = await ormai.tools.openai({})
    const result = await tools.find(t => t.name === "query_order")!.execute({})
    expect(result).toEqual([{ id: "o1", amount: 10, tenant_id: "t1" }])
    // policy row filter is merged into the executed query
    expect(JSON.stringify(adapter.lastQuery)).toContain("tenant_id")
  })

  it("format() honors a custom formatter", async () => {
    const ormai = makeOrmai(new MockAdapter())
    const tools = await ormai.tools.format({}, (t) => ({ id: t.name, schema: t.parameters }))
    const query = tools.find(t => t.name === "query_order")!
    expect(query.definition.id).toBe("query_order")
    expect(query.definition).toHaveProperty("schema")
  })

  it("write: false → no create/update tools in any format", async () => {
    const ormai = makeOrmai(new MockAdapter())
    const names = (await ormai.tools.openai({})).map(t => t.name)
    expect(names).not.toContain("create_order")
    expect(names).not.toContain("update_order")
  })

  it("getTools() still returns the legacy Anthropic input_schema shape", async () => {
    const ormai = makeOrmai(new MockAdapter())
    const tools = await ormai.getTools({})
    const query = tools.find(t => t.name === "query_order")!
    expect(query).toHaveProperty("input_schema")
    expect(query).not.toHaveProperty("parameters")
  })
})
