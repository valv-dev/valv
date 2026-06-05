# @vistal/core

**The authorization layer for AI agents — zero-dependency core.**

[![npm](https://img.shields.io/npm/v/@vistal/core)](https://www.npmjs.com/package/@vistal/core) [![license](https://img.shields.io/npm/l/@vistal/core)](../../LICENSE) [![TypeScript](https://img.shields.io/badge/types-TypeScript-blue)](./src/index.ts)

Reads an ORM schema, generates typed LLM tools, and enforces row-level security and field-level access control server-side on every query — in code, not prompts. Adapter-agnostic: works with any ORM or database through a two-method interface.

> **Most users should install [`@vistal/prisma`](https://www.npmjs.com/package/@vistal/prisma)** (Prisma / PostgreSQL / MySQL / SQLite) or [`@vistal/clickhouse`](https://www.npmjs.com/package/@vistal/clickhouse) (ClickHouse), which wrap this package with a ready-made adapter and schema introspection. Use `@vistal/core` directly only if you're building a custom adapter.

---

## Installation

```bash
npm install @vistal/core
```

---

## What this package exports

| Export | Purpose |
|---|---|
| `Vistal` | Main class — instantiate with an adapter, register policies, get tools |
| `formats.anthropic / openai / gemini` | Tool formatters — convert provider-neutral tools to provider-specific shapes |
| `PolicyViolationError`, `ValidationError` | Error types thrown by the policy engine |
| `serializeResult` | Serializes `Decimal`, `Date`, `BigInt` in query results |
| Types: `VistalAdapter`, `SchemaMap`, `ResolvedQuery`, `FilterNode`, `PolicyFn`, `PolicyResult`, … | All types needed to build a custom adapter |

---

## Building a custom adapter

An adapter is two methods: `introspect()` returns a `SchemaMap` describing your resources; `execute()` runs a `ResolvedQuery` against your database.

```ts
import type { VistalAdapter, SchemaMap, ResolvedQuery } from "@vistal/core"

class MyAdapter implements VistalAdapter {
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

Then pass your adapter to `Vistal`:

```ts
import { Vistal } from "@vistal/core"

const vistal = new Vistal({
  adapter: new MyAdapter(),
  defaultPolicy: "deny-all",
})
```

---

## Policies

Register policies per resource. Each policy is a function that receives a context object and returns what is allowed:

```ts
vistal.policy("order", (ctx) => ({
  read:   { tenant_id: ctx.tenant.id },   // row filter — AND-ed into every read
  write:  { tenant_id: ctx.tenant.id },   // force-injected on INSERT, AND-ed on UPDATE WHERE
  delete: false,                           // delete_order tool never generated
  fields:    { deny: ctx.user.role === "support" ? ["internal_notes"] : [] },
  relations: { items: true, customer: ctx.user.role === "admin" },
}))

// "*" is a wildcard fallback for resources without an explicit policy()
vistal.policy("*", (ctx) => ({
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

For each resource, vistal generates up to six tools depending on policy:

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
const tools = await vistal.tools.vercel(ctx)
await generateText({ model, tools, maxSteps: 5, prompt })

// Anthropic
const tools = await vistal.tools.anthropic(ctx)
// tools[i].definition → pass to the API
// tools[i].execute(args) → dispatch on tool call

// OpenAI
const tools = await vistal.tools.openai(ctx)

// Gemini
const tools = await vistal.tools.gemini(ctx)

// Custom formatter
const tools = await vistal.tools.format(ctx, (t) => ({
  id: t.name,
  schema: t.parameters,
}))
```

---

## Type-safe resource names

Use `InferResources` to derive resource names from an existing typed client (e.g. Prisma):

```ts
import { Vistal, InferResources } from "@vistal/core"
import { PrismaClient } from "@prisma/client"

const prisma = new PrismaClient()

const vistal = new Vistal<DefaultContext, InferResources<typeof prisma>>({
  adapter: myAdapter,
  defaultPolicy: "deny-all",
})

// policy() and getTools() autocomplete and type-check resource names
vistal.policy("order", ...)
```

---

## Observability

```ts
new Vistal({
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
| [`@vistal/prisma`](https://www.npmjs.com/package/@vistal/prisma) | PostgreSQL, MySQL, SQLite (via Prisma 5+) |
| [`@vistal/clickhouse`](https://www.npmjs.com/package/@vistal/clickhouse) | ClickHouse |

---

## License

MIT
