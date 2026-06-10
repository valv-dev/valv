import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import type { Vistal } from "@vistal/core"
import { createMcpServer } from "./server.js"
import type { VistalMcpOptions } from "./types.js"

/**
 * Start a vistal MCP server over stdio — the transport Claude Code (and most
 * local MCP clients) launch. Register the entry script in your client config:
 *
 * ```json
 * { "mcpServers": { "vistal": { "command": "npx", "args": ["tsx", "mcp.ts"] } } }
 * ```
 */
export async function startStdioServer<TContext, TResources extends string = string>(
  vistal: Vistal<TContext, TResources>,
  options: VistalMcpOptions<TContext>,
): Promise<Server> {
  const server = createMcpServer(vistal, options)
  await server.connect(new StdioServerTransport())
  return server
}
