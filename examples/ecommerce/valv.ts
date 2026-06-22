import "dotenv/config"
import { PrismaClient } from "@prisma/client"
import { createValv } from "@valv/prisma"

// Shared valv setup + policies for the e-commerce example. Imported by the
// in-process demo (index.ts), the dashboard (live-dashboard.ts), and the MCP
// server (mcp.ts) so the exact same access policies govern every surface.

export const prisma = new PrismaClient()

// Built lazily and memoized — createValv is async (it reads the schema on
// construction), and CommonJS has no top-level await.
let cached: ReturnType<typeof build> | null = null
export function getValv() {
  return (cached ??= build())
}

async function build() {
  const valv = await createValv(prisma, {
    defaultPolicy: "deny-all",
    onQuery: ({ resource, durationMs, error }) =>
      console.log(`  [audit] query on ${resource} (${durationMs}ms)${error ? ` — ${error.message}` : ""}`),
  })

  // Reads are tenant-scoped; sensitive columns are denied per role. (Prisma has
  // no schema-level sensitivity, so name them here.)
  valv.policy("order", (ctx) => ({
    read: { tenant_id: ctx.tenant!.id },
    fields: { deny: ctx.user.role === "support" ? ["user_id", "internal_notes"] : ["internal_notes"] },
  }))

  valv.policy("user", (ctx) => ({
    read: { tenant_id: ctx.tenant!.id },
    fields: { deny: ctx.user.role === "support" ? ["password_hash", "email"] : ["password_hash"] },
  }))

  valv.policy("product", (ctx) => ({ read: { tenant_id: ctx.tenant!.id } }))
  valv.policy("order_item", () => ({ read: false }))

  return valv
}
