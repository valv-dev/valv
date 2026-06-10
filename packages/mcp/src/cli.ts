#!/usr/bin/env node
import { configFromEnv } from "./config"
import { startVistalMcpServer } from "./index"

async function main(): Promise<void> {
  const config = configFromEnv(process.env, process.argv.slice(2))
  const server = await startVistalMcpServer(config)

  const shutdown = async () => {
    await server.stop()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

main().catch((err: unknown) => {
  // Never write errors to stdout — it's the MCP transport.
  process.stderr.write(`[vistal] ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
