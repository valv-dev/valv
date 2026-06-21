# valv

**Let an LLM query your database — safely, by construction.**

[![npm](https://img.shields.io/npm/v/@valv/core?label=%40valv%2Fcore)](https://www.npmjs.com/package/@valv/core) [![npm](https://img.shields.io/npm/v/@valv/clickhouse?label=%40valv%2Fclickhouse)](https://www.npmjs.com/package/@valv/clickhouse) [![npm](https://img.shields.io/npm/v/@valv/prisma?label=%40valv%2Fprisma)](https://www.npmjs.com/package/@valv/prisma) [![npm](https://img.shields.io/npm/v/@valv/mcp?label=%40valv%2Fmcp)](https://www.npmjs.com/package/@valv/mcp) [![license](https://img.shields.io/npm/l/@valv/core)](./LICENSE)

valv gives an agent a single `query` tool. The model emits a **structured query** — never SQL — and valv validates it against your schema, scopes it to the current user with policies you write in code, compiles it to your database's SQL, and runs it.

The model's query is treated as fully untrusted. It can't read a column you hid, a row the user isn't allowed to see, or call a function you didn't allow — not because the prompt asks nicely, but because the query is rebuilt and re-checked on the server before a single byte of SQL is generated.

```ts
const valv = await createValv(client, { schema: "introspect", defaultPolicy: "deny-all" })

valv.policy("orders", (ctx) => ({
  read:   { tenant_id: ctx.tenant.id },   // every read is scoped to this tenant
  fields: { deny: ["internal_notes"] },   // this column never reaches the model
}))

const tools = await valv.tools.aisdk(ctx)  // hand to your agent — it queries safely
```

---

## Quick start

Install an adapter for your database (it pulls in `@valv/core`):

```bash
npm i @valv/clickhouse @clickhouse/client     # ClickHouse
# or
npm i @valv/prisma @prisma/client             # Postgres / MySQL / SQLite
```

Wire it up — connect, write a policy, hand the tools to an agent:

```ts
import { createValv } from "@valv/clickhouse"
import { generateText, stepCountIs } from "ai"

// 1. Connect — introspect the live schema (or pass a hand-defined one).
const valv = await createValv(client, { schema: "introspect", defaultPolicy: "deny-all" })

// 2. Policy — what this caller may read, resolved from your context.
valv.policy("orders", (ctx) => ({ read: { tenant_id: ctx.tenant.id } }))

// 3. Tools — bound to the request's context, formatted for your provider.
const ctx = { user: { id: "u1", role: "analyst" }, tenant: { id: "acme" } }
const { text } = await generateText({
  model,
  tools: await valv.tools.aisdk(ctx),
  stopWhen: stepCountIs(6),
  prompt: "What's our revenue per order status this month?",
})
```

The agent gets four tools — `list_resources`, `search_resources`, `describe_resource`, and `query` — discovers your schema, and runs a query. valv scopes it to `acme`, compiles it to ClickHouse SQL, runs it, and hands back rows.

---

## What the agent can express

One `query` tool covers the whole read surface. The model composes a query from columns, filters, and an allow-listed set of functions:

```jsonc
{
  "from": "orders",
  "select": [
    { "col": "status" },
    { "fn": "count", "args": [], "as": "orders" },
    { "fn": "sum", "args": [{ "kind": "col", "name": "total" }], "as": "revenue" }
  ],
  "where": { "kind": "cmp", "op": ">=", "left": { "kind": "col", "name": "created_at" },
             "right": { "kind": "value", "value": "2026-06-01" } },
  "groupBy": ["status"],
  "orderBy": [{ "col": "revenue", "dir": "desc" }],
  "limit": 10
}
```

That's enough for real analytics — **filters** (arbitrary `and`/`or`/`not` trees), **aggregates**, **time-series** (bucket with a function and group by the alias), **top-N** (order by an aggregate), and **conditional aggregation** (`countIf`, `sumIf`). ClickHouse adds dialect functions like `quantileTiming` and `toStartOfInterval`; every function is type-checked and its literals parameterized.

---

## Usage

### Connect

`createValv` is async — it loads the schema on construction, so the instance is ready to use. Call it **once** at startup.

```ts
// ClickHouse — introspect, or hand-define a schema
const valv = await createValv(clickhouseClient, { schema: "introspect", database: "analytics" })

// Prisma (Postgres / MySQL / SQLite / Cockroach) — schema comes from your .prisma file
import { createValv } from "@valv/prisma"
const valv = await createValv(prismaClient)
```

`defaultPolicy: "deny-all"` (recommended) makes a resource invisible until you write a policy for it.

### Policy

A policy is a function of your context. It decides what the caller may read, per resource:

```ts
valv.policy("orders", (ctx) => ({
  read:   { tenant_id: ctx.tenant.id },   // row filter — AND-injected into every query
  fields: { deny: ["internal_notes"] },   // hide columns
}))

valv.policy("users", (ctx) => ({
  read:   { tenant_id: ctx.tenant.id },
  fields: ctx.user.role === "support" ? { deny: ["email"] } : undefined,
}))
```

| `read` value | Meaning |
|---|---|
| `true` / `false` | allow / deny outright |
| `{ field: value }` | a row filter, AND-ed into the query server-side |

The row filter can't be widened or overridden by the model — it's injected *after* the model's query is parsed, into the `WHERE` clause, before SQL is emitted. Fields are denied two ways: `fields.deny` (a blacklist) or `fields.allow` (a whitelist). Denied and unknown columns fail with the same message, so the model can't probe for hidden columns. Use `"*"` as the resource name for a default policy.

### Tools

`valv.tools.<format>(ctx, options)` returns provider-ready tools, bound to that context. Discovery is **policy-filtered** — `list`/`search`/`describe` only surface what the caller may read.

```ts
valv.tools.anthropic(ctx)                              // Anthropic Messages API
valv.tools.openai(ctx)                                 // OpenAI / compatible
valv.tools.gemini(ctx)                                 // Google Gemini
await valv.tools.aisdk(ctx)                            // Vercel AI SDK (async; needs `ai`)
valv.tools.neutral(ctx)                                // raw, framework-agnostic

valv.tools.anthropic(ctx, { list: false, search: false })  // drop discovery tools individually
```

The `aisdk` format returns self-executing tools (the SDK runs them). The provider formats (`anthropic`/`openai`/`gemini`) return tool **definitions** for the API request; you dispatch a tool call with `runTool`:

```ts
const result = await valv.runTool(call.name, call.input, ctx)
```

### Saved queries & dashboards

Because the model emits a plain query object, you can **store it and re-run it** — a dashboard that refreshes without the LLM in the loop. Replays go through the full pipeline every time, so policy is always re-applied for the *current* viewer:

```ts
await db.saveWidget(id, { query })            // it's just JSON — persist it anywhere

const rows = await valv.run(widget.query, ctx)   // fresh data, re-scoped to ctx
const columns = valv.resultSchema(widget.query)  // output columns + types, without running it
```

`resultSchema` derives the output shape (`[{ name, type }]`) from the query alone — handy for driving chart config and detecting drift when the schema changes. A stored query is never trusted: it's re-validated on every replay, so it can't outlive the permissions it was created under.

---

## How it works

```
LLM ──emits──▶  query (structured JSON, untrusted)
                  │
                  ▼
              validate     check every column/function against the catalog + policy
                  │
                  ▼
              inject        AND the tenant/row filter into WHERE
                  │
                  ▼
              emit          compile to your dialect's SQL, with bound parameters
                  │
                  ▼
              execute  ──▶  your database  ──▶  serialized rows
```

A worked example. The agent asks for revenue per status and emits:

```jsonc
{ "from": "orders",
  "select": [{ "col": "status" }, { "fn": "sum", "args": [{ "kind": "col", "name": "total" }], "as": "revenue" }],
  "groupBy": ["status"] }
```

With the policy `read: { tenant_id: ctx.tenant.id }` and `ctx.tenant.id = "acme"`, valv emits:

```sql
SELECT `status`, sum(`total`) AS `revenue`
FROM `orders`
WHERE (`tenant_id` = {p0:String})          -- ← injected; the model never wrote this
GROUP BY `status`
-- params: p0 = "acme"
```

The model never wrote the `WHERE` clause, and it can't remove it. If it had selected a denied column (`internal_notes`), referenced an unknown function, or hidden a sensitive column inside a `sumIf` predicate, validation would have rejected the whole query *before* any SQL existed. Values become bound parameters, never string-concatenated. That's the "by construction" part: safety doesn't depend on the model behaving.

---

## Connect a coding agent (MCP)

Expose your database to an agent like **Claude Code** over the [Model Context Protocol](https://modelcontextprotocol.io) — same tools, same policy enforcement.

### Zero-config server

[`@valv/mcp`](packages/mcp) needs no code. Run the guided setup, which probes your database and writes the config for you:

```bash
npx @valv/mcp init
```

Or wire it by hand in your `.mcp.json` — point it at a connection string:

```json
{
  "mcpServers": {
    "db": {
      "command": "npx",
      "args": ["-y", "@valv/mcp"],
      "env": { "DATABASE_URL": "postgresql://user:pass@localhost:5432/app" }
    }
  }
}
```

It introspects the live schema, serves the four tools **read-only by default**, and works with any Prisma-supported database **or ClickHouse** (use an `http://host:8123` URL + `VALV_DATABASE`). Narrow access with `VALV_TABLES` / `VALV_EXCLUDE`, or take full control with a `VALV_POLICY_FILE`.

### In your app

[`@valv/mcp-sdk`](packages/mcp-sdk) turns a valv instance *you* configure into an MCP server, with policy and per-request context in your hands:

```ts
import { startStdioServer } from "@valv/mcp-sdk"

const valv = await createValv(client, { schema: "introspect", defaultPolicy: "deny-all" })
valv.policy("orders", (ctx) => ({ read: { tenant_id: ctx.tenant.id } }))

await startStdioServer(valv, {
  context: () => resolveIdentity(),   // resolved per request (env, headers, …)
})
```

---

## Adapters

| Package | Database | Install |
|---|---|---|
| [`@valv/clickhouse`](packages/clickhouse) | ClickHouse | `npm i @valv/clickhouse @clickhouse/client` |
| [`@valv/prisma`](packages/prisma) | PostgreSQL, MySQL, SQLite, CockroachDB | `npm i @valv/prisma @prisma/client` |

Everything above the adapter (the query grammar, validation, policy injection, the tool layer) lives in `@valv/core` and is database-agnostic. A new adapter is `introspect()` (produce a schema), a small `Dialect` (how to quote identifiers and bind parameters), and `execute()` — the SQL emitter is shared, so you don't write a compiler.

## Examples

- [`examples/hand-schema`](examples/hand-schema) — offline, no database: a hand-defined schema, queries, and `resultSchema`. The fastest way to see the pipeline.
- [`examples/clickhouse-analytics`](examples/clickhouse-analytics) — an agent answering analytics questions over ClickHouse.
- [`examples/ecommerce`](examples/ecommerce) — an agent over Postgres (Prisma), plus a [saved-query dashboard](examples/ecommerce/live-dashboard.ts).

## License

MIT
