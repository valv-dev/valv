import { describe, it, expect } from "vitest"
import path from "node:path"
import { PrismaAdapter } from "@valv/prisma"
import type { PrismaClient } from "@prisma/client"
import type { SchemaMap, Query, FieldSchema } from "@valv/core"
import { introspectPrisma } from "../packages/prisma/src/introspection"

const f = (name: string, extra: Partial<FieldSchema> = {}): FieldSchema => ({
  name,
  type: "string",
  nativeType: "String",
  isNullable: false,
  isId: false,
  ...extra,
})

const schema: SchemaMap = {
  resources: {
    orders: {
      name: "orders",
      tableName: "Order",
      fields: {
        id: f("id", { isId: true }),
        user_id: f("user_id"),
        total: f("total", { type: "number", nativeType: "Int" }),
      },
      relations: {
        customer: {
          name: "customer",
          targetResource: "customers",
          type: "belongsTo",
          foreignKey: "user_id",
          targetKey: "id",
        },
      },
    },
    customers: {
      name: "customers",
      tableName: "User",
      fields: { id: f("id", { isId: true }), name: f("name") },
      relations: {
        orders: {
          name: "orders",
          targetResource: "orders",
          type: "hasMany",
          foreignKey: "user_id",
          targetKey: "id",
        },
      },
    },
  },
}

const stub = {} as PrismaClient

describe("prisma adapter — join emission (shared emitter, per dialect)", () => {
  const joinQuery: Query = {
    from: "orders",
    select: [
      { col: "name", rel: ["customer"] },
      { fn: "sum", args: [{ kind: "col", name: "total" }], as: "revenue" },
    ],
    groupBy: [{ col: "name", rel: ["customer"] }],
    limit: 50,
  }

  it("emits a Postgres INNER JOIN with qualified columns", () => {
    const adapter = new PrismaAdapter(stub, { provider: "postgresql" })
    const compiled = adapter.compile(joinQuery, schema)
    expect(compiled.sql).toBe(
      'SELECT "j_customer"."name" AS "customer_name", sum("t0"."total") AS "revenue" ' +
        'FROM "Order" AS "t0" ' +
        'INNER JOIN "User" AS "j_customer" ON "t0"."user_id" = "j_customer"."id" ' +
        'GROUP BY "j_customer"."name" LIMIT 50',
    )
  })

  it("emits a MySQL INNER JOIN with backtick quoting", () => {
    const adapter = new PrismaAdapter(stub, { provider: "mysql" })
    const compiled = adapter.compile(joinQuery, schema)
    expect(compiled.sql).toContain(
      "INNER JOIN `User` AS `j_customer` ON `t0`.`user_id` = `j_customer`.`id`",
    )
  })

  it("orients a hasMany join the other way", () => {
    const adapter = new PrismaAdapter(stub, { provider: "postgresql" })
    const compiled = adapter.compile(
      {
        from: "customers",
        select: [
          { col: "name" },
          { fn: "count", args: [{ kind: "col", name: "id", rel: ["orders"] }], as: "n" },
        ],
        groupBy: [{ col: "name" }],
      },
      schema,
    )
    expect(compiled.sql).toContain(
      'INNER JOIN "Order" AS "j_orders" ON "t0"."id" = "j_orders"."user_id"',
    )
  })
})

describe("prisma introspection — relation join keys", () => {
  // vitest runs from the repo root.
  const schemaPath = path.resolve(process.cwd(), "examples/ecommerce/prisma/schema.prisma")

  it("captures targetKey for a belongsTo and resolves the inverse FK for a hasMany", async () => {
    const map = await introspectPrisma(schemaPath)

    // Order.customer → User: FK local, references User.id.
    const customer = map.resources.order.relations.customer
    expect(customer).toMatchObject({
      targetResource: "user",
      type: "belongsTo",
      foreignKey: "user_id",
      targetKey: "id",
    })

    // User.orders → Order[]: FK lives on Order (user_id), resolved from the inverse.
    const orders = map.resources.user.relations.orders
    expect(orders).toMatchObject({
      targetResource: "order",
      type: "hasMany",
      foreignKey: "user_id",
      targetKey: "id",
    })
  })

  it("types an implicit many-to-many as manyToMany (not a broken hasMany)", async () => {
    const map = await introspectPrisma(path.resolve(process.cwd(), "tests/fixtures/m2m.prisma"))
    expect(map.resources.post.relations.tags).toMatchObject({
      targetResource: "tag",
      type: "manyToMany",
    })
    expect(map.resources.tag.relations.posts).toMatchObject({
      targetResource: "post",
      type: "manyToMany",
    })
  })
})
