import { describe, it, expect } from "vitest"
import { evaluatePolicy, mergeFilters } from "../packages/core/src/policy/engine"
import type { ResourceSchema } from "@vistal/core"

const mockResource: ResourceSchema = {
  name: "orders",
  tableName: "Order",
  fields: {
    id:             { name: "id",             type: "uuid",   isNullable: false, isId: true },
    tenant_id:      { name: "tenant_id",      type: "string", isNullable: false, isId: false },
    status:         { name: "status",         type: "string", isNullable: false, isId: false },
    user_id:        { name: "user_id",        type: "string", isNullable: false, isId: false },
    internal_notes: { name: "internal_notes", type: "string", isNullable: true,  isId: false },
    amount:         { name: "amount",         type: "number", isNullable: false, isId: false },
    password_hash:  { name: "password_hash",  type: "string", isNullable: false, isId: false, sensitive: true },
  },
  relations: {
    customer: { name: "customer", targetResource: "users",  type: "belongsTo", foreignKey: "user_id" },
    items:    { name: "items",    targetResource: "items",  type: "hasMany",   foreignKey: "order_id" },
  },
}

describe("evaluatePolicy", () => {
  it("read: false → not allowed", () => {
    const result = evaluatePolicy(
      () => ({ read: false }),
      {},
      "read",
      "deny-all",
      mockResource
    )
    expect(result.allowed).toBe(false)
    expect(result.allowedFields).toEqual([])
    expect(result.allowedRelations).toEqual([])
  })

  it("read: true → allowed, all non-sensitive fields", () => {
    const result = evaluatePolicy(
      () => ({ read: true }),
      {},
      "read",
      "deny-all",
      mockResource
    )
    expect(result.allowed).toBe(true)
    expect(result.allowedFields).not.toContain("password_hash")
    expect(result.allowedFields).toContain("id")
    expect(result.allowedFields).toContain("status")
    expect(result.rowFilter).toBeUndefined()
  })

  it("read: { tenant_id: 'x' } → row filter injected", () => {
    const result = evaluatePolicy(
      () => ({ read: { tenant_id: "abc" } }),
      {},
      "read",
      "deny-all",
      mockResource
    )
    expect(result.allowed).toBe(true)
    expect(result.rowFilter).toEqual({ type: "eq", field: "tenant_id", value: "abc" })
  })

  it("no policy + deny-all → not allowed", () => {
    const result = evaluatePolicy(undefined, {}, "read", "deny-all", mockResource)
    expect(result.allowed).toBe(false)
  })

  it("no policy + allow-all → allowed", () => {
    const result = evaluatePolicy(undefined, {}, "read", "allow-all", mockResource)
    expect(result.allowed).toBe(true)
  })

  it("fields.deny strips denied fields", () => {
    const result = evaluatePolicy(
      () => ({ read: true, fields: { deny: ["user_id", "internal_notes"] } }),
      {},
      "read",
      "deny-all",
      mockResource
    )
    expect(result.allowed).toBe(true)
    expect(result.allowedFields).not.toContain("user_id")
    expect(result.allowedFields).not.toContain("internal_notes")
    expect(result.allowedFields).not.toContain("password_hash")
    expect(result.allowedFields).toContain("id")
    expect(result.allowedFields).toContain("status")
  })

  it("fields.allow whitelists fields, still excludes sensitive", () => {
    const result = evaluatePolicy(
      () => ({ read: true, fields: { allow: ["id", "status", "password_hash"] } }),
      {},
      "read",
      "deny-all",
      mockResource
    )
    expect(result.allowed).toBe(true)
    expect(result.allowedFields).toContain("id")
    expect(result.allowedFields).toContain("status")
    expect(result.allowedFields).not.toContain("password_hash")
  })

  it("relations: { customer: false } → customer not in allowedRelations", () => {
    const result = evaluatePolicy(
      () => ({ read: true, relations: { customer: false, items: true } }),
      {},
      "read",
      "deny-all",
      mockResource
    )
    expect(result.allowedRelations).not.toContain("customer")
    expect(result.allowedRelations).toContain("items")
  })

  it("sensitive field never in allowedFields even without deny list", () => {
    const result = evaluatePolicy(
      () => ({ read: true }),
      {},
      "read",
      "deny-all",
      mockResource
    )
    expect(result.allowedFields).not.toContain("password_hash")
  })

  it("write: { tenant_id } → forcedWriteFields set, rowFilter set as guard", () => {
    const result = evaluatePolicy(
      () => ({ write: { tenant_id: "t1" } }),
      {},
      "write",
      "deny-all",
      mockResource
    )
    expect(result.allowed).toBe(true)
    expect(result.forcedWriteFields).toEqual({ tenant_id: "t1" })
    expect(result.rowFilter).toEqual({ type: "eq", field: "tenant_id", value: "t1" })
  })

  it("write: false → not allowed, no forcedWriteFields", () => {
    const result = evaluatePolicy(
      () => ({ write: false }),
      {},
      "write",
      "deny-all",
      mockResource
    )
    expect(result.allowed).toBe(false)
    expect(result.forcedWriteFields).toBeUndefined()
  })

  // ── Rich predicates + OR ────────────────────────────────────────────────

  it("read with operator predicate → range row filter", () => {
    const result = evaluatePolicy(
      () => ({ read: { amount: { lt: 1000 } } }),
      {},
      "read",
      "deny-all",
      mockResource
    )
    expect(result.allowed).toBe(true)
    expect(result.rowFilter).toEqual({ type: "range", field: "amount", lt: 1000 })
  })

  it("read with OR combinator → or row filter", () => {
    const result = evaluatePolicy(
      () => ({ read: { OR: [{ user_id: "u1" }, { status: "public" }] } }),
      {},
      "read",
      "deny-all",
      mockResource
    )
    expect(result.rowFilter).toEqual({
      type: "or",
      filters: [
        { type: "eq", field: "user_id", value: "u1" },
        { type: "eq", field: "status", value: "public" },
      ],
    })
  })

  it("read with multiple keys + operator → AND of eq and range", () => {
    const result = evaluatePolicy(
      () => ({ read: { tenant_id: "t1", amount: { gte: 10 } } }),
      {},
      "read",
      "deny-all",
      mockResource
    )
    expect(result.rowFilter).toEqual({
      type: "and",
      filters: [
        { type: "eq", field: "tenant_id", value: "t1" },
        { type: "range", field: "amount", gte: 10 },
      ],
    })
  })

  // ── Write inject-vs-guard split ─────────────────────────────────────────

  it("update with scalar + operator → only scalar forced, full predicate guards", () => {
    const result = evaluatePolicy(
      () => ({ update: { tenant_id: "t1", amount: { lt: 1000 } } }),
      {},
      "update",
      "deny-all",
      mockResource
    )
    // Only the scalar equality is injected into the row.
    expect(result.forcedWriteFields).toEqual({ tenant_id: "t1" })
    // The full predicate (including the operator) becomes the WHERE guard.
    expect(result.rowFilter).toEqual({
      type: "and",
      filters: [
        { type: "eq", field: "tenant_id", value: "t1" },
        { type: "range", field: "amount", lt: 1000 },
      ],
    })
  })

  it("create with operator on required field → ValidationError", () => {
    expect(() =>
      evaluatePolicy(
        () => ({ create: { amount: { gt: 0 } } }),
        {},
        "create",
        "deny-all",
        mockResource
      )
    ).toThrow(/operator filter on required field/)
  })

  it("create with operator on nullable field → entry dropped, no throw", () => {
    const result = evaluatePolicy(
      () => ({ create: { tenant_id: "t1", internal_notes: { contains: "x" } } }),
      {},
      "create",
      "deny-all",
      mockResource
    )
    expect(result.allowed).toBe(true)
    expect(result.forcedWriteFields).toEqual({ tenant_id: "t1" })
  })

  // ── Operation granularity ───────────────────────────────────────────────

  it("create allowed but update denied via separate keys", () => {
    const policy = () => ({ create: true, update: false })
    expect(evaluatePolicy(policy, {}, "create", "deny-all", mockResource).allowed).toBe(true)
    expect(evaluatePolicy(policy, {}, "update", "deny-all", mockResource).allowed).toBe(false)
  })

  it("write shorthand sets both create and update", () => {
    const policy = () => ({ write: true })
    expect(evaluatePolicy(policy, {}, "create", "deny-all", mockResource).allowed).toBe(true)
    expect(evaluatePolicy(policy, {}, "update", "deny-all", mockResource).allowed).toBe(true)
  })

  it("aggregate allowed but row reads denied", () => {
    const policy = () => ({ read: false, aggregate: true })
    expect(evaluatePolicy(policy, {}, "read", "deny-all", mockResource).allowed).toBe(false)
    expect(evaluatePolicy(policy, {}, "aggregate", "deny-all", mockResource).allowed).toBe(true)
  })

  it("aggregate falls back to read when unspecified", () => {
    const policy = () => ({ read: true })
    expect(evaluatePolicy(policy, {}, "aggregate", "deny-all", mockResource).allowed).toBe(true)
  })

  // ── Read-only / write-only fields ───────────────────────────────────────

  it("readOnly field present on read, absent on write", () => {
    const policy = () => ({ read: true, write: true, fields: { readOnly: ["status"] } })
    const read = evaluatePolicy(policy, {}, "read", "deny-all", mockResource)
    const create = evaluatePolicy(policy, {}, "create", "deny-all", mockResource)
    expect(read.allowedFields).toContain("status")
    expect(create.allowedFields).not.toContain("status")
  })

  it("writeOnly field present on write, absent on read", () => {
    const policy = () => ({ read: true, write: true, fields: { writeOnly: ["internal_notes"] } })
    const read = evaluatePolicy(policy, {}, "read", "deny-all", mockResource)
    const update = evaluatePolicy(policy, {}, "update", "deny-all", mockResource)
    expect(read.allowedFields).not.toContain("internal_notes")
    expect(update.allowedFields).toContain("internal_notes")
  })
})

describe("mergeFilters", () => {
  it("both undefined → undefined", () => {
    expect(mergeFilters(undefined, undefined)).toBeUndefined()
  })

  it("only policy filter → returns policy filter", () => {
    const pf = { type: "eq" as const, field: "tenant_id", value: "x" }
    expect(mergeFilters(pf, undefined)).toEqual(pf)
  })

  it("only llm filter → returns llm filter", () => {
    const lf = { type: "eq" as const, field: "status", value: "active" }
    expect(mergeFilters(undefined, lf)).toEqual(lf)
  })

  it("both filters → AND node", () => {
    const pf = { type: "eq" as const, field: "tenant_id", value: "x" }
    const lf = { type: "eq" as const, field: "status", value: "active" }
    const merged = mergeFilters(pf, lf)
    expect(merged).toEqual({ type: "and", filters: [pf, lf] })
  })
})
