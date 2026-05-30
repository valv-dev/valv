import "dotenv/config"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { generateText, jsonSchema, tool } from "ai"
import { PrismaClient } from "@prisma/client"
import { ORMAI, PrismaAdapter } from "ormai"
import type { DefaultContext, InferResources } from "ormai"

// ── Setup ─────────────────────────────────────────────────────────────────────

const prisma = new PrismaClient()
const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY! })

// InferResources derives resource names from the Prisma client type automatically.
// policy() keys and getTools() options are now type-safe with autocomplete.
const ormai = new ORMAI<DefaultContext, InferResources<typeof prisma>>({
  adapter: new PrismaAdapter(prisma, "./prisma/schema.prisma"),
  defaultPolicy: "deny-all",
  onQuery: ({ toolName, resource, durationMs, error }) => {
    if (error) console.warn(`  [audit] ${toolName} on ${resource} failed in ${durationMs}ms: ${error.message}`)
    else       console.log (`  [audit] ${toolName} on ${resource} (${durationMs}ms)`)
  },
})

// ── Policies ──────────────────────────────────────────────────────────────────
// Resource names come from toResourceName(): PascalCase → singular snake_case
// Order → "order", User → "user", Product → "product", OrderItem → "order_item"

ormai.policy("order", (ctx) => ({
  read: { tenant_id: ctx.tenant!.id },
  write: { tenant_id: ctx.tenant!.id },  // forces tenant_id into creates/updates
  delete: false,
  fields: {
    // internal_notes is @ormai:sensitive — auto-excluded from LLM
    deny: ctx.user.role === "support" ? ["user_id"] : [],
  },
  relations: {
    customer: ctx.user.role === "admin",
    items: true,
  },
}))

ormai.policy("user", (ctx) => ({
  read: { tenant_id: ctx.tenant!.id },
  // password_hash is @ormai:sensitive — always excluded
  fields: { deny: ctx.user.role === "support" ? ["email"] : [] },
  write: false,
  delete: false,
}))

ormai.policy("product", (ctx) => ({
  read: { tenant_id: ctx.tenant!.id },
  write: { tenant_id: ctx.tenant!.id },
  delete: false,
}))

// OrderItem: no standalone tools — only reachable via order.items include
ormai.policy("order_item", () => ({ read: false }))

// ── Agentic loop ──────────────────────────────────────────────────────────────

async function runAgentDemo(ctx: DefaultContext, userPrompt: string, label: string): Promise<void> {
  console.log(`\n${"=".repeat(64)}`)
  console.log(`DEMO: ${label}`)
  console.log(`Prompt: "${userPrompt}"`)
  console.log("=".repeat(64))

  // executableTools auto-loads schema, attaches execute(), and handles serialization
  const execTools = await ormai.executableTools(ctx)
  console.log(`\nTools available to LLM (${execTools.length}): ${execTools.map(t => t.name).join(", ")}`)

  // Convert to Vercel AI SDK tool format
  const tools = Object.fromEntries(
    execTools.map(t => [
      t.name,
      tool({
        description: t.description,
        parameters: jsonSchema(t.input_schema as Parameters<typeof jsonSchema>[0]),
        execute: async (args) => {
          try { return await t.execute(args) }
          catch (err) { return { error: (err as Error).message } }
        },
      }),
    ])
  )

  const { text } = await generateText({
    model: openrouter("openrouter/owl-alpha"),
    tools,
    maxSteps: 5,
    prompt: userPrompt,
    onStepFinish({ toolCalls, toolResults }) {
      for (const call of toolCalls) {
        console.log(`\n  → ${call.toolName}(${JSON.stringify(call.args)})`)
        const result = toolResults.find(r => r.toolCallId === call.toolCallId)
        if (result) console.log(`    ${JSON.stringify(result.result)}`)
      }
    },
  })

  console.log(`\nAI:\n${text}`)
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const prompt = "Give me a summary of all orders. For each delivered order, show me the items purchased."

  await runAgentDemo(
    { user: { id: "user-alice", role: "admin" }, tenant: { id: "tenant-alpha" } },
    prompt,
    "Admin (alice @ tenant-alpha) — full access"
  )

  await runAgentDemo(
    { user: { id: "user-bob", role: "support" }, tenant: { id: "tenant-alpha" } },
    prompt,
    "Support (bob @ tenant-alpha) — restricted access"
  )

  await runAgentDemo(
    { user: { id: "user-carol", role: "admin" }, tenant: { id: "tenant-beta" } },
    prompt,
    "Admin (carol @ tenant-beta) — cross-tenant isolation"
  )

  await prisma.$disconnect()
}

function safeLog(label: string, err: unknown): void {
  if (err instanceof Error) {
    console.error(`${label}: ${err.message}`)
    if (err.stack) console.error(err.stack)
    const cause = (err as NodeJS.ErrnoException & { cause?: unknown }).cause
    if (cause instanceof Error) console.error(`Caused by: ${cause.message}`)
  } else {
    try {
      console.error(label, JSON.stringify(err, null, 2))
    } catch {
      console.error(label, String(err))
    }
  }
}

process.on("uncaughtException", (err) => {
  safeLog("Uncaught exception", err)
  process.exit(1)
})

process.on("unhandledRejection", (reason) => {
  safeLog("Unhandled rejection", reason)
  process.exit(1)
})

main().catch(err => {
  safeLog("Fatal error", err)
  prisma.$disconnect()
  process.exit(1)
})
