import { describe, it, expect, vi } from "vitest"
import { buildResolvedQuery } from "../packages/core/src/ir/builder"
import { generateTools } from "../packages/core/src/tools/generator"
import { encodeCursor, decodeCursor } from "../packages/core/src/ir/cursor"
import { PrismaAdapter } from "../packages/prisma/src/adapter"
import type { SchemaMap, ResolvedQuery, PaginationConfig } from "@valv/core"
import { ValidationError } from "@valv/core"

const schema: SchemaMap = {
  resources: {
    orders: {
      name: "orders",
      tableName: "Order",
      fields: {
        id: { name: "id", type: "uuid", isNullable: false, isId: true },
        tenant_id: { name: "tenant_id", type: "string", isNullable: false, isId: false },
        status: { name: "status", type: "string", isNullable: false, isId: false },
        amount: { name: "amount", type: "number", isNullable: false, isId: false },
        created_at: { name: "created_at", type: "date", isNullable: false, isId: false },
        note: { name: "note", type: "string", isNullable: true, isId: false },
      },
      relations: {},
    },
  },
}

const policies = { orders: () => ({ read: true }) }
const cfg: PaginationConfig = { maxLimit: 100, defaultLimit: 50 }

// ── Cursor codec ─────────────────────────────────────────────────────────────

describe("cursor codec", () => {
  it("round-trips a keyset through encode/decode", () => {
    const ks = {
      sortField: "created_at",
      direction: "desc" as const,
      sortValue: "2026-01-01T00:00:00.000Z",
      id: "o123",
    }
    expect(decodeCursor(encodeCursor(ks))).toEqual(ks)
  })

  it("preserves numeric and null sortValues", () => {
    const ks = { sortField: "amount", direction: "asc" as const, sortValue: 42.5, id: 7 }
    expect(decodeCursor(encodeCursor(ks))).toEqual(ks)
    const ksNull = { sortField: "amount", direction: "asc" as const, sortValue: null, id: 1 }
    expect(decodeCursor(encodeCursor(ksNull))).toEqual(ksNull)
  })

  it("defaults direction to asc when absent", () => {
    const bad = Buffer.from(
      JSON.stringify({ sortField: "id", sortValue: "x", id: "x" }),
      "utf8",
    ).toString("base64url")
    expect(decodeCursor(bad).direction).toBe("asc")
  })

  it("throws ValidationError on tampered base64", () => {
    expect(() => decodeCursor("!!!not-base64!!!")).toThrow(ValidationError)
  })

  it("throws ValidationError on valid base64 of non-cursor JSON", () => {
    const bad = Buffer.from(JSON.stringify({ foo: "bar" }), "utf8").toString("base64url")
    expect(() => decodeCursor(bad)).toThrow(ValidationError)
  })

  it("throws ValidationError on valid base64 of non-JSON", () => {
    const bad = Buffer.from("just text", "utf8").toString("base64url")
    expect(() => decodeCursor(bad)).toThrow(ValidationError)
  })
})

// ── Builder pagination logic ─────────────────────────────────────────────────

describe("buildResolvedQuery pagination", () => {
  const build = (input: Record<string, unknown>, c: PaginationConfig = cfg) =>
    buildResolvedQuery("query_orders", input, schema, policies, {}, "deny-all", c)

  it("applies the default limit when none supplied", () => {
    const q = build({})
    expect(q.pagination?.limit).toBe(50)
  })

  it("clamps a limit above maxLimit", () => {
    expect(build({ limit: 9999 }).pagination?.limit).toBe(100)
  })

  it("floors and lower-bounds a limit to at least 1", () => {
    expect(build({ limit: 0 }).pagination?.limit).toBe(1)
    expect(build({ limit: 3.9 }).pagination?.limit).toBe(3)
  })

  it("honors a custom maxLimit/defaultLimit config", () => {
    const custom: PaginationConfig = { maxLimit: 10, defaultLimit: 5 }
    expect(build({}, custom).pagination?.limit).toBe(5)
    expect(build({ limit: 1000 }, custom).pagination?.limit).toBe(10)
  })

  it("defaults sort to the primary key for finds", () => {
    const q = build({})
    expect(q.sort).toEqual({ field: "id", direction: "asc" })
    expect(q.pagination?.primaryKey).toBe("id")
    expect(q.pagination?.cursorField).toBe("id")
  })

  it("uses the explicit sort field as the cursor field", () => {
    const q = build({ sort: { field: "created_at", direction: "desc" } })
    expect(q.pagination?.cursorField).toBe("created_at")
  })

  it("decodes a valid cursor into pagination.keyset", () => {
    const cursor = encodeCursor({ sortField: "id", direction: "asc", sortValue: "o5", id: "o5" })
    const q = build({ cursor })
    expect(q.pagination?.keyset).toEqual({
      sortField: "id",
      direction: "asc",
      sortValue: "o5",
      id: "o5",
    })
  })

  it("derives the sort from the cursor when none is supplied", () => {
    const cursor = encodeCursor({
      sortField: "created_at",
      direction: "desc",
      sortValue: "2026-01-01T00:00:00.000Z",
      id: "o5",
    })
    const q = build({ cursor })
    expect(q.sort).toEqual({ field: "created_at", direction: "desc" })
    expect(q.pagination?.cursorField).toBe("created_at")
  })

  it("accepts a cursor with an identical explicit sort", () => {
    const cursor = encodeCursor({
      sortField: "created_at",
      direction: "desc",
      sortValue: "2026-01-01T00:00:00.000Z",
      id: "o5",
    })
    const q = build({ cursor, sort: { field: "created_at", direction: "desc" } })
    expect(q.pagination?.keyset?.sortField).toBe("created_at")
  })

  it("rejects a cursor whose sort field differs from an explicit sort", () => {
    const cursor = encodeCursor({ sortField: "amount", direction: "asc", sortValue: 10, id: "o5" })
    expect(() => build({ cursor, sort: { field: "created_at", direction: "asc" } })).toThrow(
      /Cursor does not match/,
    )
  })

  it("rejects a cursor whose direction differs from an explicit sort", () => {
    const cursor = encodeCursor({ sortField: "amount", direction: "asc", sortValue: 10, id: "o5" })
    expect(() => build({ cursor, sort: { field: "amount", direction: "desc" } })).toThrow(
      /Cursor does not match/,
    )
  })

  it("rejects a cursor on a nullable sort field", () => {
    const cursor = encodeCursor({ sortField: "note", direction: "asc", sortValue: "x", id: "o5" })
    expect(() => build({ cursor })).toThrow(/nullable sort field/)
  })

  it("cursor wins over offset (offset dropped)", () => {
    const cursor = encodeCursor({ sortField: "id", direction: "asc", sortValue: "o5", id: "o5" })
    const q = build({ cursor, offset: 40 })
    expect(q.pagination?.offset).toBeUndefined()
    expect(q.pagination?.keyset).toBeDefined()
  })

  it("honors offset when no cursor is supplied", () => {
    expect(build({ offset: 25 }).pagination?.offset).toBe(25)
  })

  it("injects the primary key into fields and records it as internal", () => {
    // policy exposes a field set that omits id
    const restricted = { orders: () => ({ read: true, fields: { allow: ["status", "amount"] } }) }
    const q = buildResolvedQuery("query_orders", {}, schema, restricted, {}, "deny-all", cfg)
    expect(q.fields).toContain("id")
    expect(q.internalFields).toContain("id")
  })

  it("does not mark already-allowed fields as internal", () => {
    const q = build({})
    expect(q.internalFields).toBeUndefined()
  })
})

// ── Tool schema reflects config ──────────────────────────────────────────────

describe("query tool pagination schema", () => {
  it("reflects configured maxLimit and exposes a cursor param", () => {
    const tools = generateTools(schema, policies, {}, "deny-all", {
      maxLimit: 25,
      defaultLimit: 10,
    })
    const q = tools.find((t) => t.name === "query_orders")!
    const props = (q.parameters as { properties: Record<string, { maximum?: number }> }).properties
    expect(props.limit.maximum).toBe(25)
    expect(props.cursor).toBeDefined()
  })
})

// ── Prisma adapter keyset / envelope ─────────────────────────────────────────

describe("PrismaAdapter find pagination", () => {
  const makeAdapter = (rows: Record<string, unknown>[]) => {
    const findMany = vi.fn().mockResolvedValue(rows)
    const prisma = { orders: { findMany } } as unknown as import("@prisma/client").PrismaClient
    return { adapter: new PrismaAdapter(prisma), findMany }
  }

  const findQuery = (overrides: Partial<ResolvedQuery> = {}): ResolvedQuery => ({
    resource: "orders",
    operation: "find",
    fields: ["id", "amount"],
    pagination: { limit: 2, primaryKey: "id", cursorField: "amount" },
    sort: { field: "amount", direction: "asc" },
    ...overrides,
  })

  it("returns an envelope and fetches limit+1 rows", async () => {
    const { adapter, findMany } = makeAdapter([
      { id: "a", amount: 1 },
      { id: "b", amount: 2 },
    ])
    const res = (await adapter.execute(findQuery())) as { data: unknown[]; hasMore: boolean }
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 3 }))
    expect(res.data).toHaveLength(2)
    expect(res.hasMore).toBe(false)
  })

  it("sets hasMore and drops the probe row, emitting a nextCursor", async () => {
    const { adapter } = makeAdapter([
      { id: "a", amount: 1 },
      { id: "b", amount: 2 },
      { id: "c", amount: 3 },
    ])
    const res = (await adapter.execute(findQuery())) as {
      data: unknown[]
      hasMore: boolean
      nextCursor?: string
    }
    expect(res.hasMore).toBe(true)
    expect(res.data).toHaveLength(2)
    expect(decodeCursor(res.nextCursor!)).toEqual({
      sortField: "amount",
      direction: "asc",
      sortValue: 2,
      id: "b",
    })
  })

  it("has no nextCursor when there are no more rows", async () => {
    const { adapter } = makeAdapter([{ id: "a", amount: 1 }])
    const res = (await adapter.execute(findQuery())) as { hasMore: boolean; nextCursor?: string }
    expect(res.hasMore).toBe(false)
    expect(res.nextCursor).toBeUndefined()
  })

  it("builds an ascending keyset WHERE with pk tiebreaker", async () => {
    const { adapter, findMany } = makeAdapter([])
    const keyset = { sortField: "amount", direction: "asc" as const, sortValue: 2, id: "b" }
    await adapter.execute(
      findQuery({
        pagination: { limit: 2, primaryKey: "id", cursorField: "amount", keyset },
        filters: { type: "eq", field: "tenant_id", value: "t1" },
      }),
    )
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            { tenant_id: "t1" },
            { OR: [{ amount: { gt: 2 } }, { AND: [{ amount: 2 }, { id: { gt: "b" } }] }] },
          ],
        },
        orderBy: [{ amount: "asc" }, { id: "asc" }],
      }),
    )
  })

  it("uses lt for a descending keyset", async () => {
    const { adapter, findMany } = makeAdapter([])
    const keyset = { sortField: "amount", direction: "desc" as const, sortValue: 5, id: "z" }
    await adapter.execute(
      findQuery({
        sort: { field: "amount", direction: "desc" },
        pagination: { limit: 2, primaryKey: "id", cursorField: "amount", keyset },
      }),
    )
    const call = findMany.mock.calls[0][0]
    expect(call.where).toEqual({
      OR: [{ amount: { lt: 5 } }, { AND: [{ amount: 5 }, { id: { lt: "z" } }] }],
    })
    expect(call.orderBy).toEqual([{ amount: "desc" }, { id: "desc" }])
  })

  it("simplifies the keyset WHERE when sorting by the primary key", async () => {
    const { adapter, findMany } = makeAdapter([])
    const keyset = { sortField: "id", direction: "asc" as const, sortValue: "m", id: "m" }
    await adapter.execute(
      findQuery({
        sort: { field: "id", direction: "asc" },
        pagination: { limit: 2, primaryKey: "id", cursorField: "id", keyset },
      }),
    )
    expect(findMany.mock.calls[0][0].where).toEqual({ id: { gt: "m" } })
  })

  it("strips internal-only fields from returned rows", async () => {
    const { adapter } = makeAdapter([
      { id: "a", amount: 1 },
      { id: "b", amount: 2 },
    ])
    const res = (await adapter.execute(
      findQuery({
        fields: ["amount", "id"],
        internalFields: ["id"],
        pagination: { limit: 5, primaryKey: "id", cursorField: "amount" },
      }),
    )) as { data: Record<string, unknown>[] }
    expect(res.data[0]).not.toHaveProperty("id")
    expect(res.data[0]).toHaveProperty("amount")
  })

  it("serializes Date sort values into the cursor as ISO strings", async () => {
    const d = new Date("2026-03-01T12:00:00.000Z")
    const { adapter } = makeAdapter([
      { id: "a", created_at: new Date("2026-01-01T00:00:00.000Z") },
      { id: "b", created_at: d },
      { id: "c", created_at: new Date("2026-06-01T00:00:00.000Z") },
    ])
    const res = (await adapter.execute(
      findQuery({
        fields: ["id", "created_at"],
        sort: { field: "created_at", direction: "asc" },
        pagination: { limit: 2, primaryKey: "id", cursorField: "created_at" },
      }),
    )) as { nextCursor?: string }
    expect(decodeCursor(res.nextCursor!).sortValue).toBe(d.toISOString())
  })
})
