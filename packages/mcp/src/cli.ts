#!/usr/bin/env node
import { configFromEnv } from "./config"
import { startValvMcpServer } from "./index"

async function main(): Promise<void> {
  // `valv-mcp init` runs the interactive setup wizard; otherwise serve.
  if (process.argv[2] === "init") {
    const { runInit } = await import("./init")
    await runInit()
    return
  }

  const config = configFromEnv(process.env, process.argv.slice(2))
  const server = await startValvMcpServer(config)

  const shutdown = async () => {
    await server.stop()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

main().catch((err: unknown) => {
  // Never write errors to stdout — it's the MCP transport.
  process.stderr.write(`[valv] ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
