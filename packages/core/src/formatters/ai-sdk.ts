import type { NeutralTool } from "./index"

// A Vercel AI SDK tool set, ready to pass straight to `generateText({ tools })`.
// Each tool keeps its `execute`, so the SDK runs it directly — no manual
// dispatch. The `ai` package is an optional peer dependency, imported only here
// and only when this is called (so installing @valv/core never pulls it in).
export async function toAiSdk(tools: NeutralTool[]): Promise<import("ai").ToolSet> {
  let ai: typeof import("ai")
  try {
    ai = await import("ai")
  } catch {
    throw new Error(
      '[valv] tools.aisdk requires the optional "ai" package. Install it with `npm i ai`.',
    )
  }

  const { tool, jsonSchema } = ai
  const out: import("ai").ToolSet = {}
  for (const t of tools) {
    out[t.name] = tool({
      description: t.description,
      inputSchema: jsonSchema(t.parameters as Parameters<typeof jsonSchema>[0]),
      execute: (input: unknown) => t.execute(input),
    })
  }
  return out
}
