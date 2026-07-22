import { describe, it, expect } from "vitest"
import { createValv } from "@valv/clickhouse"
import type { SchemaMap, DefaultContext, FieldSchema } from "@valv/core"
import { fakeClient } from "./helpers"

const f = (name: string, nativeType: string, extra: Partial<FieldSchema> = {}): FieldSchema => ({
  name,
  type: "string",
  nativeType,
  isNullable: false,
  isId: false,
  ...extra,
})

const schema: SchemaMap = {
  resources: {
    events: {
      name: "events",
      tableName: "events_t",
      relations: {},
      fields: {
        tenant_id: f("tenant_id", "String"),
        plan: f("plan", "String"),
        latency: f("latency", "UInt32", { type: "number" }),
        secret: f("secret", "String", { sensitive: true, isNullable: true }),
      },
    },
  },
}

const ctx: DefaultContext = { user: { id: "u1", role: "member" }, tenant: { id: "acme" } }

async function setup() {
  const client = fakeClient([{ plan: "pro", p95: 42 }])
  const valv = await createValv<DefaultContext>(client, { schema })
  valv.policy("events", (c) => ({ read: { tenant_id: c.tenant!.id } }))
  return { valv, calls: client.calls }
}

describe("aggregates (slice 2)", () => {
  it("emits a grouped query with a parametric ClickHouse function, ordering, and the tenant filter", async () => {
    const { valv, calls } = await setup()
    await valv.runTool(
      "query",
      {
        from: "events",
        select: { plan: true, p95: { quantileTiming: [0.95, "latency"] } },
        groupBy: ["plan"],
        orderBy: { plan: "desc" },
      },
      ctx,
    )

    expect(calls[0].query).toBe(
      "SELECT `plan`, quantileTiming(0.95)(`latency`) AS `p95` FROM `events_t` " +
        "WHERE (`tenant_id` = {p0:String}) GROUP BY `plan` ORDER BY `plan` DESC LIMIT 100",
    )
    expect(calls[0].query_params).toEqual({ p0: "acme" })
  })

  it("emits count(*) for a column-less aggregate", async () => {
    const { valv, calls } = await setup()
    await valv.runTool("query", { from: "events", select: { n: { count: true } } }, ctx)
    expect(calls[0].query).toBe(
      "SELECT count(*) AS `n` FROM `events_t` WHERE (`tenant_id` = {p0:String}) LIMIT 100",
    )
  })

  it("buckets time and counts distinct via Tier-2 functions", async () => {
    const { valv, calls } = await setup()
    await valv.runTool(
      "query",
      {
        from: "events",
        select: {
          bucket: { toStartOfInterval: ["latency", 1, "hour"] },
          plans: { uniqExact: "plan" },
        },
        groupBy: ["plan"],
      },
      ctx,
    )
    expect(calls[0].query).toBe(
      "SELECT toStartOfInterval(`latency`, INTERVAL 1 HOUR) AS `bucket`, uniqExact(`plan`) AS `plans` " +
        "FROM `events_t` WHERE (`tenant_id` = {p0:String}) GROUP BY `plan` LIMIT 100",
    )
  })

  it("parameterises the predicate of a conditional aggregate (countIf)", async () => {
    const { valv, calls } = await setup()
    await valv.runTool(
      "query",
      { from: "events", select: { slow: { countIf: { latency: { gt: 500 } } } } },
      ctx,
    )
    // The literal 500 binds as a param (p0); the tenant filter follows (p1).
    expect(calls[0].query).toBe(
      "SELECT countIf((`latency` > {p0:UInt32})) AS `slow` FROM `events_t` " +
        "WHERE (`tenant_id` = {p1:String}) LIMIT 100",
    )
    expect(calls[0].query_params).toEqual({ p0: 500, p1: "acme" })
  })

  it("rejects an enum unit outside the allowlist", async () => {
    const { valv } = await setup()
    await expect(
      valv.runTool(
        "query",
        { from: "events", select: { bucket: { toStartOfInterval: ["latency", 1, "century"] } } },
        ctx,
      ),
    ).rejects.toThrow(/expects one of/)
  })

  // The landmine: aggregation must not become a side channel to denied columns —
  // including a column hidden inside a predicate argument.
  it("rejects a sensitive column reached through an aggregate", async () => {
    const { valv } = await setup()
    await expect(
      valv.runTool("query", { from: "events", select: { x: { avg: "secret" } } }, ctx),
    ).rejects.toThrow(/not accessible/)
  })

  it("rejects a sensitive column hidden inside a countIf predicate", async () => {
    const { valv } = await setup()
    await expect(
      valv.runTool(
        "query",
        { from: "events", select: { x: { countIf: { secret: { not: "" } } } } },
        ctx,
      ),
    ).rejects.toThrow(/not accessible/)
  })

  it("groups by a SELECT alias (time-series over a computed bucket)", async () => {
    const { valv, calls } = await setup()
    await valv.runTool(
      "query",
      {
        from: "events",
        select: {
          bucket: { toStartOfInterval: ["latency", 1, "hour"] },
          hits: { count: true },
        },
        groupBy: ["bucket"],
        orderBy: { bucket: "asc" },
      },
      ctx,
    )
    expect(calls[0].query).toBe(
      "SELECT toStartOfInterval(`latency`, INTERVAL 1 HOUR) AS `bucket`, count(*) AS `hits` " +
        "FROM `events_t` WHERE (`tenant_id` = {p0:String}) GROUP BY `bucket` ORDER BY `bucket` ASC LIMIT 100",
    )
  })

  it("orders by an aggregate alias (top-N)", async () => {
    const { valv, calls } = await setup()
    await valv.runTool(
      "query",
      {
        from: "events",
        select: { plan: true, hits: { count: true } },
        groupBy: ["plan"],
        orderBy: { hits: "desc" },
        take: 10,
      },
      ctx,
    )
    expect(calls[0].query).toBe(
      "SELECT `plan`, count(*) AS `hits` FROM `events_t` " +
        "WHERE (`tenant_id` = {p0:String}) GROUP BY `plan` ORDER BY `hits` DESC LIMIT 10",
    )
  })

  // An alias only excuses GROUP BY/ORDER BY — it can't smuggle a denied column
  // that isn't actually a defined alias.
  it("still rejects a denied column in orderBy when it isn't a select alias", async () => {
    const { valv } = await setup()
    await expect(
      valv.runTool(
        "query",
        {
          from: "events",
          select: { plan: true, hits: { count: true } },
          groupBy: ["plan"],
          orderBy: { secret: "desc" },
        },
        ctx,
      ),
    ).rejects.toThrow(/not accessible/)
  })

  it("rejects a denied/unknown column in groupBy", async () => {
    const { valv } = await setup()
    await expect(
      valv.runTool("query", { from: "events", select: { plan: true }, groupBy: ["secret"] }, ctx),
    ).rejects.toThrow(/not accessible/)
  })

  it("rejects a denied/unknown column in orderBy", async () => {
    const { valv } = await setup()
    await expect(
      valv.runTool(
        "query",
        { from: "events", select: { plan: true }, orderBy: { secret: "asc" } },
        ctx,
      ),
    ).rejects.toThrow(/not accessible/)
  })

  it("rejects an unknown function name", async () => {
    const { valv } = await setup()
    await expect(
      valv.runTool("query", { from: "events", select: { x: { evil: "plan" } } }, ctx),
    ).rejects.toThrow(/Unknown function/)
  })

  it("rejects a prototype-key function name (allowlist isn't bypassable)", async () => {
    const { valv } = await setup()
    for (const fn of ["constructor", "toString", "hasOwnProperty"]) {
      await expect(
        valv.runTool("query", { from: "events", select: { x: { [fn]: "plan" } } }, ctx),
      ).rejects.toThrow(/Unknown function/)
    }
  })

  it("rejects a function called with the wrong arity", async () => {
    const { valv } = await setup()
    await expect(
      valv.runTool("query", { from: "events", select: { x: { quantileTiming: "latency" } } }, ctx),
    ).rejects.toThrow(/argument/)
  })

  it("rejects a non-column where a column argument is expected", async () => {
    const { valv } = await setup()
    await expect(
      valv.runTool("query", { from: "events", select: { x: { sum: 5 } } }, ctx),
    ).rejects.toThrow(/expects a column/)
  })

  it("rejects a quantile level outside [0, 1]", async () => {
    const { valv } = await setup()
    for (const level of [99, -0.1, 1.5]) {
      await expect(
        valv.runTool(
          "query",
          { from: "events", select: { x: { quantileTiming: [level, "latency"] } } },
          ctx,
        ),
      ).rejects.toThrow(/within \[0, 1\]/)
    }
  })

  // A column argument may be written as a bare name (the canonical form) or the
  // { col } object — both normalize to the same column reference.
  it("accepts a bare column name and the { col } object identically", async () => {
    const bare = await setup()
    await bare.valv.runTool(
      "query",
      { from: "events", select: { avg_latency: { avg: "latency" } } },
      ctx,
    )
    expect(bare.calls[0].query).toBe(
      "SELECT avg(`latency`) AS `avg_latency` FROM `events_t` WHERE (`tenant_id` = {p0:String}) LIMIT 100",
    )

    const obj = await setup()
    await obj.valv.runTool(
      "query",
      { from: "events", select: { avg_latency: { avg: { col: "latency" } } } },
      ctx,
    )
    expect(obj.calls[0].query).toBe(bare.calls[0].query)
  })

  // Column args are normalized before policy runs, so a denied column can't sneak
  // through as a function argument either.
  it("still policy-checks a denied column passed as a function arg", async () => {
    const { valv } = await setup()
    await expect(
      valv.runTool("query", { from: "events", select: { x: { avg: "secret" } } }, ctx),
    ).rejects.toThrow(/not accessible/)
  })
})
