# @valv/mcp-sdk

Expose a [valv](https://github.com/vista-libs/vista) instance as an **MCP
server**, so coding agents like **Claude Code** can connect to your database —
with the same row-level security, field masking, and zero-SQL safety valv
gives in-process.

It's a thin, **adapter-agnostic** wrapper: works with any configured `Valv`
instance, whether backed by `@valv/prisma` or `@valv/clickhouse`. Tool
definitions and execution both run through valv's policy engine, so every call
the agent makes is governed by your policies.

> Just want to point an agent at a database with no code? Use
> [`@valv/mcp`](../mcp/README.md) — give it a `DATABASE_URL` and
> it introspects the live schema and serves it read-only. This package
> (`@valv/mcp-sdk`) is for when you want to define the adapter and policies yourself.

## Install

```bash
npm install @valv/mcp-sdk @valv/core
# plus your adapter, e.g. @valv/prisma + @prisma/client
# plus `express` only if you use the HTTP transport
```

## Usage

Write a small entry script that builds your valv instance (adapter + policies),
then start the server. The agent gets the **consolidated** tool set by default —
a small fixed verb set (`list_resources`, `describe_resource`, `query`, `get`,
`create`, `update`, `delete`, `aggregate`) it uses to discover your schema at
runtime.

```ts
// mcp.ts
import { PrismaClient } from "@prisma/client"
import { createValv } from "@valv/prisma"
import { startStdioServer } from "@valv/mcp-sdk"

const prisma = new PrismaClient()
const valv = createValv(prisma, { defaultPolicy: "deny-all" })

valv.policy("order", (ctx) => ({
  read: { tenant_id: ctx.tenant.id },
  write: { tenant_id: ctx.tenant.id },
  delete: false,
}))

await startStdioServer(valv, {
  // Resolved per request — source identity however you like (env, file, …).
  context: () => ({
    user: { id: process.env.VALV_USER_ID ?? "agent", role: process.env.VALV_ROLE ?? "support" },
    tenant: { id: process.env.VALV_TENANT ?? "tenant-alpha" },
  }),
})
```

### Register with Claude Code

Add it to your `.mcp.json` (run the TS entry with `tsx`):

```json
{
  "mcpServers": {
    "valv": {
      "command": "npx",
      "args": ["tsx", "mcp.ts"],
      "env": {
        "DATABASE_URL": "postgres://…",
        "VALV_ROLE": "support",
        "VALV_TENANT": "tenant-alpha"
      }
    }
  }
}
```

## Context resolver

`context` accepts a fixed value **or** a `() => ctx | Promise<ctx>` resolver
called on **every** request, so policy is always evaluated against fresh context.
This is the hook for sourcing identity from env vars (as above) — or, over HTTP,
from a verified request.

## Transports

### stdio (`startStdioServer`)

What Claude Code and most local MCP clients launch. No networking.

### Streamable HTTP (`startHttpServer`)

For remote / shared deployments. Requires the optional peer dependency `express`.
A fresh server is created per request (stateless), so the context resolver runs
on every call. **Deploy behind your own authentication** — the context resolver
is the natural place to map a verified caller to a valv policy context.

```ts
import { startHttpServer } from "@valv/mcp-sdk"

await startHttpServer(valv, {
  context: () => ({ user: { id: "agent", role: "support" }, tenant: { id: "tenant-alpha" } }),
  port: 3000, // POST /mcp
})
```

## Low-level builder

`createMcpServer(valv, options)` returns a transport-agnostic MCP `Server`
you can connect to any transport yourself.

## API

| Export | Description |
| --- | --- |
| `createMcpServer(valv, options)` | Build a transport-agnostic MCP `Server`. |
| `startStdioServer(valv, options)` | Build + connect over stdio. |
| `startHttpServer(valv, options)` | Build + serve over Streamable HTTP (needs `express`). |
| `ValvMcpOptions` | `context`, `mode` (`"consolidated"` \| `"per-resource"`), `toolOptions`, `serverInfo`. |

See [`examples/ecommerce/mcp.ts`](../../examples/ecommerce/mcp.ts) for a full,
policy-rich example.

## License

MIT
