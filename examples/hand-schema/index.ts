/*
 * Hand-defined ClickHouse schema — no introspection, no live database.
 *
 * You declare the tables you know; valv validates the model's query against
 * them, injects the tenant filter, and emits ClickHouse SQL. The "client" here
 * is a stub that just prints the SQL valv produced, so this runs with no DB.
 *
 *   npm start    (from this folder)
 */
import { createValv, type ClickHouseClient } from "@valv/clickhouse"
import type { SchemaMap, DefaultContext } from "@valv/core"

// ── 1. The schema you hand-define ─────────────────────────────────────────────

const schema: SchemaMap = {
  resources: {
    events: {
      name: "events",
      tableName: "events",
      // A relation you can declare by hand — ClickHouse can't introspect it.
      relations: {
        user: { name: "user", targetResource: "users", type: "belongsTo", foreignKey: "user_id" },
      },
      fields: {
        tenant_id: { name: "tenant_id", type: "string", nativeType: "String", isNullable: false, isId: false, isPrimaryKeyPart: true },
        user_id: { name: "user_id", type: "uuid", nativeType: "UUID", isNullable: false, isId: false },
        event_type: { name: "event_type", type: "string", nativeType: "String", isNullable: false, isId: false },
        latency_ms: { name: "latency_ms", type: "number", nativeType: "UInt32", isNullable: false, isId: false },
        created_at: { name: "created_at", type: "date", nativeType: "DateTime", isNullable: false, isId: false, isPrimaryKeyPart: true },
      },
    },
    users: {
      name: "users",
      tableName: "users",
      relations: {},
      fields: {
        tenant_id: { name: "tenant_id", type: "string", nativeType: "String", isNullable: false, isId: false },
        id: { name: "id", type: "uuid", nativeType: "UUID", isNullable: false, isId: true },
        email: { name: "email", type: "string", nativeType: "String", isNullable: false, isId: false },
        password_hash: { name: "password_hash", type: "string", nativeType: "String", isNullable: false, isId: false, sensitive: true },
        plan: { name: "plan", type: "string", nativeType: "String", isNullable: false, isId: false },
      },
    },
  },
}

// ── 2. A stub client that prints the SQL valv emits (no real ClickHouse) ───────

const client: ClickHouseClient = {
  async query({ query, query_params }) {
    console.log("    SQL    →", query)
    console.log("    params →", query_params ?? {})
    return { json: async () => [{ event_type: "checkout", p95_ms: 1240 }] }
  },
}

// Who's asking — the trusted context the tenant filter is resolved from.
const ctx: DefaultContext = { user: { id: "u_1", role: "member" }, tenant: { id: "acme" } }

async function main() {
  // ── 3. Build valv on the hand-defined schema + policies ─────────────────────
  const valv = await createValv<DefaultContext>(client, { schema, database: "analytics" })
  valv.policy("events", (ctx) => ({ read: { tenant_id: ctx.tenant!.id } }))
  valv.policy("users", (ctx) => ({ read: { tenant_id: ctx.tenant!.id } }))

  const run = async (label: string, query: object) => {
    console.log(`\n▶ ${label}`)
    try {
      const rows = await valv.run(query, ctx)
      console.log("    rows   →", rows)
    } catch (e) {
      console.log("    ✗ rejected →", (e as Error).message)
    }
  }

  // ── 4. Run queries (the model would emit these) ─────────────────────────────

  await run("slow events (watch the tenant filter get injected)", {
    from: "events",
    select: { event_type: true, latency_ms: true },
    where: { latency_ms: { gt: 500 } },
    take: 10,
  })

  await run("reading a sensitive column is rejected", {
    from: "users",
    select: { email: true, password_hash: true },
  })

  // p95 latency per event type — an aggregate over a computed percentile.
  const dashboard = {
    from: "events",
    select: {
      event_type: true,
      p95_ms: { quantileTiming: [0.95, "latency_ms"] },
    },
    groupBy: ["event_type"],
    orderBy: { p95_ms: "desc" },
  }
  await run("p95 latency per event type (group + order by the aggregate)", dashboard)

  // The output shape of that query, without running it — drives a dashboard.
  console.log("\n▶ result schema (no execution)")
  console.log("    columns →", valv.resultSchema(dashboard))
}

main()
