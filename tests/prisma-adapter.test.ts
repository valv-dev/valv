import { describe, it, expect, vi } from "vitest"
import { translateFilter } from "../src/adapters/prisma"
import { PrismaAdapter } from "../src/adapters/prisma"
import { ResolvedQuery } from "../src/ir/types"

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
      expect.objectContaining({ orderBy: { status: "desc" } })
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
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 10, skip: 20 })
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
    const results = await adapter.execute(query) as Record<string, unknown>[]
    // customer fails tenant filter → nulled out
    expect(results[0].customer).toBeNull()
  })
})
