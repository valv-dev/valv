# valv

**Let agents query your database. Just not all of it.**

[![npm](https://img.shields.io/npm/v/@valv/core?label=%40valv%2Fcore)](https://www.npmjs.com/package/@valv/core) [![npm](https://img.shields.io/npm/v/@valv/clickhouse?label=%40valv%2Fclickhouse)](https://www.npmjs.com/package/@valv/clickhouse) [![npm](https://img.shields.io/npm/v/@valv/prisma?label=%40valv%2Fprisma)](https://www.npmjs.com/package/@valv/prisma) [![npm](https://img.shields.io/npm/v/@valv/mcp?label=%40valv%2Fmcp)](https://www.npmjs.com/package/@valv/mcp) [![license](https://img.shields.io/npm/l/@valv/core)](./LICENSE)

valv gives an agent structured tools to **read** your database — and, opt-in, to **write** to it. The model emits a **structured query** (or insert/update/delete) — never SQL — and valv validates it against your schema, scopes it to the current user with policies you write in code, compiles it to your database's SQL, and runs it.

The model's query is treated as fully untrusted. It can't read a column you hid, a row the user isn't allowed to see, call a function you didn't allow, write a column you didn't permit, or escape its tenant on a write — not because the prompt asks nicely, but because the query is rebuilt and re-checked on the server before a single byte of SQL is generated.

```ts
const valv = await createValv(client, { schema: "introspect", defaultPolicy: "deny-all" })

valv.policy("orders", (ctx) => ({
  read:   { tenant_id: ctx.tenant.id },   // every read is scoped to this tenant
  fields: { deny: ["internal_notes"] },   // this column never reaches the model
}))

const tools = await valv.tools.aisdk(ctx)  // hand to your agent — it queries safely
```

---

## Two ways to use it

- **In your app.** Configure valv in code, write policies against your request context, and hand the tools to your agent — Vercel AI SDK, Anthropic, OpenAI, or Gemini. Or expose those same tools over MCP with [`@valv/mcp-sdk`](packages/mcp-sdk), scoped per request.
- **With a coding agent.** Point [`@valv/mcp`](packages/mcp) at a database and a tool like Claude Code queries it safely — no code required.

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
  system: await valv.instructions(ctx),  // how to drive the tools + the caller's resources
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
    { "fn": "sum", "args": [{ "col": "total" }], "as": "revenue" }
  ],
  "where": { "kind": "cmp", "op": ">=", "left": { "kind": "col", "name": "created_at" },
             "right": { "kind": "value", "value": "2026-06-01" } },
  "groupBy": ["status"],
  "orderBy": [{ "col": "revenue", "dir": "desc" }],
  "limit": 10
}
```

That's enough for real analytics — **filters** (arbitrary `and`/`or`/`not` trees, with `like`/`ilike` for pattern matching), **aggregates**, **time-series** (bucket with a function and group by the alias), **top-N** (order by an aggregate), and **conditional aggregation** (`countIf`, `sumIf`). ClickHouse adds dialect functions like `quantileTiming` and `toStartOfInterval`; every function is type-checked and its literals parameterized.

### Joins

To read a related resource, qualify a column with `rel` — a relation path from the root. The model can only follow relations declared in your schema; valv derives the joins, picks the keys, and **composes the policy of every table it touches** — each joined table is scoped by its own policy and field allowlist, so a join can never reach a hidden column or another tenant's rows.

```jsonc
{
  "from": "orders",
  "select": [
    { "col": "name", "rel": ["customer"] },              // one hop: orders → customer
    { "col": "name", "rel": ["customer", "region"] },    // multi-hop: → customer → region
    { "fn": "sum", "args": [{ "col": "total" }], "as": "revenue" }
  ],
  "groupBy": [{ "col": "name", "rel": ["customer"] }]
}
```

`belongsTo` and `hasMany` relations are supported; join depth, table count, and fan-out are capped, and every query runs under a statement timeout. Relations are auto-introspected on Prisma and declared in the schema on ClickHouse.

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

The same policy object carries the write axes — `create`, `update`, `delete` (and `write` as a shorthand for create+update) — which default to denied. See [Writes](#writes).

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

The discovery tools (`list`/`search`/`describe`) are on by default; the write tools (`create`/`update`/`delete`) are **off** by default — turn them on per call:

```ts
valv.tools.aisdk(ctx, { search: false, create: true, update: true })
```

### System prompt

`await valv.instructions(ctx)` returns a drop-in system-prompt block: how to drive the tools (discover → describe → query, filters are scoped server-side) plus the resources **this caller** may read — so the model can skip the opening `list_resources` round-trip. Put it in your `system` prompt alongside the tools. The static text is also exported as `AGENT_INSTRUCTIONS` if you'd rather compose the resource list yourself.

```ts
const system = await valv.instructions(ctx)
```

```
You answer questions by querying a set of resources through the provided tools. Access is
enforced server-side: every query is scoped to what the current caller may read, so you never
need to add tenant/owner/permission filters yourself — a query returns only permitted rows.

Workflow:
1. Find the resource: use list_resources / search_resources; you often already have the list below.
2. Before querying an unfamiliar resource, call describe_resource to get its exact column names,
   types, and relations. Don't guess column names.
3. Query with the `query` tool. Do the work in the query — filter with `where`, aggregate with
   functions, `groupBy`, `orderBy`, `limit` — rather than pulling raw rows and reducing yourself.
4. Read a joined resource's columns by setting `rel` to its relation path from the root; only
   declared relations join.

Grammar reminders (the tool schemas have the full shapes): a column is never a bare string — in
`select` it is { "col": "name" }, and inside a function's `args` or in `where` it is the Expr
node { "kind": "col", "name": "name" }. `where` is an Expr tree of cmp/and/or/not nodes over
`col` and `value` leaves, not a raw string.

If a call is rejected, read the error and fix the query — don't retry the same shape.

Resources you can query:
- orders — customer orders
- customers — people who place orders
```

### Writes

Writes are off until you both allow them in policy and expose the tool. Each is its own tool and its own policy axis, with stronger guarantees than reads — the model can't set columns you didn't permit, can't aim a row at another tenant, and can't run an unscoped update/delete:

```ts
valv.policy("orders", (ctx) => ({
  read:   { tenant_id: ctx.tenant.id },
  create: { tenant_id: ctx.tenant.id },   // tenant_id is force-set on insert
  update: { tenant_id: ctx.tenant.id },   // AND-injected into the WHERE
  delete: false,                          // never deletable
  fields: { readOnly: ["status"] },       // readable, not writable
}))

await valv.create({ from: "orders", values: { status: "pending", total: 1200 } }, ctx)
await valv.update({ from: "orders", set: { status: "shipped" }, where: { /* …Expr */ } }, ctx)
```

- **`create`** force-injects the policy's owned fields (`tenant_id`) onto the row — the model can't choose, omit, or override them.
- **`update`/`delete`** AND the policy predicate into your `where`, which is **required** (no implicit "all rows"). The model can only touch rows within its scope.
- The columns a write sets are checked against a **writable** allowlist (separate from readable); scope columns, sensitive fields, and `readOnly` fields aren't writable. A `where` can only filter by columns the caller can read.
- **Databases:** all three on Prisma (Postgres/MySQL/SQLite/Cockroach); ClickHouse supports `create` (insert) only.

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
  "select": [{ "col": "status" }, { "fn": "sum", "args": [{ "col": "total" }], "as": "revenue" }],
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

### Charting skill

[`skills/valv`](skills/valv) is a [Claude Code skill](https://docs.claude.com/en/docs/claude-code/skills) that turns a data question into a chart: it queries through the valv MCP and renders the result as a self-contained Chart.js HTML file. Ask it to "visualize revenue by month" and it discovers the schema, runs one structured query, and opens the chart.

It also **learns your database as you use it**. The first time it describes a table, figures out the dialect's time-bucket function, or maps "revenue" to `sum(total)` on `orders`, it records that in `.valv/notes.md` in your working directory — so later sessions skip the rediscovery and start warm. The notes hold schema and semantics only, never result rows, and the file is plain markdown you can read, edit, or pre-seed yourself.

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
