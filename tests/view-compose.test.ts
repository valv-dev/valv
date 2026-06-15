import { describe, it, expect, vi, afterEach } from "vitest"
import { Valv, compose, deriveView, generateViewTypes, ValidationError } from "@valv/core"
import type { ValvAdapter, SchemaMap, ResolvedQuery } from "@valv/core"

interface Ctx {
  tenant: string
}
const ctx: Ctx = { tenant: "t1" }

const schema: SchemaMap = {
  resources: {
    order: {
      name: "order",
      tableName: "Order",
      fields: {
        id: { name: "id", type: "uuid", isNullable: false, isId: true, hasDefaultValue: true },
        amount: { name: "amount", type: "number", isNullable: false, isId: false },
        status: {
          name: "status",
          type: "enum",
          isNullable: false,
          isId: false,
          enumValues: ["pending", "paid"],
        },
        tenant_id: { name: "tenant_id", type: "string", isNullable: false, isId: false },
        note: { name: "note", type: "string", isNullable: true, isId: false },
      },
      relations: {},
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
  },
}

class MockAdapter implements ValvAdapter {
  results: Record<string, unknown> = {}
  async introspect(): Promise<SchemaMap> {
    return schema
  }
  async execute(query: ResolvedQuery): Promise<unknown> {
    return this.results[query.resource] ?? { data: [], hasMore: false }
  }
}

function makeValv(adapter: ValvAdapter) {
  return new Valv<Ctx>({ adapter })
    .policy("order", (c) => ({ read: { tenant_id: c.tenant } }))
    .policy("customer", () => ({ read: true }))
}

afterEach(() => {
  vi.useRealTimers()
})

interface OrderRow {
  id: string
  amount: number
  status: string
}
interface CustomerRow {
  id: string
  name: string
}

describe("compose()", () => {
  it("executes all inputs and applies the transform", async () => {
    const adapter = new MockAdapter()
    adapter.results.order = { data: [{ id: "o1", amount: 10 }], hasMore: false }
    adapter.results.customer = { data: [{ id: "c1", name: "Ada" }], hasMore: false }
    const valv = makeValv(adapter)

    const orders = await valv.view<OrderRow>("query_order", {}, ctx)
    const customers = await valv.view<CustomerRow>("query_customer", {}, ctx)

    const combined = compose([orders, customers], (o, c) => ({
      orderCount: o.data.length,
      customerNames: c.data.map((r) => r.name),
    }))

    expect(await combined.execute()).toEqual({ orderCount: 1, customerNames: ["Ada"] })
  })

  it("subscribe() recomputes on any input change, emits only when output changes", async () => {
    vi.useFakeTimers()
    const adapter = new MockAdapter()
    adapter.results.order = { data: [{ id: "o1", amount: 10 }], hasMore: false }
    adapter.results.customer = { data: [{ id: "c1", name: "Ada" }], hasMore: false }
    const valv = makeValv(adapter)

    const orders = await valv.view<OrderRow>("query_order", {}, ctx)
    const customers = await valv.view<CustomerRow>("query_customer", {}, ctx)
    const combined = compose([orders, customers], (o, c) => ({
      total: o.data.reduce((s, r) => s + r.amount, 0),
      customers: c.data.length,
    }))

    const onData = vi.fn()
    const sub = combined.subscribe(onData, { intervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(0)
    expect(onData).toHaveBeenCalledTimes(1)
    expect(onData).toHaveBeenLastCalledWith({ total: 10, customers: 1 })

    // An input change that doesn't change the output: new order id, same total.
    adapter.results.order = { data: [{ id: "o2", amount: 10 }], hasMore: false }
    await vi.advanceTimersByTimeAsync(1000)
    expect(onData).toHaveBeenCalledTimes(1)

    // A change that does move the output.
    adapter.results.order = { data: [{ id: "o2", amount: 25 }], hasMore: false }
    await vi.advanceTimersByTimeAsync(1000)
    expect(onData).toHaveBeenCalledTimes(2)
    expect(onData).toHaveBeenLastCalledWith({ total: 25, customers: 1 })

    sub.stop()
    // Stopped: no further emissions.
    adapter.results.order = { data: [], hasMore: false }
    await vi.advanceTimersByTimeAsync(3000)
    expect(onData).toHaveBeenCalledTimes(2)
  })

  it("routes transform errors to onError", async () => {
    vi.useFakeTimers()
    const adapter = new MockAdapter()
    const valv = makeValv(adapter)
    const orders = await valv.view<OrderRow>("query_order", {}, ctx)
    const boom = compose([orders], () => {
      throw new Error("bad transform")
    })
    const onError = vi.fn()
    const sub = boom.subscribe(vi.fn(), { onError })
    await vi.advanceTimersByTimeAsync(0)
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "bad transform" }))
    sub.stop()
  })
})

describe("deriveView()", () => {
  const orderRows = [
    { id: "o1", amount: 10, status: "paid" },
    { id: "o2", amount: 5, status: "paid" },
    { id: "o3", amount: 7, status: "pending" },
  ]

  async function makeOrdersView() {
    const adapter = new MockAdapter()
    adapter.results.order = { data: orderRows, hasMore: false }
    const valv = makeValv(adapter)
    const view = await valv.view<OrderRow>("query_order", {}, ctx)
    return { adapter, view }
  }

  it("groups, aggregates, sorts, and limits", async () => {
    const { view } = await makeOrdersView()
    const derived = deriveView(view, {
      groupBy: ["status"],
      aggregations: [
        { alias: "revenue", fn: "sum", field: "amount" },
        { alias: "n", fn: "count" },
      ],
      sort: { field: "revenue", direction: "desc" },
      limit: 2,
    })
    expect(await derived.execute()).toEqual({
      data: [
        { status: "paid", revenue: 15, n: 2 },
        { status: "pending", revenue: 7, n: 1 },
      ],
      hasMore: false,
    })
  })

  it("derives a result schema from the spec and source schema", async () => {
    const { view } = await makeOrdersView()
    const derived = deriveView(view, {
      groupBy: ["status"],
      aggregations: [
        { alias: "revenue", fn: "sum", field: "amount" },
        { alias: "n", fn: "count" },
      ],
    })
    const row = (derived.resultSchema as any).properties.data.items
    expect(row.properties.status).toEqual({ type: "string", enum: ["pending", "paid"] })
    expect(row.properties.revenue).toEqual({ type: "number" })
    expect(row.properties.n).toEqual({ type: "integer" })
  })

  it("validates agent-supplied specs against the source view", async () => {
    const { view } = await makeOrdersView()
    const base = { aggregations: [{ alias: "x", fn: "sum" as const, field: "amount" }] }
    expect(() => deriveView(view, { ...base, groupBy: ["nope"] })).toThrow(ValidationError)
    expect(() =>
      deriveView(view, { aggregations: [{ alias: "x", fn: "sum", field: "secret_field" }] }),
    ).toThrow(ValidationError)
    expect(() => deriveView(view, { aggregations: [{ alias: "__proto__", fn: "count" }] })).toThrow(
      ValidationError,
    )
    expect(() =>
      deriveView(view, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        aggregations: [{ alias: "x", fn: "eval" as any, field: "amount" }],
      }),
    ).toThrow(ValidationError)
    expect(
      () => deriveView(view, { ...base, sort: { field: "amount" } }), // not grouped or aliased
    ).toThrow(ValidationError)
    expect(() => deriveView(view, { aggregations: [] })).toThrow(ValidationError)
  })

  it("subscribe() emits only when the derived output changes", async () => {
    vi.useFakeTimers()
    const { adapter, view } = await makeOrdersView()
    const derived = deriveView(view, {
      groupBy: ["status"],
      aggregations: [{ alias: "revenue", fn: "sum", field: "amount" }],
    })
    const onData = vi.fn()
    const sub = derived.subscribe(onData, { intervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(0)
    expect(onData).toHaveBeenCalledTimes(1)

    // Source rows change but the derived series doesn't (id swap, same sums).
    adapter.results.order = {
      data: [
        { id: "oX", amount: 15, status: "paid" },
        { id: "o3", amount: 7, status: "pending" },
      ],
      hasMore: false,
    }
    await vi.advanceTimersByTimeAsync(1000)
    expect(onData).toHaveBeenCalledTimes(1)

    adapter.results.order = { data: [{ id: "oX", amount: 99, status: "paid" }], hasMore: false }
    await vi.advanceTimersByTimeAsync(1000)
    expect(onData).toHaveBeenCalledTimes(2)
    expect(onData.mock.calls[1][0].data).toEqual([{ status: "paid", revenue: 99 }])
    sub.stop()
  })
})

describe("generateViewTypes()", () => {
  it("emits row + result interfaces from a resultSchema", async () => {
    const adapter = new MockAdapter()
    const valv = makeValv(adapter)
    const view = await valv.view("query_order", {}, ctx)
    const src = generateViewTypes(view.resultSchema, "Order")

    expect(src).toContain("export interface OrderRow {")
    expect(src).toContain("id: string")
    expect(src).toContain('status: "pending" | "paid"')
    expect(src).toContain("amount: number")
    expect(src).toContain("note: string | null")
    expect(src).toContain("export interface OrderResult {")
    expect(src).toContain("data: OrderRow[]")
    expect(src).toContain("nextCursor?: string")
  })

  it("handles derived views and rejects non-view schemas", async () => {
    const adapter = new MockAdapter()
    adapter.results.order = { data: [], hasMore: false }
    const valv = makeValv(adapter)
    const view = await valv.view<OrderRow>("query_order", {}, ctx)
    const derived = deriveView(view, {
      groupBy: ["status"],
      aggregations: [{ alias: "revenue", fn: "sum", field: "amount" }],
    })
    const src = generateViewTypes(derived.resultSchema, "Revenue")
    expect(src).toContain("revenue: number")
    expect(() => generateViewTypes({}, "X")).toThrow(/resultSchema/)
  })
})
