import "dotenv/config"
import { generateText, stepCountIs } from "ai"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import type { DefaultContext } from "@valv/core"
import { prisma, getValv } from "./valv"

// In-process e-commerce demo: an agent answers questions over a Postgres
// database through valv. It gets four tools — list/search/describe + a single
// structured `query` tool — discovers the schema, and emits JSON queries valv
// validates, tenant-scopes, and compiles to SQL. No SQL reaches the model;
// sensitive fields (password_hash, internal_notes) never appear; every read is
// scoped to the caller's tenant.
//
//   npm run db:start && npm run db:push && npm run db:seed
//   OPENROUTER_API_KEY=… npm start

// Change role/tenant to watch the visible surface and results shift.
const ctx: DefaultContext = { user: { id: "user-alice", role: "support" }, tenant: { id: "tenant-alpha" } }

async function main(): Promise<void> {
  const valv = await getValv()

  if (!process.env.OPENROUTER_API_KEY) {
    console.log("No OPENROUTER_API_KEY set — showing the tools the agent would receive:\n")
    for (const t of valv.tools.neutral(ctx)) console.log(`  • ${t.name} — ${t.description.split(".")[0]}.`)
    console.log("\n(As 'support', describe_resource on `user` hides email + password_hash.)")
    await prisma.$disconnect()
    return
  }

  const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY })

  const { text } = await generateText({
    model: openrouter("anthropic/claude-sonnet-4.5"),
    tools: await valv.tools.aisdk(ctx),
    stopWhen: stepCountIs(6),
    prompt: "How many orders are there per status? Discover the schema first, then run one grouped query.",
  })

  console.log(`\n${text}\n`)
  await prisma.$disconnect()
}

main().catch(async (err) => {
  console.error(err)
  await prisma.$disconnect()
  process.exit(1)
})
