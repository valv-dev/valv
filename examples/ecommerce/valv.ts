import "dotenv/config"
import { PrismaClient } from "@prisma/client"
import { createValv } from "@valv/prisma"

// Shared valv setup + policies for the e-commerce example. Imported by both
// the in-process demo (index.ts) and the MCP server (mcp.ts) so the exact same
// access policies govern both surfaces.

export const prisma = new PrismaClient()

export const valv = createValv(prisma, {
  defaultPolicy: "deny-all",
  onQuery: ({ toolName, resource, durationMs, error }) => {
    if (error)
      console.warn(
        `  [audit] ${toolName} on ${resource} failed in ${durationMs}ms: ${error.message}`,
      )
    else console.log(`  [audit] ${toolName} on ${resource} (${durationMs}ms)`)
  },
})

// ── Policies ──────────────────────────────────────────────────────────────────

valv.policy("order", (ctx) => {
  // Auditor: a read-mostly analyst role that exercises the richer policy surface —
  //   • operator row filter (sees only low-value orders)
  //   • aggregate ≠ read (can total ALL orders, but only read rows under the cap)
  //   • create ≠ update (may amend orders, never open new ones)
  //   • read-only field (status is visible but not writable)
  if (ctx.user.role === "auditor") {
    return {
      read: { tenant_id: ctx.tenant!.id, total: { lt: 50000 } },
      aggregate: { tenant_id: ctx.tenant!.id },
      create: false,
      update: { tenant_id: ctx.tenant!.id },
      delete: false,
      fields: { readOnly: ["status"] },
      relations: { customer: false, items: true },
    }
  }

  return {
    read: { tenant_id: ctx.tenant!.id },
    write: { tenant_id: ctx.tenant!.id },
    delete: false,
    fields: {
      // internal_notes is @valv:sensitive — auto-excluded from LLM
      deny: ctx.user.role === "support" ? ["user_id"] : [],
    },
    relations: {
      customer: ctx.user.role === "admin",
      items: true,
    },
  }
})

valv.policy("user", (ctx) => ({
  read: { tenant_id: ctx.tenant!.id },
  // password_hash is @valv:sensitive — always excluded
  fields: { deny: ctx.user.role === "support" ? ["email"] : [] },
  write: false,
  delete: false,
}))

valv.policy("product", (ctx) => ({
  read: { tenant_id: ctx.tenant!.id },
  write: { tenant_id: ctx.tenant!.id },
  delete: false,
}))

valv.policy("order_item", () => ({ read: false }))
