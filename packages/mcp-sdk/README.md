# @vistal/mcp-sdk

Expose a [vistal](https://github.com/vista-libs/vista) instance as an **MCP
server**, so coding agents like **Claude Code** can connect to your database —
with the same row-level security, field masking, and zero-SQL safety vistal
gives in-process.

It's a thin, **adapter-agnostic** wrapper: works with any configured `Vistal`
instance, whether backed by `@vistal/prisma` or `@vistal/clickhouse`. Tool
definitions and execution both run through vistal's policy engine, so every call
the agent makes is governed by your policies.

> Just want to point an agent at a database with no code? Use
> [`@vistal/mcp`](../mcp/README.md) — give it a `DATABASE_URL` and
> it introspects the live schema and serves it read-only. This package
> (`@vistal/mcp-sdk`) is for when you want to define the adapter and policies yourself.

## Install

```bash
npm install @vistal/mcp-sdk @vistal/core
# plus your adapter, e.g. @vistal/prisma + @prisma/client
# plus `express` only if you use the HTTP transport
```

## Usage

Write a small entry script that builds your vistal instance (adapter + policies),
then start the server. The agent gets the **consolidated** tool set by default —
a small fixed verb set (`list_resources`, `describe_resource`, `query`, `get`,
`create`, `update`, `delete`, `aggregate`) it uses to discover your schema at
runtime.

```ts
// mcp.ts
import { PrismaClient } from "@prisma/client"
import { createVistal } from "@vistal/prisma"
import { startStdioServer } from "@vistal/mcp-sdk"

const prisma = new PrismaClient()
const vistal = createVistal(prisma, { defaultPolicy: "deny-all" })

vistal.policy("order", (ctx) => ({
  read: { tenant_id: ctx.tenant.id },
  write: { tenant_id: ctx.tenant.id },
  delete: false,
}))

await startStdioServer(vistal, {
  // Resolved per request — source identity however you like (env, file, …).
  context: () => ({
    user: { id: process.env.VISTAL_USER_ID ?? "agent", role: process.env.VISTAL_ROLE ?? "support" },
    tenant: { id: process.env.VISTAL_TENANT ?? "tenant-alpha" },
  }),
})
```

### Register with Claude Code

Add it to your `.mcp.json` (run the TS entry with `tsx`):

```json
{
  "mcpServers": {
    "vistal": {
      "command": "npx",
      "args": ["tsx", "mcp.ts"],
      "env": {
        "DATABASE_URL": "postgres://…",
        "VISTAL_ROLE": "support",
        "VISTAL_TENANT": "tenant-alpha"
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
is the natural place to map a verified caller to a vistal policy context.

```ts
import { startHttpServer } from "@vistal/mcp-sdk"

await startHttpServer(vistal, {
  context: () => ({ user: { id: "agent", role: "support" }, tenant: { id: "tenant-alpha" } }),
  port: 3000, // POST /mcp
})
```

## Low-level builder

`createMcpServer(vistal, options)` returns a transport-agnostic MCP `Server`
you can connect to any transport yourself.

## API

| Export | Description |
| --- | --- |
| `createMcpServer(vistal, options)` | Build a transport-agnostic MCP `Server`. |
| `startStdioServer(vistal, options)` | Build + connect over stdio. |
| `startHttpServer(vistal, options)` | Build + serve over Streamable HTTP (needs `express`). |
| `VistalMcpOptions` | `context`, `mode` (`"consolidated"` \| `"per-resource"`), `toolOptions`, `serverInfo`. |

See [`examples/ecommerce/mcp.ts`](../../examples/ecommerce/mcp.ts) for a full,
policy-rich example.

## License

MIT
