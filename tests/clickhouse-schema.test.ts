import { describe, it, expect } from "vitest"
import { ClickHouseAdapter, type ClickHouseClient } from "@valv/clickhouse"
import type { SchemaMap } from "@valv/core"

// A client that fails if it's queried — proves the hand-defined path never
// touches system.* tables.
const throwingClient: ClickHouseClient = {
  query() {
    throw new Error("introspect() must not query the database when a schema is provided")
  },
}

const schema: SchemaMap = {
  resources: {
    events: {
      name: "events",
      tableName: "events",
      relations: {},
      fields: {
        id: { name: "id", type: "uuid", nativeType: "UUID", isNullable: false, isId: true },
        latency: { name: "latency", type: "number", nativeType: "UInt32", isNullable: false },
      },
    },
  },
}

describe("clickhouse hand-defined schema", () => {
  it("returns the provided schema without querying the database", async () => {
    const adapter = new ClickHouseAdapter(throwingClient, { schema })
    await expect(adapter.introspect()).resolves.toBe(schema)
  })

  it("falls back to introspection when no schema is given", async () => {
    let queried = false
    const client: ClickHouseClient = {
      async query() {
        queried = true
        return { json: async () => [] }
      },
    }
    const adapter = new ClickHouseAdapter(client, { database: "test" })
    await adapter.introspect()
    expect(queried).toBe(true)
  })
})
