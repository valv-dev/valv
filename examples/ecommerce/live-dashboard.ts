import "dotenv/config"
import type { DefaultContext } from "@valv/core"
import { prisma, getValv } from "./valv"

// Live dashboard via a *saved query*.
//
// The agent builds a query once (a normal tool call); the app stores the query
// object and from then on owns it — no LLM in the loop. Every refresh replays it
// through `valv.run`, so the tenant filter and field rules are re-applied live on
// the current context. `valv.resultSchema` gives the column shape up front to
// drive rendering.
//
//   npm run db:start && npm run db:push && npm run db:seed && npm run dashboard

const ctx: DefaultContext = { user: { id: "user-alice", role: "admin" }, tenant: { id: "tenant-alpha" } }

// The query an agent would emit for "revenue by order status". Stored as plain
// data — re-run forever, re-scoped every time.
const dashboardQuery = {
  from: "order",
  select: {
    status: true,
    orders: { count: true },
    revenue: { sum: "total" },
  },
  groupBy: ["status"],
  orderBy: { revenue: "desc" },
}

interface SeriesRow {
  status: string
  orders: number
  revenue: number
}

function render(rows: SeriesRow[], update: number): void {
  const max = Math.max(...rows.map((r) => Number(r.revenue)), 1)
  console.log(`\n  Revenue by status — update #${update}`)
  for (const { status, revenue, orders } of rows) {
    const bar = "█".repeat(Math.max(1, Math.round((Number(revenue) / max) * 36)))
    console.log(`  ${status.padEnd(11)} ${bar.padEnd(37)} $${(Number(revenue) / 100).toFixed(2)} (${orders})`)
  }
}

async function main(): Promise<void> {
  const valv = await getValv()

  // The output shape, derived from the query without running it — your chart
  // config can key off this and detect drift if the schema changes.
  console.log("Result schema:", valv.resultSchema(dashboardQuery))

  let update = 0
  const tick = async () => {
    try {
      const rows = (await valv.run(dashboardQuery, ctx)) as SeriesRow[]
      render(rows, ++update)
    } catch (e) {
      console.error(`  [dashboard] ${(e as Error).message}`)
    }
  }

  // Simulate other traffic writing to the database between refreshes.
  const statuses = ["pending", "shipped", "delivered", "cancelled"]
  const writer = setInterval(async () => {
    await prisma.order
      .create({
        data: {
          tenant_id: "tenant-alpha",
          user_id: "user-alice",
          status: statuses[update % statuses.length] as never,
          total: Math.floor(Math.random() * 20000),
        },
      })
      .catch(() => {})
  }, 1500)

  const poll = setInterval(tick, 1000)
  await tick()

  // Stop after a short demo run.
  setTimeout(async () => {
    clearInterval(poll)
    clearInterval(writer)
    await prisma.$disconnect()
    process.exit(0)
  }, 12000)
}

main().catch(async (err) => {
  console.error(err)
  await prisma.$disconnect()
  process.exit(1)
})
