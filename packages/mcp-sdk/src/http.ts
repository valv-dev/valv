import type { IncomingMessage, ServerResponse } from "node:http"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import type { Valv } from "@valv/core"
import { createMcpServer } from "./server.js"
import type { ValvMcpOptions } from "./types.js"

export interface HttpServerOptions<TContext> extends ValvMcpOptions<TContext> {
  /** Port to listen on. Default 3000. */
  port?: number
  /** HTTP path the MCP endpoint is mounted at. Default "/mcp". */
  path?: string
}

// Minimal structural type for what we touch on an http.Server, so callers can
// close it without us depending on express/node http typings.
interface Closable {
  close(cb?: () => void): unknown
}

type Req = IncomingMessage & { body?: unknown }
type Res = ServerResponse

// Loose structural typings for express — we avoid a hard dependency on
// @types/express while keeping the call sites checked.
interface ExpressApp {
  use(handler: unknown): unknown
  post(path: string, handler: (req: Req, res: Res) => void): unknown
  listen(port: number): Closable
}
type ExpressFn = ((...args: unknown[]) => ExpressApp) & { json: () => unknown }

/**
 * Start a valv MCP server over Streamable HTTP — for remote or shared
 * deployments. A fresh server + transport is created per request (stateless),
 * so the {@link ValvMcpOptions.context} resolver runs on every call.
 *
 * Requires the optional peer dependency `express`. Deploy this behind your own
 * authentication; the context resolver is the natural place to map a verified
 * caller to a valv policy context.
 */
export async function startHttpServer<TContext, TResources extends string = string>(
  valv: Valv<TContext, TResources>,
  options: HttpServerOptions<TContext>,
): Promise<Closable> {
  let express: ExpressFn
  try {
    const specifier = "express"
    const mod = (await import(specifier)) as { default: ExpressFn }
    express = mod.default
  } catch {
    throw new Error(
      '[valv] startHttpServer() requires the "express" package. Install it with: npm install express',
    )
  }

  const path = options.path ?? "/mcp"
  const port = options.port ?? 3000

  const app = express()
  app.use(express.json())

  app.post(path, async (req: Req, res: Res) => {
    const server = createMcpServer(valv, options)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on("close", () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  })

  return app.listen(port)
}
