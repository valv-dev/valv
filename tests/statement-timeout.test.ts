import { describe, it, expect } from "vitest"
import { createValv } from "@valv/clickhouse"
import { MySqlAdapter, type MySqlClient } from "@valv/mysql"
import { PostgresAdapter, type PostgresSql } from "@valv/postgres"
import type { SchemaMap, DefaultContext } from "@valv/core"
import { fakeClient, field } from "./helpers"

const schema: SchemaMap = {
  resources: {
    events: {
      name: "events",
      tableName: "events",
      relations: {},
      fields: {
        tenant_id: field("tenant_id", "string", "String"),
        plan: field("plan", "string", "String"),
      },
    },
  },
}
const ctx: DefaultContext = { user: { id: "u", role: "m" }, tenant: { id: "acme" } }

describe("statementTimeoutMs — configurable per adapter", () => {
  it("ClickHouse defaults to 30s and honors an override (converted to seconds)", async () => {
    const def = fakeClient([])
    await (
      await createValv<DefaultContext>(def, { schema, defaultPolicy: "allow-all" })
    ).runTool("query", { from: "events", select: { plan: true } }, ctx)
    expect(def.calls[0].clickhouse_settings).toMatchObject({ max_execution_time: 30 })

    const custom = fakeClient([])
    await (
      await createValv<DefaultContext>(custom, {
        schema,
        defaultPolicy: "allow-all",
        statementTimeoutMs: 60_000,
      })
    ).runTool("query", { from: "events", select: { plan: true } }, ctx)
    expect(custom.calls[0].clickhouse_settings).toMatchObject({ max_execution_time: 60 })
  })

  it("MySQL defaults to 10000ms and honors an override", async () => {
    const calls: string[] = []
    const client = {
      async query(sql: string) {
        calls.push(sql)
        return [[]]
      },
    } as unknown as MySqlClient

    await new MySqlAdapter(client, { schema }).execute("SELECT 1", [])
    expect(calls.find((s) => s.includes("max_execution_time"))).toContain("= 10000")

    calls.length = 0
    await new MySqlAdapter(client, { schema, statementTimeoutMs: 25_000 }).execute("SELECT 1", [])
    expect(calls.find((s) => s.includes("max_execution_time"))).toContain("= 25000")
  })

  it("Postgres defaults to 10000ms and honors an override", async () => {
    const calls: string[] = []
    const sql = {
      begin: (cb: (tx: { unsafe: (s: string) => Promise<unknown[]> }) => unknown) =>
        cb({
          unsafe: async (s: string) => {
            calls.push(s)
            return []
          },
        }),
    } as unknown as PostgresSql

    await new PostgresAdapter(sql, { schema }).execute("SELECT 1", [])
    expect(calls).toContain("SET LOCAL statement_timeout = 10000")

    calls.length = 0
    await new PostgresAdapter(sql, { schema, statementTimeoutMs: 45_000 }).execute("SELECT 1", [])
    expect(calls).toContain("SET LOCAL statement_timeout = 45000")
  })
})
