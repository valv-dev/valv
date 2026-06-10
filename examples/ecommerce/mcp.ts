import "dotenv/config"
import { startStdioServer } from "@vistal/mcp-sdk"
import { prisma, vistal } from "./vistal"

// Expose the e-commerce database to a coding agent (e.g. Claude Code) as an MCP
// server. The same policies defined in ./vistal apply here — no SQL reaches the
// agent, sensitive fields stay hidden, and reads/writes are tenant-scoped.
//
// Register it in your MCP client (e.g. Claude Code's .mcp.json):
//
//   {
//     "mcpServers": {
//       "vistal": {
//         "command": "npx",
//         "args": ["tsx", "examples/ecommerce/mcp.ts"],
//         "env": {
//           "DATABASE_URL": "postgres://...",
//           "VISTAL_ROLE": "support",
//           "VISTAL_TENANT": "tenant-alpha"
//         }
//       }
//     }
//   }

async function main(): Promise<void> {
  await startStdioServer(vistal, {
    // Env-friendly context resolver — policy context is read on every request,
    // so changing VISTAL_ROLE / VISTAL_TENANT reshapes what the agent can do
    // without touching code. Default to a least-privileged support role.
    context: () => ({
      user: {
        id: process.env.VISTAL_USER_ID ?? "mcp-agent",
        role: process.env.VISTAL_ROLE ?? "support",
      },
      tenant: { id: process.env.VISTAL_TENANT ?? "tenant-alpha" },
    }),
    // mode defaults to "consolidated" — the small fixed verb set ideal for MCP.
    serverInfo: { name: "vistal-ecommerce", version: "0.1.0" },
  })

  // Keep the process alive on stdio; shut the DB connection on exit signals.
  const shutdown = async () => {
    await prisma.$disconnect()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
