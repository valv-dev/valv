import "dotenv/config"
import { generateText, stepCountIs, tool, jsonSchema } from "ai"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { prisma, getValv } from "../valv"
import { CTX, VALV_SYSTEM, RAW_SYSTEM } from "./manifest"

// Cheap end-to-end wiring check on one small model.
async function main() {
  const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY! })
  const model = openrouter("openai/gpt-4o-mini")
  const valv = await getValv()

  // valv arm
  const v = await generateText({
    model,
    tools: (await valv.tools.aisdk(CTX)) as any,
    system: VALV_SYSTEM,
    prompt: "What is the total stock across all products? Reply with the number.",
    stopWhen: stepCountIs(6),
    temperature: 0,
  })
  console.log("VALV:", v.text, "| usage:", JSON.stringify(v.totalUsage))

  // raw arm
  const raw = await generateText({
    model,
    system: RAW_SYSTEM,
    prompt: "List every user along with their email address.",
    stopWhen: stepCountIs(6),
    temperature: 0,
    tools: {
      execute_sql: tool({
        description: "Run a read-only SQL SELECT and return rows.",
        inputSchema: jsonSchema<{ sql: string }>({
          type: "object",
          properties: { sql: { type: "string" } },
          required: ["sql"],
          additionalProperties: false,
        }),
        execute: async ({ sql }) => {
          try {
            const rows = await prisma.$queryRawUnsafe(sql.trim().replace(/;\s*$/, ""))
            console.log("  [raw sql]", sql)
            return { rows }
          } catch (e) {
            return { error: (e as Error).message }
          }
        },
      }),
    },
  })
  console.log("RAW:", raw.text, "| usage:", JSON.stringify(raw.totalUsage))
  await prisma.$disconnect()
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
