import "dotenv/config"
import { createClient } from "@clickhouse/client"
import { createValv } from "@valv/clickhouse"
import type { DefaultContext } from "@valv/core"
import { generateText, stepCountIs } from "ai"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"

// LLM-driven analytics over ClickHouse, gated by valv.
//
// The agent gets four tools — list/search/describe + a single structured `query`
// tool. It discovers the schema, then emits a JSON query that valv validates,
// tenant-scopes, compiles to ClickHouse SQL, and runs. No SQL ever reaches the
// model, sensitive fields are stripped, and every read is tenant-filtered.
//
//   1. npm run seed     (creates + fills the analytics tables)
//   2. npm start        (set OPENROUTER_API_KEY to run the agent)

const ch = createClient({
  url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
  database: process.env.CLICKHOUSE_DATABASE ?? "analytics",
  username: process.env.CLICKHOUSE_USER ?? "default",
  password: process.env.CLICKHOUSE_PASSWORD ?? "",
})

// Who's asking — the trusted context every policy resolves against.
const ctx: DefaultContext = { user: { id: "u_1", role: "analyst" }, tenant: { id: "tenant-alpha" } }

async function main(): Promise<void> {
  // Introspect the live database, then gate each resource.
  const valv = await createValv<DefaultContext>(ch, {
    schema: "introspect",
    database: process.env.CLICKHOUSE_DATABASE ?? "analytics",
    defaultPolicy: "deny-all",
    onQuery: ({ resource, durationMs, error }) =>
      console.log(`  [audit] query on ${resource} (${durationMs}ms)${error ? ` — ${error.message}` : ""}`),
  })

  // Tenant-scope reads; hide sensitive columns. (ClickHouse has no schema-level
  // sensitivity, so name them here.)
  valv.policy("orders", (c) => ({ read: { tenant_id: c.tenant!.id }, fields: { deny: ["internal_notes"] } }))
  valv.policy("users", (c) => ({ read: { tenant_id: c.tenant!.id }, fields: { deny: ["password_hash"] } }))
  valv.policy("events", (c) => ({ read: { tenant_id: c.tenant!.id } }))

  if (!process.env.OPENROUTER_API_KEY) {
    console.log("No OPENROUTER_API_KEY set — skipping the agent.\n")
    console.log("Tools the agent would receive:")
    for (const t of valv.tools.neutral(ctx)) console.log(`  • ${t.name}`)
    await ch.close()
    return
  }

  const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY })

  const { text } = await generateText({
    model: openrouter("anthropic/claude-sonnet-4.5"),
    tools: await valv.tools.aisdk(ctx),
    stopWhen: stepCountIs(6),
    prompt:
      "What are the top 5 customers by total order value? " +
      "Discover the schema first, then run a single grouped query.",
  })

  console.log(`\n${text}\n`)
  await ch.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
