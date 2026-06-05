import { describe, it, expect } from "vitest"
import { buildResolvedQuery } from "../packages/core/src/ir/builder"
import type { SchemaMap } from "@vistal/core"
import { PolicyViolationError, ValidationError } from "@vistal/core"

const schema: SchemaMap = {
  resources: {
    orders: {
      name: "orders",
      tableName: "Order",
      fields: {
        id: { name: "id", type: "uuid", isNullable: false, isId: true },
        tenant_id: { name: "tenant_id", type: "string", isNullable: false, isId: false },
        status: {
          name: "status",
          type: "enum",
          isNullable: false,
          isId: false,
          enumValues: ["pending", "shipped", "delivered"],
        },
        amount: { name: "amount", type: "number", isNullable: false, isId: false },
        secret: { name: "secret", type: "string", isNullable: true, isId: false, sensitive: true },
      },
      relations: {
        items: {
          name: "items",
          targetResource: "items",
          type: "hasMany",
          foreignKey: "order_id",
        },
      },
    },
    items: {
      name: "items",
      tableName: "Item",
      fields: {
        id: { name: "id", type: "uuid", isNullable: false, isId: true },
        order_id: { name: "order_id", type: "string", isNullable: false, isId: false },
        name: { name: "name", type: "string", isNullable: false, isId: false },
      },
      relations: {},
    },
  },
}

describe("buildResolvedQuery", () => {
  it("basic find query", () => {
    const query = buildResolvedQuery(
      "query_orders",
      {},
      schema,
      { orders: () => ({ read: true }) },
      {},
      "deny-all",
    )
    expect(query.operation).toBe("find")
    expect(query.resource).toBe("orders")
    expect(query.fields).toContain("id")
    expect(query.fields).toContain("status")
    expect(query.fields).not.toContain("secret")
  })

  it("unknown field in filters → ValidationError", () => {
    expect(() =>
      buildResolvedQuery(
        "query_orders",
        { filters: { nonexistent_field: "x" } },
        schema,
        { orders: () => ({ read: true }) },
        {},
        "deny-all",
      ),
    ).toThrow(ValidationError)
  })

  it("operation not permitted → PolicyViolationError", () => {
    expect(() =>
      buildResolvedQuery(
        "query_orders",
        {},
        schema,
        { orders: () => ({ read: false }) },
        {},
        "deny-all",
      ),
    ).toThrow(PolicyViolationError)
  })

  it("policy row filter always present regardless of LLM input", () => {
    const query = buildResolvedQuery(
      "query_orders",
      { filters: { status: "pending" } },
      schema,
      { orders: () => ({ read: { tenant_id: "tenant-123" } }) },
      {},
      "deny-all",
    )
    expect(query.filters).toBeDefined()
    const filterStr = JSON.stringify(query.filters)
    expect(filterStr).toContain("tenant_id")
    expect(filterStr).toContain("tenant-123")
    expect(filterStr).toContain("status")
    expect(filterStr).toContain("pending")
  })

  it("accepts { eq } / { equals } as equality aliases", () => {
    for (const filters of [{ status: { eq: "pending" } }, { status: { equals: "pending" } }]) {
      const query = buildResolvedQuery(
        "query_orders",
        { filters },
        schema,
        { orders: () => ({ read: true }) },
        {},
        "deny-all",
      )
      expect(JSON.stringify(query.filters)).toContain('"type":"eq"')
      expect(JSON.stringify(query.filters)).toContain("pending")
    }
  })

  it("maps { ne } to a negated equality", () => {
    const query = buildResolvedQuery(
      "query_orders",
      { filters: { status: { ne: "pending" } } },
      schema,
      { orders: () => ({ read: true }) },
      {},
      "deny-all",
    )
    expect(query.filters).toEqual({
      type: "not",
      filter: { type: "eq", field: "status", value: "pending" },
    })
  })

  it("rejects an unknown filter operator with an actionable error", () => {
    expect(() =>
      buildResolvedQuery(
        "query_orders",
        { filters: { status: { like: "pend%" } } },
        schema,
        { orders: () => ({ read: true }) },
        {},
        "deny-all",
      ),
    ).toThrow(/Unsupported filter for field "status"/)
  })

  it("disallowed relation in include → ValidationError", () => {
    expect(() =>
      buildResolvedQuery(
        "query_orders",
        { include: ["items"] },
        schema,
        { orders: () => ({ read: true, relations: { items: false } }) },
        {},
        "deny-all",
      ),
    ).toThrow(ValidationError)
  })

  it("nested include resolves relation policy independently", () => {
    const query = buildResolvedQuery(
      "query_orders",
      { include: ["items"] },
      schema,
      { orders: () => ({ read: true }), items: () => ({ read: true }) },
      {},
      "deny-all",
    )
    expect(query.include).toBeDefined()
    expect(query.include!.items).toBeDefined()
    expect(query.include!.items.resource).toBe("items")
    expect(query.include!.items.fields).toContain("id")
  })

  it("denied fields stripped from IR", () => {
    const query = buildResolvedQuery(
      "query_orders",
      {},
      schema,
      { orders: () => ({ read: true, fields: { deny: ["amount"] } }) },
      {},
      "deny-all",
    )
    expect(query.fields).not.toContain("amount")
  })

  it("findOne by id sets eq filter", () => {
    const query = buildResolvedQuery(
      "get_orders",
      { id: "order-1" },
      schema,
      { orders: () => ({ read: true }) },
      {},
      "deny-all",
    )
    expect(query.operation).toBe("findOne")
    const filterStr = JSON.stringify(query.filters)
    expect(filterStr).toContain("order-1")
  })

  it("write operation denied → PolicyViolationError", () => {
    expect(() =>
      buildResolvedQuery(
        "create_orders",
        { status: "pending", tenant_id: "x", amount: 10 },
        schema,
        { orders: () => ({ read: true, write: false }) },
        {},
        "deny-all",
      ),
    ).toThrow(PolicyViolationError)
  })

  it("sort on disallowed field → ValidationError", () => {
    expect(() =>
      buildResolvedQuery(
        "query_orders",
        { sort: { field: "amount", direction: "asc" } },
        schema,
        { orders: () => ({ read: true, fields: { allow: ["id", "status"] } }) },
        {},
        "deny-all",
      ),
    ).toThrow(ValidationError)
  })

  it("invalid enum filter value → ValidationError", () => {
    expect(() =>
      buildResolvedQuery(
        "query_orders",
        { filters: { status: "invalid_value" } },
        schema,
        { orders: () => ({ read: true }) },
        {},
        "deny-all",
      ),
    ).toThrow(ValidationError)
  })

  it("valid enum filter value passes", () => {
    const query = buildResolvedQuery(
      "query_orders",
      { filters: { status: "pending" } },
      schema,
      { orders: () => ({ read: true }) },
      {},
      "deny-all",
    )
    expect(JSON.stringify(query.filters)).toContain("pending")
  })

  it("write: { tenant_id } forces tenant_id into create data and adds where guard for update", () => {
    const ctx = { tenant: { id: "t1" } }

    const createQuery = buildResolvedQuery(
      "create_orders",
      { amount: 100 },
      schema,
      { orders: () => ({ write: { tenant_id: ctx.tenant.id } }) },
      ctx,
      "deny-all",
    )
    expect(createQuery.data?.tenant_id).toBe("t1")

    const updateQuery = buildResolvedQuery(
      "update_orders",
      { id: "o1", amount: 200 },
      schema,
      { orders: () => ({ write: { tenant_id: ctx.tenant.id } }) },
      ctx,
      "deny-all",
    )
    expect(updateQuery.data?.tenant_id).toBe("t1")
    // Where filter must include tenant guard
    const whereStr = JSON.stringify(updateQuery.filters)
    expect(whereStr).toContain("tenant_id")
    expect(whereStr).toContain("t1")
  })

  it("forced write fields override LLM-supplied values", () => {
    const ctx = { tenant: { id: "t1" } }
    const query = buildResolvedQuery(
      "create_orders",
      { amount: 100, tenant_id: "evil-tenant" },
      schema,
      { orders: () => ({ write: { tenant_id: ctx.tenant.id } }) },
      ctx,
      "deny-all",
    )
    // Policy wins over LLM input
    expect(query.data?.tenant_id).toBe("t1")
  })

  it("aggregate operation is allowed under read policy", () => {
    const query = buildResolvedQuery(
      "aggregate_orders",
      { aggregations: [{ fn: "sum", field: "amount", alias: "total" }] },
      schema,
      { orders: () => ({ read: true }) },
      {},
      "deny-all",
    )
    expect(query.operation).toBe("aggregate")
    expect(query.aggregations).toBeDefined()
  })

  it("rich read policy → operator predicate AND-ed into filters", () => {
    const query = buildResolvedQuery(
      "query_orders",
      {},
      schema,
      { orders: () => ({ read: { amount: { lt: 1000 } } }) },
      {},
      "deny-all",
    )
    expect(query.filters).toEqual({ type: "range", field: "amount", lt: 1000 })
  })

  it("rich update policy forces scalar into data and guards with full predicate", () => {
    const query = buildResolvedQuery(
      "update_orders",
      { id: "o1", status: "shipped" },
      schema,
      { orders: () => ({ update: { tenant_id: "t1", amount: { lt: 1000 } } }) },
      {},
      "deny-all",
    )
    // Only the scalar equality is injected into the row…
    expect(query.data?.tenant_id).toBe("t1")
    expect(query.data).not.toHaveProperty("amount")
    // …while the operator predicate guards which rows may be updated.
    const whereStr = JSON.stringify(query.filters)
    expect(whereStr).toContain("tenant_id")
    expect(whereStr).toContain("range")
    expect(whereStr).toContain("o1") // id guard still present
  })

  it("create policy with operator on required field → ValidationError", () => {
    expect(() =>
      buildResolvedQuery(
        "create_orders",
        { tenant_id: "t1", status: "pending", amount: 5 },
        schema,
        { orders: () => ({ create: { amount: { gt: 0 } } }) },
        {},
        "deny-all",
      ),
    ).toThrow(ValidationError)
  })

  it("LLM cannot widen a disjunctive policy guard — OR stays AND-ed", () => {
    const query = buildResolvedQuery(
      "query_orders",
      { filters: { status: "pending" } },
      schema,
      { orders: () => ({ read: { OR: [{ tenant_id: "t1" }, { status: "shipped" }] } }) },
      {},
      "deny-all",
    )
    // Top level must be an AND wrapping the policy OR; the LLM filter cannot
    // escape the disjunctive scope.
    expect(query.filters).toEqual({
      type: "and",
      filters: [
        {
          type: "or",
          filters: [
            { type: "eq", field: "tenant_id", value: "t1" },
            { type: "eq", field: "status", value: "shipped" },
          ],
        },
        { type: "eq", field: "status", value: "pending" },
      ],
    })
  })

  it("create allowed but update denied → only create builds, update throws", () => {
    const policies = { orders: () => ({ create: { tenant_id: "t1" }, update: false }) }
    const created = buildResolvedQuery(
      "create_orders",
      { status: "pending", amount: 10 },
      schema,
      policies,
      {},
      "deny-all",
    )
    expect(created.data?.tenant_id).toBe("t1")
    expect(() =>
      buildResolvedQuery(
        "update_orders",
        { id: "o1", amount: 20 },
        schema,
        policies,
        {},
        "deny-all",
      ),
    ).toThrow(PolicyViolationError)
  })

  it("offset is bounded to 0 minimum", () => {
    const query = buildResolvedQuery(
      "query_orders",
      { offset: -5, limit: 10 },
      schema,
      { orders: () => ({ read: true }) },
      {},
      "deny-all",
    )
    expect(query.pagination?.offset).toBe(0)
  })
})
