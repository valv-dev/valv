import { describe, it, expect, vi, afterEach } from "vitest"
import { Valv, ValidationError, PolicyViolationError } from "@valv/core"
import type { ValvAdapter, SchemaMap, ResolvedQuery, QueryEvent } from "@valv/core"

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
        created_at: { name: "created_at", type: "date", isNullable: false, isId: false },
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
  },
}

class MockAdapter implements ValvAdapter {
  queries: ResolvedQuery[] = []
  result: unknown = { data: [], hasMore: false }
  async introspect(): Promise<SchemaMap> {
    return schema
  }
  async execute(query: ResolvedQuery): Promise<unknown> {
    this.queries.push(query)
    return this.result
  }
  get lastQuery(): ResolvedQuery | undefined {
    return this.queries[this.queries.length - 1]
  }
}

function makeValv(adapter: ValvAdapter, onQuery?: (e: QueryEvent<Ctx>) => void) {
  return new Valv<Ctx>({ adapter, onQuery })
    .policy("order", (c) => ({
      read: { tenant_id: c.tenant },
      write: { tenant_id: c.tenant },
      delete: false,
    }))
    .policy("customer", () => ({ read: true, write: false, delete: false }))
}

afterEach(() => {
  vi.useRealTimers()
})

describe("view() creation", () => {
  it("accepts per-resource read tools", async () => {
    const valv = makeValv(new MockAdapter())
    for (const name of ["query_order", "get_order", "aggregate_order"]) {
      const view = await valv.view(name, {}, ctx)
      expect(view.resource).toBe("order")
    }
    expect((await valv.view("query_order", {}, ctx)).operation).toBe("find")
    expect((await valv.view("get_order", {}, ctx)).operation).toBe("findOne")
    expect((await valv.view("aggregate_order", {}, ctx)).operation).toBe("aggregate")
  })

  it("accepts consolidated read calls", async () => {
    const adapter = new MockAdapter()
    const valv = makeValv(adapter)
    const view = await valv.view("query", { resource: "order", limit: 5 }, ctx)
    expect(view.resource).toBe("order")
    expect(view.operation).toBe("find")
    await view.execute()
    expect(adapter.lastQuery?.resource).toBe("order")
    expect(adapter.lastQuery?.pagination?.limit).toBe(5)
  })

  it("rejects write tools", async () => {
    const valv = makeValv(new MockAdapter())
    await expect(valv.view("create_order", { amount: 1 }, ctx)).rejects.toThrow(ValidationError)
    await expect(valv.view("update", { resource: "order", id: "1" }, ctx)).rejects.toThrow(
      /read operations/,
    )
    await expect(valv.view("delete_order", { id: "1" }, ctx)).rejects.toThrow(ValidationError)
  })

  it("rejects meta tools", async () => {
    const valv = makeValv(new MockAdapter())
    await expect(valv.view("list_resources", {}, ctx)).rejects.toThrow(/meta tool/)
    await expect(valv.view("describe_resource", { resource: "order" }, ctx)).rejects.toThrow(
      /meta tool/,
    )
  })

  it("fails fast on unknown resources and disallowed filters", async () => {
    const valv = makeValv(new MockAdapter())
    await expect(valv.view("query_nope", {}, ctx)).rejects.toThrow(ValidationError)
    await expect(valv.view("query_order", { filters: { secret: "x" } }, ctx)).rejects.toThrow(
      ValidationError,
    )
  })

  it("fails fast when policy denies read", async () => {
    const valv = new Valv<Ctx>({ adapter: new MockAdapter() }) // deny-all, no policies
    await expect(valv.view("query_order", {}, ctx)).rejects.toThrow(PolicyViolationError)
  })
})

describe("view().execute()", () => {
  it("passes the find envelope through and serializes rows", async () => {
    const adapter = new MockAdapter()
    adapter.result = {
      data: [
        {
          id: "a",
          amount: { toNumber: () => 12.5, toFixed: () => "12.50" }, // Decimal duck
          created_at: new Date("2026-01-02T03:04:05Z"),
        },
      ],
      nextCursor: "abc",
      hasMore: true,
    }
    const view = await makeValv(adapter).view("query_order", {}, ctx)
    const result = await view.execute()
    expect(result).toEqual({
      data: [{ id: "a", amount: 12.5, created_at: "2026-01-02T03:04:05.000Z" }],
      nextCursor: "abc",
      hasMore: true,
    })
  })

  it("wraps findOne results, including null", async () => {
    const adapter = new MockAdapter()
    const valv = makeValv(adapter)
    adapter.result = { id: "a", amount: 1 }
    const view = await valv.view("get_order", { id: "a" }, ctx)
    expect(await view.execute()).toEqual({ data: [{ id: "a", amount: 1 }], hasMore: false })
    adapter.result = null
    expect(await view.execute()).toEqual({ data: [], hasMore: false })
  })

  it("wraps aggregate results: grouped rows and bare alias objects", async () => {
    const adapter = new MockAdapter()
    const valv = makeValv(adapter)
    const args = {
      aggregations: [{ fn: "sum", field: "amount", alias: "total" }],
      groupBy: ["status"],
    }
    adapter.result = [{ status: "paid", total: 10 }]
    const view = await valv.view("aggregate_order", args, ctx)
    expect(await view.execute()).toEqual({
      data: [{ status: "paid", total: 10 }],
      hasMore: false,
    })
    adapter.result = { total: 10 }
    expect(await view.execute()).toEqual({ data: [{ total: 10 }], hasMore: false })
  })

  it("applies the policy row filter on every execution", async () => {
    const adapter = new MockAdapter()
    const view = await makeValv(adapter).view("query_order", {}, ctx)
    await view.execute()
    await view.execute()
    for (const query of adapter.queries) {
      expect(JSON.stringify(query.filters)).toContain('"tenant_id"')
    }
  })

  it("re-evaluates policies against mutable ctx per execution", async () => {
    const adapter = new MockAdapter()
    const liveCtx: Ctx = { tenant: "t1" }
    const view = await makeValv(adapter).view("query_order", {}, liveCtx)
    await view.execute()
    liveCtx.tenant = "t2"
    await view.execute()
    expect(JSON.stringify(adapter.queries[0].filters)).toContain("t1")
    expect(JSON.stringify(adapter.queries[1].filters)).toContain("t2")
  })

  it("is unaffected by caller mutating args after creation", async () => {
    const adapter = new MockAdapter()
    const args: Record<string, unknown> = { limit: 5 }
    const view = await makeValv(adapter).view("query_order", args, ctx)
    args.limit = 99
    await view.execute()
    expect(adapter.lastQuery?.pagination?.limit).toBe(5)
  })

  it("reports source 'view' to onQuery, while executeTool reports 'tool'", async () => {
    const events: QueryEvent<Ctx>[] = []
    const adapter = new MockAdapter()
    const valv = makeValv(adapter, (e) => events.push(e))
    const view = await valv.view("query_order", {}, ctx)
    await view.execute()
    await valv.executeTool("query_order", {}, ctx)
    expect(events.map((e) => e.source)).toEqual(["view", "tool"])
  })
})

describe("view().resultSchema", () => {
  type Envelope = {
    properties: {
      data: { items: { properties: Record<string, any>; required: string[] } }
      hasMore: object
      nextCursor: object
    }
    required: string[]
  }

  it("describes the envelope with policy-allowed fields only", async () => {
    const adapter = new MockAdapter()
    const valv = makeValv(adapter)
    const view = await valv.view("query_order", {}, ctx)
    const rs = view.resultSchema as Envelope
    expect(rs.required).toEqual(["data", "hasMore"])
    const row = rs.properties.data.items
    expect(row.properties.secret).toBeUndefined() // sensitive
    expect(row.properties.amount).toEqual({ type: "number" })
    expect(row.properties.created_at).toEqual({ type: "string", format: "date-time" })
    expect(row.properties.status).toEqual({ type: "string", enum: ["pending", "paid"] })
    expect(row.properties.note).toEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    })
  })

  it("excludes cursor bookkeeping internalFields", async () => {
    const adapter = new MockAdapter()
    const valv = new Valv<Ctx>({ adapter }).policy("order", (c) => ({
      read: { tenant_id: c.tenant },
      fields: { allow: ["amount", "status"] }, // pk hidden → injected as internal
    }))
    const view = await valv.view("query_order", {}, ctx)
    const row = (view.resultSchema as Envelope).properties.data.items
    expect(Object.keys(row.properties).sort()).toEqual(["amount", "status"])
  })

  it("describes included relations", async () => {
    const adapter = new MockAdapter()
    const view = await makeValv(adapter).view("query_order", { include: ["customer"] }, ctx)
    const row = (view.resultSchema as Envelope).properties.data.items
    expect(row.properties.customer).toEqual({
      anyOf: [
        {
          type: "object",
          properties: { id: { type: "string" }, name: { type: "string" } },
          required: ["id", "name"],
          additionalProperties: false,
        },
        { type: "null" },
      ],
    })
  })

  it("describes aggregate rows: groupBy fields plus alias types", async () => {
    const adapter = new MockAdapter()
    const view = await makeValv(adapter).view(
      "aggregate_order",
      {
        aggregations: [
          { fn: "sum", field: "amount", alias: "total" },
          { fn: "count", field: "*", alias: "n" },
        ],
        groupBy: ["status"],
      },
      ctx,
    )
    const row = (view.resultSchema as Envelope).properties.data.items
    expect(row.properties).toEqual({
      status: { type: "string", enum: ["pending", "paid"] },
      total: { type: "number" },
      n: { type: "integer" },
    })
  })
})

describe("view().subscribe() — polling", () => {
  function rows(...amounts: number[]) {
    return { data: amounts.map((amount, i) => ({ id: String(i), amount })), hasMore: false }
  }

  async function setup(opts?: { onError?: (e: Error) => void; emitInitial?: boolean }) {
    vi.useFakeTimers()
    const adapter = new MockAdapter()
    adapter.result = rows(1)
    const view = await makeValv(adapter).view("query_order", {}, ctx)
    const onData = vi.fn()
    const sub = view.subscribe(onData, { intervalMs: 1000, ...opts })
    await vi.advanceTimersByTimeAsync(0) // flush the initial tick
    return { adapter, view, onData, sub }
  }

  it("emits the initial result by default, then only on change", async () => {
    const { adapter, onData, sub } = await setup()
    expect(onData).toHaveBeenCalledTimes(1)
    expect(onData).toHaveBeenLastCalledWith(rows(1))

    await vi.advanceTimersByTimeAsync(1000) // same data → no emit
    expect(onData).toHaveBeenCalledTimes(1)

    adapter.result = rows(1, 2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(onData).toHaveBeenCalledTimes(2)
    expect(onData).toHaveBeenLastCalledWith(rows(1, 2))
    sub.stop()
  })

  it("skips the initial emit when emitInitial is false, but still baselines", async () => {
    const { adapter, onData, sub } = await setup({ emitInitial: false })
    expect(onData).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1000) // unchanged → still nothing
    expect(onData).not.toHaveBeenCalled()

    adapter.result = rows(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(onData).toHaveBeenCalledTimes(1)
    sub.stop()
  })

  it("routes errors to onError and keeps polling with backoff", async () => {
    const onError = vi.fn()
    const { adapter, onData, sub } = await setup({ onError })

    adapter.execute = async () => {
      throw new Error("db down")
    }
    await vi.advanceTimersByTimeAsync(1000)
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "db down" }))
    expect(onData).toHaveBeenCalledTimes(1)

    delete (adapter as Partial<MockAdapter>).execute // restore prototype method
    adapter.result = rows(7)
    // One consecutive error → next poll is backed off to 2× the interval.
    await vi.advanceTimersByTimeAsync(1000)
    expect(onData).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(onData).toHaveBeenCalledTimes(2) // recovered
    // Backoff resets after the success: the next change lands within one interval.
    adapter.result = rows(8)
    await vi.advanceTimersByTimeAsync(1000)
    expect(onData).toHaveBeenCalledTimes(3)
    sub.stop()
  })

  it("stop() halts polling and is idempotent", async () => {
    const { adapter, onData, sub } = await setup()
    sub.stop()
    sub.stop()
    adapter.result = rows(9)
    await vi.advanceTimersByTimeAsync(5000)
    expect(onData).toHaveBeenCalledTimes(1) // only the initial emit
  })

  it("never overlaps executions when the query is slower than the interval", async () => {
    vi.useFakeTimers()
    const adapter = new MockAdapter()
    let inFlight = 0
    let maxInFlight = 0
    adapter.execute = async (query: ResolvedQuery) => {
      adapter.queries.push(query)
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 3000)) // slower than the 1s interval
      inFlight--
      return rows(1)
    }
    const view = await makeValv(adapter).view("query_order", {}, ctx)
    const sub = view.subscribe(vi.fn(), { intervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(maxInFlight).toBe(1)
    expect(adapter.queries.length).toBeGreaterThan(1)
    sub.stop()
  })
})

describe("view().subscribe() — native adapter.subscribe", () => {
  class NativeAdapter extends MockAdapter {
    onChange?: () => void
    subscribedQuery?: ResolvedQuery
    unsubscribe = vi.fn()
    subscribe = (query: ResolvedQuery, onChange: () => void): (() => void) => {
      this.subscribedQuery = query
      this.onChange = onChange
      return this.unsubscribe
    }
  }

  it("uses adapter.subscribe instead of timers and re-executes on notification", async () => {
    vi.useFakeTimers()
    const adapter = new NativeAdapter()
    adapter.result = { data: [{ id: "1", amount: 1 }], hasMore: false }
    const view = await makeValv(adapter).view("query_order", {}, ctx)
    const onData = vi.fn()
    const sub = view.subscribe(onData)
    await vi.advanceTimersByTimeAsync(0)

    expect(onData).toHaveBeenCalledTimes(1)
    expect(adapter.subscribedQuery?.resource).toBe("order")
    expect(vi.getTimerCount()).toBe(0) // no polling scheduled

    adapter.onChange!() // notification with unchanged data → no emit
    await vi.advanceTimersByTimeAsync(0)
    expect(onData).toHaveBeenCalledTimes(1)

    adapter.result = { data: [{ id: "1", amount: 2 }], hasMore: false }
    adapter.onChange!()
    await vi.advanceTimersByTimeAsync(0)
    expect(onData).toHaveBeenCalledTimes(2)

    sub.stop()
    sub.stop()
    expect(adapter.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it("notifications still run through the policy pipeline", async () => {
    vi.useFakeTimers()
    const adapter = new NativeAdapter()
    const view = await makeValv(adapter).view("query_order", {}, ctx)
    const sub = view.subscribe(vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    adapter.onChange!()
    await vi.advanceTimersByTimeAsync(0)
    expect(adapter.queries.length).toBe(2)
    for (const query of adapter.queries) {
      expect(JSON.stringify(query.filters)).toContain('"tenant_id"')
    }
    sub.stop()
  })
})

describe("view serialization & registry", () => {
  it("toJSON() round-trips through viewFromJSON()", async () => {
    const adapter = new MockAdapter()
    const valv = makeValv(adapter)
    const view = await valv.view("query_order", { limit: 7 }, ctx)
    const json = JSON.parse(JSON.stringify(view)) // simulate persistence

    const rehydrated = await valv.viewFromJSON(json, ctx)
    expect(rehydrated.resource).toBe("order")
    await rehydrated.execute()
    expect(adapter.lastQuery?.pagination?.limit).toBe(7)
  })

  it("viewFromJSON() rejects malformed payloads", async () => {
    const valv = makeValv(new MockAdapter())
    await expect(valv.viewFromJSON({ toolName: "query_order" }, ctx)).rejects.toThrow(
      ValidationError,
    )
    await expect(valv.viewFromJSON(null, ctx)).rejects.toThrow(ValidationError)
  })

  it("registry: registerView / openView / listViews", async () => {
    const adapter = new MockAdapter()
    const valv = makeValv(adapter)
    valv.registerView("recent_orders", {
      toolName: "query_order",
      args: { limit: 10 },
      description: "Latest orders for the dashboard",
    })

    expect(valv.listViews()).toEqual([
      {
        name: "recent_orders",
        toolName: "query_order",
        args: { limit: 10 },
        description: "Latest orders for the dashboard",
      },
    ])

    const view = await valv.openView("recent_orders", ctx)
    expect(view.name).toBe("recent_orders")
    await view.execute()
    expect(adapter.lastQuery?.pagination?.limit).toBe(10)

    await expect(valv.openView("nope", ctx)).rejects.toThrow(/Unknown view "nope"/)
  })

  it("openView still enforces policy for the opening context", async () => {
    const valv = new Valv<Ctx>({ adapter: new MockAdapter() }) // deny-all
    valv.registerView("orders", { toolName: "query_order" })
    await expect(valv.openView("orders", ctx)).rejects.toThrow(PolicyViolationError)
  })
})

describe("shared engine", () => {
  function rows(...amounts: number[]) {
    return { data: amounts.map((amount, i) => ({ id: String(i), amount })), hasMore: false }
  }

  it("subscribers on the same view share one polling loop", async () => {
    vi.useFakeTimers()
    const adapter = new MockAdapter()
    adapter.result = rows(1)
    const view = await makeValv(adapter).view("query_order", {}, ctx)

    const a = vi.fn()
    const b = vi.fn()
    const subA = view.subscribe(a, { intervalMs: 1000 })
    const subB = view.subscribe(b, { intervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(0)

    const executesAfterStart = adapter.queries.length
    await vi.advanceTimersByTimeAsync(3000)
    // One loop: ~1 execute per interval regardless of subscriber count.
    expect(adapter.queries.length - executesAfterStart).toBeLessThanOrEqual(3)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)

    adapter.result = rows(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(a).toHaveBeenCalledTimes(2)
    expect(b).toHaveBeenCalledTimes(2)

    subA.stop()
    subB.stop()
  })

  it("a late subscriber gets the cached result immediately", async () => {
    vi.useFakeTimers()
    const adapter = new MockAdapter()
    adapter.result = rows(1)
    const view = await makeValv(adapter).view("query_order", {}, ctx)
    const first = view.subscribe(vi.fn(), { intervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(0)
    const executed = adapter.queries.length

    const late = vi.fn()
    const lateSub = view.subscribe(late, { intervalMs: 1000 })
    // Served from cache: emitted synchronously, no extra query.
    expect(late).toHaveBeenCalledTimes(1)
    expect(adapter.queries.length).toBe(executed)

    first.stop()
    lateSub.stop()
  })

  it("diffKey emissions include row-level added/removed/updated", async () => {
    vi.useFakeTimers()
    const adapter = new MockAdapter()
    adapter.result = {
      data: [
        { id: "a", amount: 1 },
        { id: "b", amount: 2 },
      ],
      hasMore: false,
    }
    const view = await makeValv(adapter).view("query_order", {}, ctx)
    const onData = vi.fn()
    const sub = view.subscribe(onData, { intervalMs: 1000, diffKey: "id" })
    await vi.advanceTimersByTimeAsync(0)

    // Initial emit: everything is "added".
    expect(onData.mock.calls[0][0].changes).toEqual({
      added: [
        { id: "a", amount: 1 },
        { id: "b", amount: 2 },
      ],
      removed: [],
      updated: [],
    })

    adapter.result = {
      data: [
        { id: "b", amount: 5 },
        { id: "c", amount: 3 },
      ],
      hasMore: false,
    }
    await vi.advanceTimersByTimeAsync(1000)
    expect(onData).toHaveBeenCalledTimes(2)
    expect(onData.mock.calls[1][0].changes).toEqual({
      added: [{ id: "c", amount: 3 }],
      removed: [{ id: "a", amount: 1 }],
      updated: [{ id: "b", amount: 5 }],
    })
    sub.stop()
  })

  it("maxConcurrentViewQueries caps simultaneous view executions", async () => {
    vi.useFakeTimers()
    const adapter = new MockAdapter()
    let inFlight = 0
    let maxInFlight = 0
    adapter.execute = async (query: ResolvedQuery) => {
      adapter.queries.push(query)
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 500))
      inFlight--
      return { data: [], hasMore: false }
    }
    const valv = new Valv<Ctx>({ adapter, maxConcurrentViewQueries: 2 }).policy(
      "order",
      (c) => ({
        read: { tenant_id: c.tenant },
      }),
    )

    // Five distinct views, all polling concurrently.
    const subs = []
    for (let i = 0; i < 5; i++) {
      const view = await valv.view("query_order", { limit: i + 1 }, ctx)
      subs.push(view.subscribe(vi.fn(), { intervalMs: 1000 }))
    }
    await vi.advanceTimersByTimeAsync(5000)
    expect(adapter.queries.length).toBeGreaterThanOrEqual(5)
    expect(maxInFlight).toBeLessThanOrEqual(2)
    for (const s of subs) s.stop()
  })
})
