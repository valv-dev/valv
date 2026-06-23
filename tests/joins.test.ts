import { describe, it, expect } from "vitest"
import { createValv } from "@valv/clickhouse"
import type { SchemaMap, ResourceSchema, RelationSchema, DefaultContext } from "@valv/core"
import { fakeClient, field, memberCtx } from "./helpers"

// A multi-table schema exercising belongsTo, hasMany, multi-hop chains, a
// sensitive column on a join target, and a deny-all target. tableName is
// suffixed `_t` so emitted SQL is unambiguous.
const rel = (
  name: string,
  targetResource: string,
  type: RelationSchema["type"],
  foreignKey: string,
  targetKey = "id",
): RelationSchema => ({ name, targetResource, type, foreignKey, targetKey })

const resource = (
  name: string,
  fields: ResourceSchema["fields"],
  relations: ResourceSchema["relations"] = {},
): ResourceSchema => ({ name, tableName: `${name}_t`, fields, relations })

const id = () => field("id", "string", "String", { isId: true })
const tenant = () => field("tenant_id", "string", "String")

const schema: SchemaMap = {
  resources: {
    order_items: resource(
      "order_items",
      {
        id: id(),
        tenant_id: tenant(),
        order_id: field("order_id", "string", "String"),
        quantity: field("quantity", "number", "UInt32"),
      },
      {
        order: rel("order", "orders", "belongsTo", "order_id"),
        refunds: rel("refunds", "refunds", "hasMany", "order_item_id"),
      },
    ),
    orders: resource(
      "orders",
      {
        id: id(),
        tenant_id: tenant(),
        customer_id: field("customer_id", "string", "String"),
        vault_id: field("vault_id", "string", "String"),
        total: field("total", "number", "UInt32"),
      },
      {
        customer: rel("customer", "customers", "belongsTo", "customer_id"),
        items: rel("items", "order_items", "hasMany", "order_id"),
        vault: rel("vault", "vaults", "belongsTo", "vault_id"),
      },
    ),
    customers: resource(
      "customers",
      {
        id: id(),
        tenant_id: tenant(),
        name: field("name", "string", "String"),
        internal_notes: field("internal_notes", "string", "String", { sensitive: true }),
        region_id: field("region_id", "string", "String"),
      },
      {
        orders: rel("orders", "orders", "hasMany", "customer_id"),
        region: rel("region", "regions", "belongsTo", "region_id"),
        peers: rel("peers", "customers", "manyToMany", ""),
      },
    ),
    regions: resource(
      "regions",
      {
        id: id(),
        tenant_id: tenant(),
        name: field("name", "string", "String"),
        country_id: field("country_id", "string", "String"),
      },
      { country: rel("country", "countries", "belongsTo", "country_id") },
    ),
    countries: resource("countries", {
      id: id(),
      tenant_id: tenant(),
      name: field("name", "string", "String"),
    }),
    refunds: resource("refunds", {
      id: id(),
      tenant_id: tenant(),
      order_item_id: field("order_item_id", "string", "String"),
      amount: field("amount", "number", "UInt32"),
    }),
    // No policy → deny-all: used to prove a join can't reach an unreadable table.
    vaults: resource("vaults", {
      id: id(),
      tenant_id: tenant(),
      secret: field("secret", "string", "String"),
    }),
  },
}

const ctx = memberCtx("acme")

// A valv tenant-scoped on every readable resource via the "*" wildcard; vaults is
// left denied. `configure` lets a test override a specific resource's policy.
async function setup(
  configure?: (valv: Awaited<ReturnType<typeof createValv<DefaultContext>>>) => void,
) {
  const client = fakeClient([{ customer_name: "Acme", revenue: 100 }])
  const valv = await createValv<DefaultContext>(client, { schema })
  valv.policy("*", (c) => ({ read: { tenant_id: c.tenant!.id } }))
  valv.policy("vaults", () => ({ read: false }))
  configure?.(valv)
  return { valv, calls: client.calls }
}

describe("joins — emit", () => {
  it("belongsTo: joins the dimension, qualifies columns, scopes BOTH tables", async () => {
    const { valv, calls } = await setup()
    await valv.runTool(
      "query",
      {
        from: "orders",
        select: [
          { col: "name", rel: ["customer"] },
          { fn: "sum", args: [{ kind: "col", name: "total" }], as: "revenue" },
        ],
        groupBy: [{ col: "name", rel: ["customer"] }],
      },
      ctx,
    )
    expect(calls[0].query).toBe(
      "SELECT `j_customer`.`name` AS `customer_name`, sum(`t0`.`total`) AS `revenue` " +
        "FROM `orders_t` AS `t0` " +
        "INNER JOIN `customers_t` AS `j_customer` ON `t0`.`customer_id` = `j_customer`.`id` " +
        "WHERE ((`t0`.`tenant_id` = {p0:String}) AND (`j_customer`.`tenant_id` = {p1:String})) " +
        "GROUP BY `j_customer`.`name` LIMIT 100",
    )
    expect(calls[0].query_params).toEqual({ p0: "acme", p1: "acme" })
  })

  it("hasMany: orients the ON the other way and scopes the joined table", async () => {
    const { valv, calls } = await setup()
    await valv.runTool(
      "query",
      {
        from: "customers",
        select: [
          { col: "name" },
          { fn: "count", args: [{ kind: "col", name: "id", rel: ["orders"] }], as: "order_count" },
        ],
        groupBy: [{ col: "name" }],
      },
      ctx,
    )
    expect(calls[0].query).toBe(
      "SELECT `t0`.`name`, count(`j_orders`.`id`) AS `order_count` " +
        "FROM `customers_t` AS `t0` " +
        "INNER JOIN `orders_t` AS `j_orders` ON `t0`.`id` = `j_orders`.`customer_id` " +
        "WHERE ((`t0`.`tenant_id` = {p0:String}) AND (`j_orders`.`tenant_id` = {p1:String})) " +
        "GROUP BY `t0`.`name` LIMIT 100",
    )
  })

  it("multi-hop: chains joins in depth order, each scoped", async () => {
    const { valv, calls } = await setup()
    await valv.runTool(
      "query",
      {
        from: "order_items",
        select: [
          { col: "name", rel: ["order", "customer"] },
          { fn: "sum", args: [{ kind: "col", name: "quantity" }], as: "units" },
        ],
        groupBy: [{ col: "name", rel: ["order", "customer"] }],
      },
      ctx,
    )
    const sql = calls[0].query
    expect(sql).toContain("FROM `order_items_t` AS `t0`")
    expect(sql).toContain("INNER JOIN `orders_t` AS `j_order` ON `t0`.`order_id` = `j_order`.`id`")
    expect(sql).toContain(
      "INNER JOIN `customers_t` AS `j_order__customer` ON `j_order`.`customer_id` = `j_order__customer`.`id`",
    )
    // The deepest table is selected under a path-derived alias.
    expect(sql).toContain("`j_order__customer`.`name` AS `order_customer_name`")
    // All three tables are tenant-scoped.
    expect(sql).toContain("`t0`.`tenant_id`")
    expect(sql).toContain("`j_order`.`tenant_id`")
    expect(sql).toContain("`j_order__customer`.`tenant_id`")
  })

  it("leaves single-table queries unqualified (back-compat)", async () => {
    const { valv, calls } = await setup()
    await valv.runTool("query", { from: "orders", select: [{ col: "total" }] }, ctx)
    expect(calls[0].query).toBe(
      "SELECT `total` FROM `orders_t` WHERE (`tenant_id` = {p0:String}) LIMIT 100",
    )
  })
})

describe("joins — policy composition (security)", () => {
  it("refuses a join to a denied resource", async () => {
    const { valv, calls } = await setup()
    await expect(
      valv.runTool("query", { from: "orders", select: [{ col: "secret", rel: ["vault"] }] }, ctx),
    ).rejects.toThrow(/denied|not accessible/)
    expect(calls).toHaveLength(0)
  })

  it("refuses a denied (sensitive) column on a join target", async () => {
    const { valv, calls } = await setup()
    await expect(
      valv.runTool(
        "query",
        { from: "orders", select: [{ col: "internal_notes", rel: ["customer"] }] },
        ctx,
      ),
    ).rejects.toThrow(/not accessible/)
    expect(calls).toHaveLength(0)
  })

  it("refuses a traversal the parent policy's relations toggle blocks", async () => {
    const { valv, calls } = await setup((valv) =>
      valv.policy("orders", (c) => ({
        read: { tenant_id: c.tenant!.id },
        relations: { customer: false },
      })),
    )
    await expect(
      valv.runTool("query", { from: "orders", select: [{ col: "name", rel: ["customer"] }] }, ctx),
    ).rejects.toThrow(/not accessible/)
    expect(calls).toHaveLength(0)
  })

  it("refuses an undeclared relation", async () => {
    const { valv } = await setup()
    await expect(
      valv.runTool("query", { from: "orders", select: [{ col: "x", rel: ["nope"] }] }, ctx),
    ).rejects.toThrow(/not accessible/)
  })

  it("refuses a join through a many-to-many relation (not supported yet)", async () => {
    const { valv, calls } = await setup()
    await expect(
      valv.runTool("query", { from: "customers", select: [{ col: "name", rel: ["peers"] }] }, ctx),
    ).rejects.toThrow(/many-to-many/)
    expect(calls).toHaveLength(0)
  })
})

describe("joins — limits", () => {
  it("rejects a path deeper than the max", async () => {
    const { valv } = await setup()
    await expect(
      valv.runTool(
        "query",
        {
          from: "order_items",
          select: [{ col: "name", rel: ["order", "customer", "region", "country"] }],
        },
        ctx,
      ),
    ).rejects.toThrow(/too deep/)
  })

  it("rejects joining too many tables", async () => {
    const { valv } = await setup()
    await expect(
      valv.runTool(
        "query",
        {
          from: "order_items",
          select: [
            { col: "id", rel: ["order"] },
            { col: "name", rel: ["order", "customer"] },
            { col: "id", rel: ["order", "items"] },
            { col: "name", rel: ["order", "customer", "region"] },
            { col: "id", rel: ["order", "customer", "orders"] },
          ],
        },
        ctx,
      ),
    ).rejects.toThrow(/too many tables/)
  })

  it("rejects too many one-to-many (fan-out) joins", async () => {
    const { valv } = await setup()
    await expect(
      valv.runTool(
        "query",
        {
          from: "customers",
          select: [
            { fn: "count", args: [{ kind: "col", name: "id", rel: ["orders"] }], as: "a" },
            { fn: "count", args: [{ kind: "col", name: "id", rel: ["orders", "items"] }], as: "b" },
            {
              fn: "count",
              args: [{ kind: "col", name: "id", rel: ["orders", "items", "refunds"] }],
              as: "c",
            },
          ],
        },
        ctx,
      ),
    ).rejects.toThrow(/too many one-to-many/)
  })
})
