# @valv/mcp-sdk

Expose a [valv](../../README.md) instance you configure as an **MCP server**, so coding agents like **Claude Code** can query your database — with the same policies, field masking, and zero-SQL safety valv gives in-process.

It's a thin, **adapter-agnostic** wrapper around a configured `Valv` (Prisma or ClickHouse): tool definitions and dispatch both run through valv, so every call is policy-gated.

[![npm](https://img.shields.io/npm/v/@valv/mcp-sdk)](https://www.npmjs.com/package/@valv/mcp-sdk) [![license](https://img.shields.io/npm/l/@valv/mcp-sdk)](../../LICENSE)

> Just want to point an agent at a `DATABASE_URL` with no code? Use [`@valv/mcp`](../mcp). This package is for when you want your own client, typed policies, and per-request identity.

## Install

```bash
npm i @valv/mcp-sdk
# plus your adapter, e.g. @valv/prisma + @prisma/client (or @valv/clickhouse)
# plus `express` only if you use the HTTP transport
```

## Usage

Build your valv instance (adapter + policies), then serve it. The agent gets the four tools — `list_resources`, `search_resources`, `describe_resource`, `query` — and discovers your schema at runtime.

```ts
// mcp.ts
import { PrismaClient } from "@prisma/client"
import { createValv } from "@valv/prisma"
import { startStdioServer } from "@valv/mcp-sdk"

const valv = await createValv(new PrismaClient(), { defaultPolicy: "deny-all" })
valv.policy("order", (ctx) => ({ read: { tenant_id: ctx.tenant.id } }))

await startStdioServer(valv, {
  // Resolved on every request — source identity from env vars, headers, etc.
  context: () => ({ user: { role: process.env.VALV_ROLE! }, tenant: { id: process.env.VALV_TENANT! } }),
})
```

Register it with your client:

```json
{ "mcpServers": { "valv": { "command": "npx", "args": ["tsx", "mcp.ts"] } } }
```

## Options

`startStdioServer(valv, options)` / `startHttpServer(valv, { ...options, port })` / `createMcpServer(valv, options)` (transport-agnostic `Server`) take:

| Option | Description |
|---|---|
| `context` | A value or per-request resolver (sync or async) for the policy context. |
| `discovery` | `{ list?, search?, describe?, create?, update?, delete? }` — discovery tools default on (`query` always stays); the write tools default off, enable them here (and allow the op in policy). |
| `serverInfo` | Advertised `{ name, version }`. |

The context resolver is the key piece for multi-tenant servers: over HTTP it can read identity from each request's headers, so one server safely serves many callers. Errors are sanitized before reaching the agent — valv's own validation/policy messages pass through, anything else becomes a generic message.

## License

MIT
