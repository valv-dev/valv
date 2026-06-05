import { describe, it, expect, vi } from "vitest"
import { translateFilter, matchesFilter, PrismaAdapter } from "@vistal/prisma"
import type { ResolvedQuery } from "@vistal/core"

describe("translateFilter", () => {
  it("EqFilter", () => {
    expect(translateFilter({ type: "eq", field: "status", value: "active" }))
      .toEqual({ status: "active" })
  })

  it("InFilter", () => {
    expect(translateFilter({ type: "in", field: "status", values: ["a", "b"] }))
      .toEqual({ status: { in: ["a", "b"] } })
  })

  it("RangeFilter with gte and lte", () => {
    expect(translateFilter({ type: "range", field: "amount", gte: 10, lte: 100 }))
      .toEqual({ amount: { gte: 10, lte: 100 } })
  })

  it("RangeFilter with only gt", () => {
    expect(translateFilter({ type: "range", field: "amount", gt: 5 }))
      .toEqual({ amount: { gt: 5 } })
  })

  it("LikeFilter contains", () => {
    expect(translateFilter({ type: "like", field: "name", value: "foo", mode: "contains" }))
      .toEqual({ name: { contains: "foo", mode: "insensitive" } })
  })

  it("LikeFilter startsWith", () => {
    expect(translateFilter({ type: "like", field: "name", value: "foo", mode: "startsWith" }))
      .toEqual({ name: { startsWith: "foo", mode: "insensitive" } })
  })

  it("LikeFilter endsWith", () => {
    expect(translateFilter({ type: "like", field: "name", value: "foo", mode: "endsWith" }))
      .toEqual({ name: { endsWith: "foo", mode: "insensitive" } })
  })

  it("NullFilter isNull: true", () => {
    expect(translateFilter({ type: "null", field: "deleted_at", isNull: true }))
      .toEqual({ deleted_at: null })
  })

  it("NullFilter isNull: false", () => {
    expect(translateFilter({ type: "null", field: "deleted_at", isNull: false }))
      .toEqual({ deleted_at: { not: null } })
  })

  it("AndFilter", () => {
    expect(translateFilter({
      type: "and",
      filters: [
        { type: "eq", field: "status", value: "active" },
        { type: "eq", field: "tenant_id", value: "abc" },
      ],
    })).toEqual({
      AND: [{ status: "active" }, { tenant_id: "abc" }],
    })
  })

  it("OrFilter", () => {
    expect(translateFilter({
      type: "or",
      filters: [
        { type: "eq", field: "status", value: "a" },
        { type: "eq", field: "status", value: "b" },
      ],
    })).toEqual({
      OR: [{ status: "a" }, { status: "b" }],
    })
  })

  it("NotFilter", () => {
    expect(translateFilter({
      type: "not",
      filter: { type: "eq", field: "status", value: "deleted" },
    })).toEqual({ NOT: { status: "deleted" } })
  })

  it("deeply nested OR inside AND (tenant guard + status OR amount range)", () => {
    expect(translateFilter({
      type: "and",
      filters: [
        { type: "eq", field: "tenant_id", value: "t1" },
        {
          type: "or",
          filters: [
            { type: "range", field: "total", gte: 10000 },
            { type: "eq", field: "status", value: "pending" },
          ],
        },
      ],
    })).toEqual({
      AND: [
        { tenant_id: "t1" },
        { OR: [{ total: { gte: 10000 } }, { status: "pending" }] },
      ],
    })
  })

  it("not(and(eq, like)) — negated compound filter", () => {
    expect(translateFilter({
      type: "not",
      filter: {
        type: "and",
        filters: [
          { type: "eq", field: "status", value: "cancelled" },
          { type: "like", field: "name", value: "test", mode: "contains" },
        ],
      },
    })).toEqual({
      NOT: {
        AND: [
          { status: "cancelled" },
          { name: { contains: "test", mode: "insensitive" } },
        ],
      },
    })
  })
})

describe("PrismaAdapter.execute", () => {
  function makeAdapter() {
    const findMany    = vi.fn().mockResolvedValue([])
    const findFirst   = vi.fn().mockResolvedValue(null)
    const create      = vi.fn().mockResolvedValue({ id: "1" })
    const updateMany  = vi.fn().mockResolvedValue({ count: 1 })
    const deleteMany  = vi.fn().mockResolvedValue({ count: 1 })

    const prisma = {
      orders:    { findMany, findFirst, create, updateMany, deleteMany },
      orderItem: { findMany, findFirst, create, updateMany, deleteMany },
    } as unknown as import("@prisma/client").PrismaClient

    return { adapter: new PrismaAdapter(prisma), mocks: { findMany, findFirst, create, updateMany, deleteMany } }
  }

  it("find → prisma.findMany with where and select", async () => {
    const { adapter, mocks } = makeAdapter()
    const query: ResolvedQuery = {
      resource: "orders",
      operation: "find",
      fields: ["id", "status"],
      filters: { type: "eq", field: "tenant_id", value: "t1" },
    }
    await adapter.execute(query)
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: { tenant_id: "t1" },
      select: { id: true, status: true },
      orderBy: [{ id: "asc" }],
    })
  })

  it("multi-word resource name uses camelCase Prisma accessor (order_item → orderItem)", async () => {
    const { adapter, mocks } = makeAdapter()
    const query: ResolvedQuery = {
      resource: "order_item",
      operation: "find",
      fields: ["id"],
    }
    await adapter.execute(query)
    expect(mocks.findMany).toHaveBeenCalled()
  })

  it("findOne → prisma.findFirst", async () => {
    const { adapter, mocks } = makeAdapter()
    const query: ResolvedQuery = {
      resource: "orders",
      operation: "findOne",
      fields: ["id"],
      filters: { type: "eq", field: "id", value: "order-1" },
    }
    await adapter.execute(query)
    expect(mocks.findFirst).toHaveBeenCalled()
  })

  it("create → prisma.create with data", async () => {
    const { adapter, mocks } = makeAdapter()
    const query: ResolvedQuery = {
      resource: "orders",
      operation: "create",
      fields: ["id", "status"],
      data: { status: "pending", tenant_id: "t1" },
    }
    await adapter.execute(query)
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "pending", tenant_id: "t1" } })
    )
  })

  it("update → prisma.updateMany with full where (enforces policy filter)", async () => {
    const { adapter, mocks } = makeAdapter()
    const query: ResolvedQuery = {
      resource: "orders",
      operation: "update",
      fields: ["id", "status"],
      // Merged filter: id + tenant policy guard
      filters: {
        type: "and",
        filters: [
          { type: "eq", field: "id", value: "order-1" },
          { type: "eq", field: "tenant_id", value: "t1" },
        ],
      },
      data: { status: "shipped" },
    }
    await adapter.execute(query)
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { AND: [{ id: "order-1" }, { tenant_id: "t1" }] },
        data: { status: "shipped" },
      })
    )
  })

  it("delete → prisma.deleteMany with full where", async () => {
    const { adapter, mocks } = makeAdapter()
    const query: ResolvedQuery = {
      resource: "orders",
      operation: "delete",
      fields: [],
      filters: {
        type: "and",
        filters: [
          { type: "eq", field: "id", value: "order-1" },
          { type: "eq", field: "tenant_id", value: "t1" },
        ],
      },
    }
    await adapter.execute(query)
    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: { AND: [{ id: "order-1" }, { tenant_id: "t1" }] },
    })
  })

  it("find with sort → orderBy in args", async () => {
    const { adapter, mocks } = makeAdapter()
    const query: ResolvedQuery = {
      resource: "orders",
      operation: "find",
      fields: ["id"],
      sort: { field: "status", direction: "desc" },
    }
    await adapter.execute(query)
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ status: "desc" }, { id: "desc" }] })
    )
  })

  it("find with pagination → take and skip", async () => {
    const { adapter, mocks } = makeAdapter()
    const query: ResolvedQuery = {
      resource: "orders",
      operation: "find",
      fields: ["id"],
      pagination: { limit: 10, offset: 20 },
    }
    await adapter.execute(query)
    // take is limit + 1 (one extra row probes for a next page); offset → skip
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 11, skip: 20 })
    )
  })

  it("find with include → nested select merged into parent select", async () => {
    const { adapter, mocks } = makeAdapter()
    const query: ResolvedQuery = {
      resource: "orders",
      operation: "find",
      fields: ["id"],
      include: {
        items: {
          resource: "items",
          type: "hasMany",
          foreignKey: "order_id",
          fields: ["id", "name"],
          filters: { type: "eq", field: "active", value: true },
        },
      },
    }
    await adapter.execute(query)
    const call = mocks.findMany.mock.calls[0][0]
    // Relations are merged into select, not a separate include key
    expect(call.select.items.select).toEqual({ id: true, name: true })
    expect(call.select.items.where).toEqual({ active: true })
  })

  it("two simultaneous includes (belongsTo + hasMany) both appear in select", async () => {
    const { adapter, mocks } = makeAdapter()
    const query: ResolvedQuery = {
      resource: "orders",
      operation: "find",
      fields: ["id", "total"],
      include: {
        customer: {
          resource: "users",
          type: "belongsTo",
          foreignKey: "user_id",
          fields: ["id", "name"],
        },
        items: {
          resource: "order_items",
          type: "hasMany",
          foreignKey: "order_id",
          fields: ["id", "quantity", "unit_price"],
          filters: { type: "eq", field: "tenant_id", value: "t1" },
        },
      },
    }
    await adapter.execute(query)
    const call = mocks.findMany.mock.calls[0][0]
    expect(call.select.customer.select).toEqual({ id: true, name: true })
    expect(call.select.items.select).toEqual({ id: true, quantity: true, unit_price: true })
    // hasMany filter pushed into where; belongsTo filter deferred post-fetch
    expect(call.select.items.where).toEqual({ tenant_id: "t1" })
    expect(call.select.customer.where).toBeUndefined()
    // Scalar fields still present
    expect(call.select.id).toBe(true)
    expect(call.select.total).toBe(true)
  })

  it("aggregate (flat count) → prisma.aggregate with _count and scoped where", async () => {
    const aggregate = vi.fn().mockResolvedValue({ _count: { id: 4 } })
    const prisma = {
      orders: { aggregate },
    } as unknown as import("@prisma/client").PrismaClient
    const adapter = new PrismaAdapter(prisma)

    const query: ResolvedQuery = {
      resource: "orders",
      operation: "aggregate",
      fields: [],
      filters: { type: "eq", field: "tenant_id", value: "t1" },
      aggregations: [{ fn: "count", field: "id", alias: "total_orders" }],
    }
    await adapter.execute(query)
    expect(aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenant_id: "t1" },
        _count: expect.objectContaining({ id: true }),
      })
    )
  })

  it("aggregate (sum + avg) → prisma.aggregate with _sum and _avg", async () => {
    const aggregate = vi.fn().mockResolvedValue({ _sum: { total: 100 }, _avg: { total: 25 } })
    const prisma = {
      orders: { aggregate },
    } as unknown as import("@prisma/client").PrismaClient
    const adapter = new PrismaAdapter(prisma)

    const query: ResolvedQuery = {
      resource: "orders",
      operation: "aggregate",
      fields: [],
      filters: { type: "eq", field: "tenant_id", value: "t1" },
      aggregations: [
        { fn: "sum", field: "total", alias: "revenue" },
        { fn: "avg", field: "total", alias: "avg_order" },
      ],
    }
    await adapter.execute(query)
    expect(aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenant_id: "t1" },
        _sum: { total: true },
        _avg: { total: true },
      })
    )
  })

  it("aggregate groupBy → prisma.groupBy with _sum and scoped where", async () => {
    const groupBy = vi.fn().mockResolvedValue([
      { status: "delivered", _sum: { total: 150000 } },
      { status: "pending",   _sum: { total: 30000 } },
    ])
    const prisma = {
      orders: { groupBy },
    } as unknown as import("@prisma/client").PrismaClient
    const adapter = new PrismaAdapter(prisma)

    const query: ResolvedQuery = {
      resource: "orders",
      operation: "aggregate",
      fields: [],
      filters: { type: "eq", field: "tenant_id", value: "t1" },
      aggregations: [{ fn: "sum", field: "total", alias: "revenue" }],
      groupBy: ["status"],
    }
    await adapter.execute(query)
    expect(groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ["status"],
        _sum: { total: true },
        where: { tenant_id: "t1" },
      })
    )
  })

  it("aggregate groupBy multi-field → prisma.groupBy with multiple by fields", async () => {
    const groupBy = vi.fn().mockResolvedValue([])
    const prisma = {
      orders: { groupBy },
    } as unknown as import("@prisma/client").PrismaClient
    const adapter = new PrismaAdapter(prisma)

    const query: ResolvedQuery = {
      resource: "orders",
      operation: "aggregate",
      fields: [],
      filters: { type: "eq", field: "tenant_id", value: "t1" },
      aggregations: [
        { fn: "count", field: "id", alias: "order_count" },
        { fn: "sum",   field: "total", alias: "revenue" },
      ],
      groupBy: ["status", "user_id"],
    }
    await adapter.execute(query)
    expect(groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ["status", "user_id"],
        _count: expect.objectContaining({ id: true }),
        _sum: { total: true },
      })
    )
  })

  it("belongsTo included record is nulled out when it fails the relation's row filter", async () => {
    const findManyWithCustomer = vi.fn().mockResolvedValue([
      { id: "o1", customer: { id: "u1", tenant_id: "wrong-tenant" } },
    ])
    const prisma = {
      orders: { findMany: findManyWithCustomer },
    } as unknown as import("@prisma/client").PrismaClient
    const adapter = new PrismaAdapter(prisma)

    const query: ResolvedQuery = {
      resource: "orders",
      operation: "find",
      fields: ["id"],
      include: {
        customer: {
          resource: "users",
          type: "belongsTo",
          foreignKey: "user_id",
          fields: ["id", "tenant_id"],
          filters: { type: "eq", field: "tenant_id", value: "correct-tenant" },
        },
      },
    }
    const { data } = await adapter.execute(query) as { data: Record<string, unknown>[] }
    // customer fails tenant filter → nulled out
    expect(data[0].customer).toBeNull()
  })
})

describe("matchesFilter (post-fetch belongsTo enforcement)", () => {
  it("range: passes within bounds, fails outside", () => {
    const f = { type: "range" as const, field: "amount", lt: 1000 }
    expect(matchesFilter({ amount: 500 }, f)).toBe(true)
    expect(matchesFilter({ amount: 5000 }, f)).toBe(false)
  })

  it("range: missing value fails", () => {
    expect(matchesFilter({}, { type: "range", field: "amount", gte: 0 })).toBe(false)
  })

  it("like: case-insensitive contains/startsWith/endsWith", () => {
    expect(matchesFilter({ name: "Hello World" }, { type: "like", field: "name", value: "WORLD", mode: "contains" })).toBe(true)
    expect(matchesFilter({ name: "Hello World" }, { type: "like", field: "name", value: "hello", mode: "startsWith" })).toBe(true)
    expect(matchesFilter({ name: "Hello World" }, { type: "like", field: "name", value: "xyz", mode: "endsWith" })).toBe(false)
  })

  it("null: matches null/undefined and its negation", () => {
    expect(matchesFilter({ deleted_at: null }, { type: "null", field: "deleted_at", isNull: true })).toBe(true)
    expect(matchesFilter({ deleted_at: "2026-01-01" }, { type: "null", field: "deleted_at", isNull: true })).toBe(false)
    expect(matchesFilter({ deleted_at: "2026-01-01" }, { type: "null", field: "deleted_at", isNull: false })).toBe(true)
  })

  it("not: negates the inner filter", () => {
    const f = { type: "not" as const, filter: { type: "eq" as const, field: "status", value: "draft" } }
    expect(matchesFilter({ status: "shipped" }, f)).toBe(true)
    expect(matchesFilter({ status: "draft" }, f)).toBe(false)
  })

  it("or/and compose rich nodes", () => {
    const f = {
      type: "or" as const,
      filters: [
        { type: "range" as const, field: "amount", gt: 100 },
        { type: "eq" as const, field: "vip", value: true },
      ],
    }
    expect(matchesFilter({ amount: 50, vip: true }, f)).toBe(true)
    expect(matchesFilter({ amount: 50, vip: false }, f)).toBe(false)
  })

  it("nulls out a belongsTo include failing a range policy filter", async () => {
    const adapter = new PrismaAdapter({
      order: {
        findMany: vi.fn().mockResolvedValue([
          { id: "o1", customer: { id: "c1", credit: 5000 } },
        ]),
      },
    } as unknown as import("@prisma/client").PrismaClient)

    const query: ResolvedQuery = {
      resource: "order",
      operation: "find",
      fields: ["id"],
      include: {
        customer: {
          resource: "users",
          type: "belongsTo",
          foreignKey: "user_id",
          fields: ["id", "credit"],
          filters: { type: "range", field: "credit", lt: 1000 },
        },
      },
    }
    const { data } = await adapter.execute(query) as { data: Record<string, unknown>[] }
    expect(data[0].customer).toBeNull()
  })
})
