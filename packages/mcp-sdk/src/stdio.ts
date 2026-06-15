import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import type { Valv } from "@valv/core"
import { createMcpServer } from "./server.js"
import type { ValvMcpOptions } from "./types.js"

/**
 * Start a valv MCP server over stdio — the transport Claude Code (and most
 * local MCP clients) launch. Register the entry script in your client config:
 *
 * ```json
 * { "mcpServers": { "valv": { "command": "npx", "args": ["tsx", "mcp.ts"] } } }
 * ```
 */
export async function startStdioServer<TContext, TResources extends string = string>(
  valv: Valv<TContext, TResources>,
  options: ValvMcpOptions<TContext>,
): Promise<Server> {
  const server = createMcpServer(valv, options)
  await server.connect(new StdioServerTransport())
  return server
}
