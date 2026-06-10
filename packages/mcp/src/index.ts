import type { PrismaClient } from "@prisma/client"
import { createVistal } from "@vistal/prisma"
import { startStdioServer, startHttpServer } from "@vistal/mcp-sdk"
import { prepareDatabase } from "./prepare"
import { applyAccess } from "./policy"
import type { ServerConfig } from "./config"

// Policy context is arbitrary JSON (VISTAL_CONTEXT). The default read-only policy
// ignores it; a policy file may read whatever shape the user passes.
type Ctx = Record<string, unknown>

export type { ServerConfig, Provider } from "./config"
export { configFromEnv, inferProvider } from "./config"

export interface RunningServer {
  /** Disconnect the database and remove the generated temp client. */
  stop: () => Promise<void>
}

/**
 * Boot a zero-config vistal MCP server against a live database: introspect the
 * schema, build a policy-gated vistal instance (read-only by default), and serve
 * it over stdio (or Streamable HTTP when `httpPort` is set).
 *
 * All progress is logged to stderr so stdout stays a clean MCP channel.
 */
export async function startVistalMcpServer(config: ServerConfig): Promise<RunningServer> {
  const provider = config.provider ?? "postgresql"
  const prepared = await prepareDatabase(config.databaseUrl, provider)

  const vistal = createVistal<PrismaClient, Ctx>(prepared.prisma, {
    schemaPath: prepared.schemaPath,
    defaultPolicy: "deny-all",
  })

  const { resources } = await applyAccess(vistal, config)
  process.stderr.write(
    `[vistal] Exposing ${resources.length} resource(s)` +
      (config.policyFile ? " (policy file in control)" : " (read-only)") +
      `: ${resources.join(", ") || "(none)"}\n`,
  )

  const options = {
    context: (): Ctx => (config.context as Ctx) ?? {},
    toolOptions: { resources },
  }

  if (config.httpPort !== undefined) {
    await startHttpServer(vistal, { ...options, port: config.httpPort })
    process.stderr.write(
      `[vistal] MCP server listening on http://localhost:${config.httpPort}/mcp\n`,
    )
  } else {
    await startStdioServer(vistal, options)
    process.stderr.write("[vistal] MCP server ready on stdio.\n")
  }

  const stop = async () => {
    try {
      await prepared.prisma.$disconnect()
    } finally {
      prepared.cleanup()
    }
  }
  return { stop }
}
