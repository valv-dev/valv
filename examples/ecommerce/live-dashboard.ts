import "dotenv/config"
import { OrderStatus } from "@prisma/client"
import { deriveView } from "@valv/core"
import type { DefaultContext, ViewResult } from "@valv/core"
import { prisma, valv } from "./valv"

// Live dashboard demo for valv views.
//
// The agent builds a query once (a regular tool call); the app captures it with
// valv.view() and from then on owns it — typed via resultSchema, re-executed
// through the same policy pipeline, and kept live with subscribe() — no LLM in
// the loop anymore.
//
//   1. The agent picks the query (or a canned tool call when no API key is set).
//   2. valv.view() turns the tool call into a policy-enforced handle.
//   3. deriveView() reshapes the rows into the chart series (group by status,
//      sum revenue, sort) — a declarative, schema-validated spec.
//   4. subscribe() polls + diffs — the chart re-renders only when the series
//      changed. (Each poll shows up in the [audit] log: views run through onQuery too.)
//   5. A background writer inserts orders directly via Prisma, simulating other
//      traffic — watch the chart move.
//
// Run with: npm run dashboard   (requires the seeded Postgres from the README)

const ctx: DefaultContext = {
  user: { id: "user-alice", role: "admin" },
  tenant: { id: "tenant-alpha" },
}

// Developer-asserted row type; view.resultSchema is the runtime source of truth.
interface OrderRow {
  id: string
  status: string
  total: number // Decimal in the DB — serialized to number by the view
  created_at: string
}

const CANNED_CALL = { toolName: "query_order", args: { limit: 100 } }

async function captureAgentQuery(): Promise<{ toolName: string; args: unknown }> {
  if (!process.env.OPENROUTER_API_KEY) {
    console.log("No OPENROUTER_API_KEY set — skipping the agent, using a canned tool call.")
    return CANNED_CALL
  }

  const { createOpenRouter } = await import("@openrouter/ai-sdk-provider")
  const { generateText } = await import("ai")
  const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY! })

  console.log("Asking the agent to build the query…")
  const captured: { toolName: string; args: unknown }[] = []
  await generateText({
    model: openrouter("openrouter/owl-alpha"),
    tools: await valv.tools.vercel(ctx),
    maxSteps: 3,
    prompt:
      "I want to chart revenue by order status. Fetch up to 100 orders with their status and total.",
    onStepFinish({ toolCalls }) {
      for (const c of toolCalls) captured.push({ toolName: c.toolName, args: c.args })
    },
  })

  // Any read tool call works as a view; grab the agent's order query.
  return captured.find((c) => c.toolName.startsWith("query_")) ?? CANNED_CALL
}

interface SeriesRow {
  status: string
  revenue: number
  orders: number
}

function renderChart(result: ViewResult<SeriesRow>, update: number): void {
  const max = Math.max(...result.data.map((r) => r.revenue), 1)
  console.log(`\n  Revenue by status — update #${update}`)
  for (const { status, revenue, orders } of result.data) {
    const bar = "█".repeat(Math.max(1, Math.round((revenue / max) * 36)))
    console.log(
      `  ${status.padEnd(11)} ${bar.padEnd(37)} $${(revenue / 100).toFixed(2)} (${orders})`,
    )
  }
}

async function main(): Promise<void> {
  const { toolName, args } = await captureAgentQuery()
  console.log(`\nCaptured tool call: ${toolName}(${JSON.stringify(args)})`)

  // From here on the LLM is out of the loop: the view re-runs the captured
  // query through the full policy pipeline (tenant filter, field rules) on
  // every execution.
  const view = await valv.view<OrderRow>(toolName, args, ctx)

  // Declaratively reshape the rows into the chart series. The spec is plain
  // data validated against the view's schema — an agent could emit it too.
  const series = deriveView<OrderRow, SeriesRow>(view, {
    groupBy: ["status"],
    aggregations: [
      { alias: "revenue", fn: "sum", field: "total" },
      { alias: "orders", fn: "count" },
    ],
    sort: { field: "revenue", direction: "desc" },
  })

  console.log("\nDerived series schema — drive your chart config from this:")
  console.log(JSON.stringify(series.resultSchema, null, 2))

  let update = 0
  const sub = series.subscribe((result) => renderChart(result, ++update), {
    intervalMs: 1000,
    onError: (e) => console.error(`  [view] ${e.message}`),
  })

  // Simulate other traffic writing to the database.
  const statuses = [
    OrderStatus.pending,
    OrderStatus.processing,
    OrderStatus.shipped,
    OrderStatus.delivered,
  ]
  const demoIds: string[] = []
  const writer = setInterval(() => {
    const id = `demo-live-${Date.now()}`
    const status = statuses[Math.floor(Math.random() * statuses.length)]
    const total = 1000 + Math.floor(Math.random() * 90000)
    demoIds.push(id)
    prisma.order
      .create({ data: { id, status, total, tenant_id: "tenant-alpha", user_id: "user-alice" } })
      .then(() => console.log(`\n  [writer] new ${status} order for $${(total / 100).toFixed(2)}`))
      .catch((e) => console.error(`  [writer] ${e.message}`))
  }, 2500)

  // Let the dashboard run for a few updates, then clean up after ourselves.
  await new Promise((r) => setTimeout(r, 11_000))
  clearInterval(writer)
  sub.stop()
  await prisma.order.deleteMany({ where: { id: { in: demoIds } } })
  await prisma.$disconnect()
  console.log("\nDone — demo orders removed, database back to its seeded state.")
}

main().catch(async (err) => {
  console.error(err)
  await prisma.$disconnect()
  process.exit(1)
})
