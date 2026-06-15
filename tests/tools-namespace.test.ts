import { describe, it, expect } from "vitest"
import { Valv } from "@valv/core"
import type { ValvAdapter, SchemaMap, ResolvedQuery, DefaultContext } from "@valv/core"

const ctx: DefaultContext = { user: { id: "u1", role: "admin" } }

const schema: SchemaMap = {
  resources: {
    order: {
      name: "order",
      tableName: "Order",
      fields: {
        id: { name: "id", type: "uuid", isNullable: false, isId: true, hasDefaultValue: true },
        amount: { name: "amount", type: "number", isNullable: false, isId: false },
        tenant_id: { name: "tenant_id", type: "string", isNullable: false, isId: false },
      },
      relations: {},
    },
  },
}

class MockAdapter implements ValvAdapter {
  lastQuery?: ResolvedQuery
  async introspect(): Promise<SchemaMap> {
    return schema
  }
  async execute(query: ResolvedQuery): Promise<unknown> {
    this.lastQuery = query
    return [{ id: "o1", amount: 10, tenant_id: "t1" }]
  }
}

function makeVista(adapter: MockAdapter) {
  return new Valv({ adapter }).policy("order", () => ({
    read: { tenant_id: "t1" },
    write: false,
    delete: false,
  }))
}

describe("valv.tools namespace", () => {
  it("openai returns { type: 'function', function } definitions", async () => {
    const valv = makeVista(new MockAdapter())
    const tools = await valv.tools.openai(ctx)
    const query = tools.find((t) => t.name === "query_order")!
    expect(query.definition.type).toBe("function")
    expect(query.definition.function.name).toBe("query_order")
    expect(query.definition.function).toHaveProperty("parameters")
  })

  it("anthropic returns input_schema definitions", async () => {
    const valv = makeVista(new MockAdapter())
    const tools = await valv.tools.anthropic(ctx)
    const query = tools.find((t) => t.name === "query_order")!
    expect(query.definition).toHaveProperty("input_schema")
    expect(query.definition.name).toBe("query_order")
  })

  it("gemini produces flat function declarations", async () => {
    const valv = makeVista(new MockAdapter())
    const gemini = await valv.tools.gemini(ctx)
    const g = gemini.find((t) => t.name === "query_order")!.definition
    expect(g.name).toBe("query_order")
    expect(g).toHaveProperty("parameters")
  })

  it("vercel returns a Vercel AI SDK ToolSet (description + parameters + execute per tool)", async () => {
    const valv = makeVista(new MockAdapter())
    const tools = await valv.tools.vercel(ctx)
    expect(tools).toHaveProperty("query_order")
    const t = tools["query_order"]
    expect(t).toHaveProperty("description")
    expect(t).toHaveProperty("parameters")
    expect(typeof t.execute).toBe("function")
  })

  it("execute() runs the policy-enforced query via the adapter", async () => {
    const adapter = new MockAdapter()
    const valv = makeVista(adapter)
    const tools = await valv.tools.openai(ctx)
    const result = await tools.find((t) => t.name === "query_order")!.execute({})
    expect(result).toEqual([{ id: "o1", amount: 10, tenant_id: "t1" }])
    // policy row filter is merged into the executed query
    expect(JSON.stringify(adapter.lastQuery)).toContain("tenant_id")
  })

  it("vercel execute() hides raw adapter errors behind a generic message", async () => {
    class ThrowingAdapter implements ValvAdapter {
      async introspect(): Promise<SchemaMap> {
        return schema
      }
      async execute(): Promise<unknown> {
        throw new Error("Invalid `model.findMany()` invocation in /home/nico/.../adapter.ts:74")
      }
    }
    const valv = new Valv({ adapter: new ThrowingAdapter() }).policy("order", () => ({
      read: true,
    }))
    const tools = await valv.tools.vercel(ctx)
    const result = (await tools["query_order"].execute({})) as { error: string }
    expect(result.error).toBe("The query could not be completed due to an internal error.")
    expect(result.error).not.toContain("adapter.ts")
  })

  it("vercel execute() passes through valv's own validation errors", async () => {
    const valv = makeVista(new MockAdapter())
    const tools = await valv.tools.vercel(ctx)
    // unknown filter operator → ValidationError surfaced verbatim for model recovery
    const result = (await tools["query_order"].execute({
      filters: { amount: { between: [1, 5] } },
    })) as { error: string }
    expect(result.error).toMatch(/Unsupported filter for field "amount"/)
  })

  it("format() honors a custom formatter", async () => {
    const valv = makeVista(new MockAdapter())
    const tools = await valv.tools.format(ctx, (t) => ({ id: t.name, schema: t.parameters }))
    const query = tools.find((t) => t.name === "query_order")!
    expect((query.definition as any).id).toBe("query_order")
    expect(query.definition).toHaveProperty("schema")
  })

  it("write: false → no create/update tools in any format", async () => {
    const valv = makeVista(new MockAdapter())
    const names = (await valv.tools.openai(ctx)).map((t) => t.name)
    expect(names).not.toContain("create_order")
    expect(names).not.toContain("update_order")
  })

  it("getTools() still returns the legacy Anthropic input_schema shape", async () => {
    const valv = makeVista(new MockAdapter())
    const tools = await valv.getTools(ctx)
    const query = tools.find((t) => t.name === "query_order")!
    expect(query).toHaveProperty("input_schema")
    expect(query).not.toHaveProperty("parameters")
  })
})
