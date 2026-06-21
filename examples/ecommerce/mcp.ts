import "dotenv/config"
import { startStdioServer } from "@valv/mcp-sdk"
import { prisma, getValv } from "./valv"

// NOTE: the MCP SDK is mid-migration to the new tool surface (list/search/
// describe/query). Until that lands it exposes no tools; the policies + setup
// below are already on the new API.

// Expose the e-commerce database to a coding agent (e.g. Claude Code) as an MCP
// server. The same policies defined in ./valv apply here — no SQL reaches the
// agent, sensitive fields stay hidden, and reads/writes are tenant-scoped.
//
// Register it in your MCP client (e.g. Claude Code's .mcp.json):
//
//   {
//     "mcpServers": {
//       "valv": {
//         "command": "npx",
//         "args": ["tsx", "examples/ecommerce/mcp.ts"],
//         "env": {
//           "DATABASE_URL": "postgres://...",
//           "VALV_ROLE": "support",
//           "VALV_TENANT": "tenant-alpha"
//         }
//       }
//     }
//   }

async function main(): Promise<void> {
  const valv = await getValv()
  await startStdioServer(valv, {
    // Env-friendly context resolver — policy context is read on every request,
    // so changing VALV_ROLE / VALV_TENANT reshapes what the agent can do
    // without touching code. Default to a least-privileged support role.
    context: () => ({
      user: {
        id: process.env.VALV_USER_ID ?? "mcp-agent",
        role: process.env.VALV_ROLE ?? "support",
      },
      tenant: { id: process.env.VALV_TENANT ?? "tenant-alpha" },
    }),
    // mode defaults to "consolidated" — the small fixed verb set ideal for MCP.
    serverInfo: { name: "valv-ecommerce", version: "0.1.0" },
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
