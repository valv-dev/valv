import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { Valv, serializeResult, ValidationError, PolicyViolationError } from "@valv/core"
import type { GetToolsOptions } from "@valv/core"
import type { ContextResolver, ValvMcpOptions } from "./types.js"

const DEFAULT_VERSION = "0.1.0"

async function resolve<TContext>(context: ContextResolver<TContext>): Promise<TContext> {
  return typeof context === "function"
    ? await (context as () => TContext | Promise<TContext>)()
    : context
}

// Mirrors the private guard in @valv/core: valv's own errors are
// author-written and safe to surface (the agent can act on them), but any other
// error (e.g. a raw driver error) may carry internal details — file paths, query
// dumps — so it is replaced with a generic message.
function safeErrorMessage(err: unknown): string {
  if (err instanceof ValidationError || err instanceof PolicyViolationError) {
    return err.message
  }
  return "The query could not be completed due to an internal error."
}

/**
 * Build an MCP {@link Server} that fronts a configured {@link Valv} instance.
 * Tool definitions and execution both run through valv's public API, so every
 * call is policy-gated exactly as it would be in-process — no SQL reaches the
 * agent, sensitive fields stay hidden, and row/field policies are enforced.
 *
 * The returned server is transport-agnostic; connect it with
 * {@link startStdioServer} or {@link startHttpServer}.
 */
export function createMcpServer<TContext, TResources extends string = string>(
  valv: Valv<TContext, TResources>,
  options: ValvMcpOptions<TContext>,
): Server {
  const mode = options.mode ?? "consolidated"

  const server = new Server(options.serverInfo ?? { name: "valv", version: DEFAULT_VERSION }, {
    capabilities: { tools: {} },
  })

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const ctx = await resolve(options.context)
    const getToolsOptions = { ...options.toolOptions, mode } as GetToolsOptions<TResources>
    const tools = await valv.getTools(ctx, getToolsOptions)
    return {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.input_schema as { type: "object"; [k: string]: unknown },
      })),
    }
  })

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const ctx = await resolve(options.context)
    const { name, arguments: args } = req.params
    try {
      const result = await valv.executeTool(name, args ?? {}, ctx)
      return {
        content: [{ type: "text" as const, text: JSON.stringify(serializeResult(result)) }],
      }
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: safeErrorMessage(err) }],
        isError: true,
      }
    }
  })

  return server
}
