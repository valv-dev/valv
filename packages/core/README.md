# @valv/core

**The authorization layer for AI agents — zero-dependency core.**

[![npm](https://img.shields.io/npm/v/@valv/core)](https://www.npmjs.com/package/@valv/core) [![license](https://img.shields.io/npm/l/@valv/core)](../../LICENSE) [![TypeScript](https://img.shields.io/badge/types-TypeScript-blue)](./src/index.ts)

Reads an ORM schema, generates typed LLM tools, and enforces row-level security and field-level access control server-side on every query — in code, not prompts. Adapter-agnostic: works with any ORM or database through a two-method interface.

> **Most users should install [`@valv/prisma`](https://www.npmjs.com/package/@valv/prisma)** (Prisma / PostgreSQL / MySQL / SQLite) or [`@valv/clickhouse`](https://www.npmjs.com/package/@valv/clickhouse) (ClickHouse), which wrap this package with a ready-made adapter and schema introspection. Use `@valv/core` directly only if you're building a custom adapter.

---

## Installation

```bash
npm install @valv/core
```

---

## What this package exports

| Export | Purpose |
|---|---|
| `Valv` | Main class — instantiate with an adapter, register policies, get tools |
| `formats.anthropic / openai / gemini` | Tool formatters — convert provider-neutral tools to provider-specific shapes |
| `PolicyViolationError`, `ValidationError` | Error types thrown by the policy engine |
| `serializeResult` | Serializes `Decimal`, `Date`, `BigInt` in query results |
| `buildResultSchema` | JSON Schema for the result shape of a `ResolvedQuery` |
| Types: `ValvAdapter`, `SchemaMap`, `ResolvedQuery`, `FilterNode`, `PolicyFn`, `PolicyResult`, `View`, `ViewResult`, … | All types needed to build a custom adapter |

---

## Building a custom adapter

An adapter is two methods: `introspect()` returns a `SchemaMap` describing your resources; `execute()` runs a `ResolvedQuery` against your database.

```ts
import type { ValvAdapter, SchemaMap, ResolvedQuery } from "@valv/core"

class MyAdapter implements ValvAdapter {
  async introspect(): Promise<SchemaMap> {
    return {
      resources: {
        order: {
          name: "order",
          tableName: "Order",
          fields: {
            id:        { name: "id",        type: "uuid",   isId: true,  isNullable: false },
            tenant_id: { name: "tenant_id", type: "string", isId: false, isNullable: false },
            total:     { name: "total",     type: "number", isId: false, isNullable: false },
            status:    { name: "status",    type: "enum",   isId: false, isNullable: false, enumValues: ["pending", "shipped", "delivered"] },
          },
          relations: {},
        },
      },
    }
  }

  async execute(query: ResolvedQuery): Promise<unknown> {
    // query.resource  — resource name, e.g. "order"
    // query.operation — "findMany" | "findOne" | "create" | "update" | "delete" | "aggregate"
    // query.filters   — row filters AND-ed from the policy + the model's arguments
    // query.data      — write payload (create/update) with forced fields injected
    // query.include   — relation names to eager-load
    // query.sort / query.limit / query.offset
    // query.aggregations / query.groupBy
    // ... translate this into your ORM/DB call
  }
}
```

Then pass your adapter to `Valv`:

```ts
import { Valv } from "@valv/core"

const valv = new Valv({
  adapter: new MyAdapter(),
  defaultPolicy: "deny-all",
})
```

Adapters may also implement an optional third method to power live views with native change notifications instead of polling:

```ts
class MyAdapter implements ValvAdapter {
  // ...
  subscribe(query: ResolvedQuery, onChange: () => void): () => void {
    // watch the underlying table(s); call onChange() when data may have changed.
    // The view then re-executes through the policy pipeline and diffs — the
    // notification never carries data, so it can never bypass policy.
    // Return an unsubscribe function.
  }
}
```

---

## Policies

Register policies per resource. Each policy is a function that receives a context object and returns what is allowed:

```ts
valv.policy("order", (ctx) => ({
  read:   { tenant_id: ctx.tenant.id },   // row filter — AND-ed into every read
  write:  { tenant_id: ctx.tenant.id },   // force-injected on INSERT, AND-ed on UPDATE WHERE
  delete: false,                           // delete_order tool never generated
  fields:    { deny: ctx.user.role === "support" ? ["internal_notes"] : [] },
  relations: { items: true, customer: ctx.user.role === "admin" },
}))

// "*" is a wildcard fallback for resources without an explicit policy()
valv.policy("*", (ctx) => ({
  read:   { tenant_id: ctx.tenant.id },
  write:  false,
  delete: false,
}))
```

`read`, `write`, and `delete` accept:

| Value | Meaning |
|---|---|
| `true` | allow |
| `false` | deny — no tool generated for this operation |
| `{ field: value }` | row filter (read/delete) or force-injected field (write) |

---

## Generated tools

For each resource, valv generates up to six tools depending on policy:

| Tool | Operation |
|---|---|
| `query_{resource}` | findMany with filters, sort, pagination, relation includes |
| `get_{resource}` | findOne by id |
| `create_{resource}` | insert one row |
| `update_{resource}` | update by id |
| `delete_{resource}` | delete by id |
| `aggregate_{resource}` | count / sum / avg / min / max with optional groupBy |

`delete: false` → no `delete_` tool generated. A required write field that is denied and not force-injected → `create_` suppressed entirely.

---

## Getting tools for your LLM provider

```ts
// Vercel AI SDK (requires `ai` peer dep)
const tools = await valv.tools.vercel(ctx)
await generateText({ model, tools, maxSteps: 5, prompt })

// Anthropic
const tools = await valv.tools.anthropic(ctx)
// tools[i].definition → pass to the API
// tools[i].execute(args) → dispatch on tool call

// OpenAI
const tools = await valv.tools.openai(ctx)

// Gemini
const tools = await valv.tools.gemini(ctx)

// Custom formatter
const tools = await valv.tools.format(ctx, (t) => ({
  id: t.name,
  schema: t.parameters,
}))
```

---

## Live views

Capture any read tool call as a re-executable, subscribable handle — e.g. to drive a live chart from a query the agent built, without the LLM in the loop:

```ts
const view = await valv.view<Order>("query_order", toolCall.args, ctx)

view.resultSchema                       // JSON Schema of { data, hasMore, nextCursor? }
const { data } = await view.execute()   // data: Order[] — policies re-evaluated per call

const sub = view.subscribe(({ data }) => chart.update(data), {
  intervalMs: 5000,   // poll interval (default 5000)
  emitInitial: true,  // emit the first result immediately (default)
  onError: (e) => log.warn(e),  // polling continues after errors
})
sub.stop()
```

Accepts per-resource (`query_x` / `get_x` / `aggregate_x`) and consolidated (`query` + `{ resource }`) calls; writes and meta tools throw `ValidationError` at creation, as do invalid args or a denied policy. Subscriptions poll + diff (emit only on change, never overlapping); when the adapter implements the optional `subscribe(query, onChange)` (see above), native change notifications replace the timer. Results are serialized like tool results, and `onQuery` events from views carry `source: "view"`. The TS generic is developer-asserted; `resultSchema` is the runtime source of truth, derived from the introspected schema and policy-allowed fields at view creation.

**Scale & lifecycle.** Subscribers on the same View share one polling loop (late subscribers are served from cache); errors back off exponentially and reset on success; `jitter` (0–1) spreads polls across a fleet; `ValvConfig.maxConcurrentViewQueries` (default 16) caps simultaneous view executions per instance. `diffKey: "id"` adds row-level `changes` to each emission.

**Persistence & governance.** `view.toJSON()` → `{ valv: "view", v: 1, toolName, args }` — no ctx, by design; rehydrate with `valv.viewFromJSON(json, ctx)` under a freshly resolved context. `valv.registerView(name, { toolName, args })` / `openView(name, ctx)` / `listViews()` maintain a governed catalog of allowed live queries.

**Composition.** `compose([viewA, viewB], (a, b) => ...)` runs a pure app-authored transform over multiple views and re-emits when the *output* changes. `deriveView(view, { groupBy, aggregations, sort?, limit? })` applies a declarative, schema-validated reshape — data-only, so the spec can safely come from an agent — and derives its own `resultSchema`.

**Codegen.** `generateViewTypes(view.resultSchema, "Order")` emits `OrderRow` / `OrderResult` TypeScript interfaces from the runtime schema.

---

## Type-safe resource names

Use `InferResources` to derive resource names from an existing typed client (e.g. Prisma):

```ts
import { Valv, InferResources } from "@valv/core"
import { PrismaClient } from "@prisma/client"

const prisma = new PrismaClient()

const valv = new Valv<DefaultContext, InferResources<typeof prisma>>({
  adapter: myAdapter,
  defaultPolicy: "deny-all",
})

// policy() and getTools() autocomplete and type-check resource names
valv.policy("order", ...)
```

---

## Observability

```ts
new Valv({
  adapter,
  onQuery: ({ toolName, resource, operation, durationMs, error }) => {
    logger.info({ toolName, resource, durationMs })
    if (error) logger.error({ toolName, error: error.message })
  },
})
```

---

## Available adapters

| Package | Database |
|---|---|
| [`@valv/prisma`](https://www.npmjs.com/package/@valv/prisma) | PostgreSQL, MySQL, SQLite (via Prisma 5+) |
| [`@valv/clickhouse`](https://www.npmjs.com/package/@valv/clickhouse) | ClickHouse |

---

## License

MIT
