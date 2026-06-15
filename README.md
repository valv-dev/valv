# valv

**Connect your agent to your database. No SQL. No leaks.**

[![npm](https://img.shields.io/npm/v/@valv/core?label=%40valv%2Fcore)](https://www.npmjs.com/package/@valv/core) [![npm](https://img.shields.io/npm/v/@valv/mcp?label=%40valv%2Fmcp)](https://www.npmjs.com/package/@valv/mcp) [![npm](https://img.shields.io/npm/v/@valv/prisma?label=%40valv%2Fprisma)](https://www.npmjs.com/package/@valv/prisma) [![npm](https://img.shields.io/npm/v/@valv/clickhouse?label=%40valv%2Fclickhouse)](https://www.npmjs.com/package/@valv/clickhouse) [![license](https://img.shields.io/npm/l/@valv/core)](./LICENSE) [![TypeScript](https://img.shields.io/badge/types-TypeScript-blue)](./packages/core)

Three lines wire your agent to your data. The model never writes SQL, never sees a field you hid, and never reads a row the current user isn't allowed to read. Enforcement lives in code, not in the prompt.

```ts
const valv = createValv(prisma, { defaultPolicy: "deny-all" })
const tools = await valv.tools.vercel(ctx)
await generateText({ model, tools, prompt })
```

That's it. No SQL generation. No per-endpoint wrappers. No "please only return the current tenant" in your system prompt.

## Three lines, three guarantees

The whole library is three ideas. Learn these and you know valv.

### 1. Connect

`createValv` reads your ORM schema and generates a typed tool per operation per resource: `query_`, `get_`, `create_`, `update_`, `delete_`, `aggregate_`. Hand them to any provider and the agent can work your data through structured tool calls instead of raw SQL.

```ts
import { PrismaClient } from "@prisma/client"
import { createValv } from "@valv/prisma"

const valv = createValv(new PrismaClient(), { defaultPolicy: "deny-all" })
```

Resource types are inferred from your Prisma client, so a typo in a policy key is a compile error.

### 2. Declare your schema

Annotate your Prisma schema with `///` doc comments. Describe resources so the model uses them correctly, and mark fields that must never leave the server.

```prisma
/// @valv:description "A customer purchase order"
model Order {
  id     String @id @default(uuid())
  status OrderStatus

  /// @valv:description "Order total in cents"
  total  Decimal

  /// @valv:sensitive
  internal_notes String?
}
```

`@valv:sensitive` is stripped at introspection, before any policy runs. The field does not exist as far as the LLM is concerned: not in schemas, not in arguments, not in results.

### 3. Write typed policies

One typed function decides what each user can touch. Row filters, field visibility, relation access, and which tools exist at all, driven entirely by your runtime context.

```ts
valv.policy("order", (ctx) => ({
  read:   { tenant_id: ctx.tenant.id },  // AND-ed into every read
  write:  { tenant_id: ctx.tenant.id },  // injected on create, guards update
  delete: false,                          // delete_order tool never generated
  fields:    { deny: ctx.user.role === "support" ? ["user_id"] : [] },
  relations: { customer: ctx.user.role === "admin", items: true },
}))
```

The read filter is AND-ed into the WHERE clause server-side, after the tool call is parsed. The model can send a conflicting filter and it gets overwritten. It cannot widen the filter, override it, or talk its way around it. The scoped query is the only query that runs.

## Same prompt. Same agent. Different context

```
"Summarize all orders. For each delivered order, show the items purchased."
```

| | Alice · admin | Bob · support | Carol · admin, tenant-β |
|---|---|---|---|
| **Tools visible** | query, get, create, update, aggregate | query, get, aggregate | query, get, create, update, aggregate |
| **Row filter** | `tenant_id = alpha` | `tenant_id = alpha` | `tenant_id = beta` |
| **Hidden fields** | none | `user_id` | none |
| **Customer relation** | ✓ | ✗ blocked | ✓ |
| **Orders returned** | #1, #3 | #1, #3 | #5, #6 |

Alice gets full output. Bob gets no customer link and `user_id` stripped. Carol only sees her tenant; `tenant-alpha` orders are structurally invisible to her. One policy function, no branching in your prompt.

## How it works

```
LLM
 ↓   tool call (no SQL, just arguments)
valv policy engine     ← row filters, write injection, field stripping, tool suppression
 ↓
your ORM
 ↓
database
```

The model calls a typed tool with arguments. valv resolves it into an ORM operation, applies the policy before execution, and runs it. Enforcement happens in your process, on the server, not on the model's honor.

## Install

```bash
npm install @valv/core @valv/prisma
```

| Package | Contents |
|---|---|
| `@valv/core` | Zero-dependency core: policies, tool generation, query IR |
| `@valv/prisma` | Prisma adapter + schema introspection (Prisma 5+) |
| `@valv/mcp` | Zero-config MCP server for coding agents — point it at a `DATABASE_URL`, no code ([Claude Code](packages/mcp/README.md)) |
| `@valv/mcp-sdk` | Library to turn your app's own DB into an MCP server, policies in code ([guide](packages/mcp-sdk/README.md)) |
| `ai` | Optional, only for `valv.tools.vercel()` |

Pass `schemaPath` to `createValv` if your schema isn't at `./prisma/schema.prisma`.

## Policy reference

### Operation keys

| Key | Covers | Falls back to |
|---|---|---|
| `read` | `query` / `get` | nothing |
| `aggregate` | `aggregate` | `read` |
| `write` | `create` **and** `update` (shorthand) | nothing |
| `create` | inserts | `write` |
| `update` | updates | `write` |
| `delete` | deletes | nothing |

Split `write` into `create` / `update` when they differ, e.g. allow inserts but make records immutable (`create: true, update: false`), or allow analytics without row reads (`read: false, aggregate: true`).

```ts
// Default everything to tenant scope
valv.policy("*", (ctx) => ({
  read:   { tenant_id: ctx.tenant.id },
  write:  { tenant_id: ctx.tenant.id },
  delete: false,
}))
```

### Rule values

| Value | Meaning |
|---|---|
| `true` | allow |
| `false` | deny, no tool generated |
| predicate object | a row condition |

Predicates use the same operator vocabulary the LLM filter schema exposes, plus `OR` / `AND` / `NOT`:

```ts
valv.policy("order", (ctx) => ({
  read:   { tenant_id: ctx.tenant.id, total: { lt: 100_000 } },
  update: { OR: [{ user_id: ctx.user.id }, { shared: true }] },
}))
```

- **read / delete / aggregate**: the predicate is AND-ed into the WHERE clause.
- **write (create / update)**: scalar equalities (`tenant_id: x`) are force-injected into the row; the full predicate guards the UPDATE/DELETE WHERE so only matching rows are touched. An operator filter on a *required* create field is rejected at build time, since an insert can't satisfy it.

### Field rules

| Key | Effect |
|---|---|
| `allow` | whitelist (read + write) |
| `deny` | blacklist (read + write) |
| `readOnly` | readable, never writable (e.g. `id`, `created_at`) |
| `writeOnly` | writable, never returned (e.g. a settable secret) |

`@valv:sensitive` fields are stripped regardless.

## Generated tools

| Tool | Operation |
|---|---|
| `query_{resource}` | findMany with filters, sort, pagination, relation includes |
| `get_{resource}` | findOne by id |
| `create_{resource}` | insert one row |
| `update_{resource}` | update by id |
| `delete_{resource}` | delete by id |
| `aggregate_{resource}` | count / sum / avg / min / max with optional groupBy |

`delete: false` suppresses the `delete_` tool. A required write field that is denied and not force-injected suppresses `create_` entirely, rather than generating a tool that always fails. Fields with `@default(...)` are not required in create tools.

## Pagination

`query_` tools return an envelope:

```ts
{ data: [...], nextCursor?: string, hasMore: boolean }
```

Pass `nextCursor` back as the `cursor` argument to fetch the next page — nothing else is required. Cursors are opaque base64 keyset tokens (sort field + direction + value + primary key), so they carry their own sort and paging stays stable under any sort even as rows are inserted. When `hasMore` is `false`, `nextCursor` is omitted.

```ts
const valv = createValv(prisma, {
  maxLimit: 100,      // hard cap on `limit` (default 100)
  defaultLimit: 50,   // applied when the model omits `limit` (default 50)
})
```

Omitting `limit` applies `defaultLimit` rather than returning every row. A supplied `limit` is clamped to `maxLimit`. `cursor` takes precedence over `offset`. When no sort is given it defaults to the primary key; a `cursor` reuses the sort it was issued under (resending a *different* sort alongside a cursor is rejected). Cursor pagination requires a non-nullable sort field.

## Providers

| Method | Use with |
|---|---|
| `valv.tools.vercel(ctx)` | Vercel AI SDK, drops into `generateText` / `streamText` |
| `valv.tools.anthropic(ctx)` | Anthropic Messages API |
| `valv.tools.openai(ctx)` | OpenAI / any OpenAI-compatible API |
| `valv.tools.gemini(ctx)` | Google Gemini |
| `valv.tools.format(ctx, fn)` | Any other provider, pass your own formatter |

```ts
// OpenAI
const tools = await valv.tools.openai(ctx)
await openai.responses.create({ model: "gpt-5", tools, input: prompt })

// Anthropic
const tools = await valv.tools.anthropic(ctx)
await anthropic.messages.create({ tools: tools.map(t => t.definition) })
const result = await tools.find(t => t.name === block.name)!.execute(block.input)

// Custom
const tools = await valv.tools.format(ctx, (t) => ({ id: t.name, schema: t.parameters }))
```

Tool errors are caught and returned as `{ error }` so the agent can recover instead of aborting.

## Live views

Normally, when an agent answers a question about your database, the answer is frozen — text in a chat. If you want to show that data in a chart, or keep it updating, you'd have to ask the model again and again.

Live views fix that. When the agent runs a query, your app can "catch" it and keep it:

```ts
// the agent called query_order — capture it
const view = await valv.view("query_order", toolCall.args, ctx)

view.resultSchema             // JSON Schema of the result — column names & types for your chart
const { data } = await view.execute()   // re-runs through the policy pipeline, no LLM

// live graph: poll + diff — onData fires only when results change
const sub = view.subscribe(({ data }) => chart.update(data), { intervalMs: 5000 })
sub.stop()
```

That `view` is a reusable handle with three abilities:

1. **Re-run it anytime** — `view.execute()` runs the same query directly against the database, with all your security rules (tenant isolation, hidden fields) still enforced. The AI is no longer involved, so it's instant and free.
2. **Know what it returns** — `view.resultSchema` describes the columns and their types, so your app knows how to build a chart from it.
3. **Keep it live** — `view.subscribe(callback)` watches the query and calls you only when the data actually changes. That's your live graph.

The agent designs the query once; your app owns it from there. Details:

- Works with per-resource (`query_order`) and consolidated (`query` + `{ resource: "order" }`) tool calls; `get` and `aggregate` too. Writes and meta tools are rejected.
- **Policies are re-evaluated on every execution** — a view can never see more than its context allows, and revoking access takes effect on the next tick.
- Results come back serialized (`Decimal` → number, `Date` → ISO string) as `{ data, hasMore, nextCursor? }` for every operation, so they're chart-ready.
- `resultSchema` describes that envelope from the introspected schema and the policy-allowed fields — including relations and aggregate aliases (`count` → integer). It's a snapshot taken at view creation.
- Invalid args or a denied policy throw at `view()` time, not on the first poll.
- `subscribe` options: `intervalMs` (default 5000), `emitInitial` (default true), `onError` (polling continues after errors). Polls never overlap — the next one is scheduled after the previous completes.
- Adapters can implement the optional `subscribe(query, onChange)` to replace polling with native change notifications (see [`@valv/core`](packages/core/README.md)); notifications only trigger a re-execute through the policy pipeline, they never carry data.
- `onQuery` events from views carry `source: "view"` (agent tool calls are `source: "tool"`), so dashboard refreshes don't pollute agent metrics.

See [`examples/ecommerce/live-dashboard.ts`](examples/ecommerce/live-dashboard.ts) for an end-to-end demo: the agent builds the query, the app charts it live.

### Persist & govern views

Views serialize to plain JSON — deliberately **without** the context, which is the security boundary and must be re-resolved on rehydration:

```ts
db.save(view.toJSON())                                // { valv: "view", v: 1, toolName, args }
const restored = await valv.viewFromJSON(json, ctx)   // policies re-apply for THIS ctx

// Or maintain a governed catalog of what dashboards may run:
valv.registerView("revenue_by_status", {
  toolName: "aggregate_order",
  args: { aggregations: [{ fn: "sum", field: "total", alias: "revenue" }], groupBy: ["status"] },
  description: "Revenue per order status",
})
const view = await valv.openView("revenue_by_status", ctx)
```

### Multi-step queries: compose() and deriveView()

An agent often answers by combining several queries. Reify that computation so it can run live without the LLM:

```ts
import { compose, deriveView } from "@valv/core"

// App-authored transform over policy-enforced inputs — recomputes when any input changes
const top = compose([ordersView, usersView], (orders, users) => rankBySpend(orders.data, users.data))
top.subscribe((ranking) => leaderboard.update(ranking))

// Declarative reshape — data-only, validated against the source schema, so it's
// safe to accept the spec from the agent itself ("build me a chart of X by Y")
const revenue = deriveView(ordersView, {
  groupBy: ["status"],
  aggregations: [{ alias: "revenue", fn: "sum", field: "total" }],
  sort: { field: "revenue", direction: "desc" },
})
revenue.subscribe(({ data }) => chart.update(data))     // emits only when the series changes
```

### Generated types

`generateViewTypes(view.resultSchema, "Order")` emits TypeScript source (`OrderRow` + `OrderResult` interfaces) from the runtime schema, so static types can't drift from what queries actually return.

### Scaling live views

Subscribers on the same View share **one** polling loop; a late subscriber is served from cache. Polling backs off exponentially while the query fails, an optional `jitter` spreads fleets of dashboards, and `maxConcurrentViewQueries` (default 16) caps simultaneous view executions per instance. Subscribe with `diffKey: "id"` to receive row-level `changes` (`added`/`removed`/`updated`) for smooth chart animation.

To replace polling entirely on Postgres, `@valv/prisma` ships LISTEN/NOTIFY support:

```ts
import { createValv, installLiveTriggers } from "@valv/prisma"

await installLiveTriggers(prisma, ["Order", "User"])    // once, e.g. after migrations
const valv = createValv(prisma, {
  live: { connectionString: process.env.DATABASE_URL! }, // requires the optional `pg` package
})
```

Triggers broadcast only the table name; on a notification the view re-executes through the policy pipeline — change notifications never carry data, so they can never bypass policy. Notification bursts are debounced, and views fall back to polling when `live` is not configured.

## Connect a coding agent (MCP)

Let a coding agent like **Claude Code** work your database directly over the [Model Context Protocol](https://modelcontextprotocol.io) — under valv policies, with no SQL and no leaks. Two ways in.

### Zero-config: just a database URL

[`@valv/mcp`](packages/mcp/README.md) needs no code and no schema file. Point it at a `DATABASE_URL`; it introspects the live database, generates the tools, and serves them **read-only by default**. Add it to your `.mcp.json`:

```json
{
  "mcpServers": {
    "db": {
      "command": "npx",
      "args": ["-y", "@valv/mcp"],
      "env": { "DATABASE_URL": "postgresql://user:pass@localhost:5432/mydb" }
    }
  }
}
```

Claude can now discover and read your tables. Narrow exposure with `VALV_TABLES` / `VALV_EXCLUDE`, and enable writes or richer rules with a `VALV_POLICY_FILE`. Works with any Prisma-supported database (PostgreSQL, MySQL, SQLite, SQL Server).

### Policies-in-code: embed it in your app

[`@valv/mcp-sdk`](packages/mcp-sdk/README.md) exposes a valv instance *you* configure (adapter + policies) as an MCP server — adapter-agnostic (Prisma or ClickHouse), with full control over policy and context.

```ts
import { startStdioServer } from "@valv/mcp-sdk"

const valv = createValv(prisma, { defaultPolicy: "deny-all" })
valv.policy("order", (ctx) => ({ read: { tenant_id: ctx.tenant.id }, delete: false }))

await startStdioServer(valv, {
  // resolved per request — source identity from env, headers, etc.
  context: () => ({ user: { role: process.env.VALV_ROLE! }, tenant: { id: process.env.VALV_TENANT! } }),
})
```

```json
{ "mcpServers": { "valv": { "command": "npx", "args": ["tsx", "mcp.ts"] } } }
```

Either way the agent gets the **consolidated** tool set — `list_resources`, `describe_resource`, `query`, `get`, `create`, `update`, `delete`, `aggregate` — and discovers your schema at runtime. `startHttpServer` serves the same over Streamable HTTP. See [`examples/ecommerce/mcp.ts`](examples/ecommerce/mcp.ts).

## Observability

```ts
new Valv({
  onQuery: ({ toolName, resource, durationMs, error }) => {
    logger.info({ toolName, resource, durationMs })
    if (error) logger.error({ toolName, error: error.message })
  },
})
```

## Other adapters

| Package | Database | Install |
|---|---|---|
| [`@valv/prisma`](packages/prisma/README.md) | PostgreSQL, MySQL, SQLite (via Prisma) | `npm i @valv/prisma @prisma/client` |
| [`@valv/clickhouse`](packages/clickhouse/README.md) | ClickHouse | `npm i @valv/clickhouse @clickhouse/client` |

Everything above the adapter layer (policies, tool generation, the query IR) is DB-agnostic. An adapter is two methods:

```ts
import type { ValvAdapter, SchemaMap, ResolvedQuery } from "@valv/core"

class MyAdapter implements ValvAdapter {
  async introspect(): Promise<SchemaMap> { ... }
  async execute(query: ResolvedQuery): Promise<unknown> { ... }
}
```

`SchemaMap`, `ResolvedQuery`, and `FilterNode` are exported from `/core`.

### ClickHouse

```ts
import { createClient } from "@clickhouse/client"
import { createValv } from "@valv/clickhouse"

const ch = createClient({ url: process.env.CLICKHOUSE_URL })
const valv = createValv(ch, { database: "analytics", defaultPolicy: "deny-all" })

valv.policy("events", (ctx) => ({
  read:      { tenant_id: ctx.tenant!.id },
  aggregate: { tenant_id: ctx.tenant!.id },
  write: false,
  delete: false,
}))

const tools = await valv.tools.vercel(ctx)
await generateText({ model, tools, prompt })
```

Schema annotations (`@valv:description`, `@valv:sensitive`) live in column and table
COMMENTs rather than Prisma `///` doc-comments. See the
[`@valv/clickhouse` README](packages/clickhouse/README.md) for details on the `id` column
requirement, the no-relations caveat, and mutation behaviour.

## Examples

[`examples/ecommerce/`](examples/ecommerce/) — three users (admin, support, cross-tenant) against a live Postgres database, with a stress-test suite for tenant isolation, sensitive field exclusion, write policy enforcement, and role-based field denial. Includes a [live dashboard](examples/ecommerce/live-dashboard.ts) (`npm run dashboard`) that captures an agent query as a view and drives a live revenue chart from it.

[`examples/clickhouse-analytics/`](examples/clickhouse-analytics/) — the same stress tests recast for ClickHouse: tenant isolation, sensitive-field guard, forced-tenant insert, revenue aggregation, and consolidated-mode schema discovery.

## License

MIT
