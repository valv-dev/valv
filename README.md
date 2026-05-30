# ormai

Give your LLM agent access to your database. Control exactly what it can see and do.

---

## What it looks like

Three users. Same prompt. Same agent. Radically different results.

```
"Give me a summary of all orders. For each delivered order, show me the items purchased."
```

**Alice — admin**
```
→ query_order({"include": ["customer", "items"]})

Order #1 · Delivered · $1,549.98
  Customer: Alice Admin (alice@alpha.com)
  Items: Laptop ($1,299.99), Headset ($249.99)

Order #3 · Delivered · $229.98
  Customer: Alice Admin (alice@alpha.com)
  Items: Keyboard ($149.99), Mouse ($79.99)
```

**Bob — support** *(same prompt, same agent)*
```
→ query_order({"include": ["items"]})

Order #1 · Delivered · $1,549.98
  Items: Laptop ($1,299.99), Headset ($249.99)
  ↳ user_id: [hidden]   customer: [hidden]

Order #3 · Delivered · $229.98
  Items: Keyboard ($149.99), Mouse ($79.99)
  ↳ user_id: [hidden]   customer: [hidden]
```

**Carol — admin @ tenant-beta** *(cross-tenant isolation)*
```
→ query_order({"include": ["customer", "items"]})

Order #5 · Delivered · $2,199.99   ← tenant-beta only
Order #6 · Pending   · $899.00     ← tenant-alpha orders: invisible
```

The policy that drives all of this is 30 lines of TypeScript.

---

## The code

```ts
import { ORMAI, PrismaAdapter } from "ormai"
import type { DefaultContext, InferResources } from "ormai"
import { generateText } from "ai"

const ormai = new ORMAI<DefaultContext, InferResources<typeof prisma>>({
  adapter: new PrismaAdapter(prisma, "./prisma/schema.prisma"),
  defaultPolicy: "deny-all",  // nothing is accessible unless you say so
})

ormai.policy("order", (ctx) => ({
  read:   { tenant_id: ctx.tenant.id },   // row-level filter, always AND-ed in
  write:  { tenant_id: ctx.tenant.id },   // forced into INSERT data; guards UPDATE too
  delete: false,                           // no delete_order tool generated. ever.
  fields: {
    deny: ctx.user.role === "support" ? ["user_id"] : [],
  },
  relations: {
    customer: ctx.user.role === "admin",  // support can't expand to the user record
    items: true,
  },
}))

// One line to get a ready-to-use ToolSet for the Vercel AI SDK
const tools = await ormai.tools.vercel(ctx)

const { text } = await generateText({ model, tools, maxSteps: 8, prompt })
```

That's it. ormai reads your Prisma schema, evaluates the policy against the current user, and generates exactly the tools the LLM is allowed to call. When the LLM calls a tool, the policy filter is re-checked and merged server-side. The LLM cannot produce a query that escapes it.

---

## How it works

1. **Introspection** — parses `schema.prisma` via `@prisma/internals`. No DB connection needed at startup.
2. **Policy evaluation** — for each request, evaluates the policy against the current context and determines which operations, fields, and relations are accessible.
3. **Tool generation** — generates provider-neutral JSON Schema tool definitions shaped by the evaluated policy, then formats them for your provider. A resource with `read: false` produces no tools at all. A required field that's denied from writes means `create_` is suppressed entirely — not silently broken.
4. **Execution** — when the LLM calls a tool, ormai re-evaluates policy, merges the policy filter into the IR, and executes via the adapter. Forced write fields are injected at execution time, not from LLM input.

---

## Installation

```bash
npm install ormai @prisma/client
npm install -D @prisma/internals
```

Requires Prisma 5+. The `ai` peer dependency is optional — only needed for `ormai.tools.vercel()`.

---

## Setup

```ts
import { ORMAI, PrismaAdapter } from "ormai"
import type { DefaultContext, InferResources } from "ormai"
import { PrismaClient } from "@prisma/client"

const prisma = new PrismaClient()

const ormai = new ORMAI<DefaultContext, InferResources<typeof prisma>>({
  adapter: new PrismaAdapter(prisma, "./prisma/schema.prisma"),
  defaultPolicy: "deny-all",
})
```

`InferResources<typeof prisma>` converts your Prisma model keys (`orderItem`) to ormai resource names (`order_item`). You get autocomplete and type errors on policy keys with no manual type declarations.

---

## Schema annotations

Use `///` doc comments to give the LLM better context, and mark fields that must never leave the server:

```prisma
/// @ormai:description "A customer purchase order"
model Order {
  id        String      @id @default(uuid())
  status    OrderStatus
  tenant_id String
  user_id   String

  /// @ormai:description "Order total in cents"
  total     Decimal

  /// @ormai:sensitive
  internal_notes String?  // stripped at introspection — never in tool schemas or results
}
```

`@ormai:sensitive` is enforced before policy runs. The field doesn't appear in tool schemas, call arguments, or query results — regardless of what the policy says.

---

## Policies

`read`, `write`, and `delete` each accept:

- `true` — allow
- `false` — deny (no tool generated, nothing to call)
- `{ field: value }` — for `read`/`delete`: row-level WHERE always AND-ed in; for `write`: forced into INSERT data and AND-ed into UPDATE/DELETE WHERE

```ts
// Everything defaults to the tenant scope
ormai.policy("*", (ctx) => ({
  read:   { tenant_id: ctx.tenant.id },
  write:  { tenant_id: ctx.tenant.id },
  delete: false,
}))

// order: role-dependent field access and relation expansion
ormai.policy("order", (ctx) => ({
  read:   { tenant_id: ctx.tenant.id },
  write:  { tenant_id: ctx.tenant.id },
  delete: false,
  fields: {
    deny: ctx.user.role === "support" ? ["user_id"] : [],
  },
  relations: {
    customer: ctx.user.role === "admin",
    items: true,
  },
}))

// user: read-only. No create_user / update_user tools generated at all.
ormai.policy("user", (ctx) => ({
  read:   { tenant_id: ctx.tenant.id },
  write:  false,
  delete: false,
}))

// order_item: not directly queryable — only reachable as an order relation
ormai.policy("order_item", () => ({ read: false }))
```

For dynamic policy resolution:

```ts
new ORMAI({
  resolvePolicy: (resource, ctx) => ({ ... }),
})
```

---

## Generated tools

For each resource, ormai generates up to six tools depending on what the policy allows:

| Tool | Operation |
|---|---|
| `query_{resource}` | findMany with filters, sort, pagination, includes |
| `get_{resource}` | findOne by id |
| `create_{resource}` | insert one row |
| `update_{resource}` | update by id |
| `delete_{resource}` | delete by id |
| `aggregate_{resource}` | count/sum/avg/min/max with optional groupBy |

Fields with database defaults (`@default(now())`, `@default(uuid())`) are not required in create tools. If a required field is denied by the policy and not covered by forced write fields, `create_` is suppressed entirely — the tool won't appear in the LLM's tool list.

---

## Tool formats / providers

```ts
// Vercel AI SDK — drops straight into generateText / streamText
const tools = await ormai.tools.vercel(ctx)
const { text } = await generateText({ model, tools, maxSteps: 5, prompt })

// Anthropic
const tools = await ormai.tools.anthropic(ctx)
await anthropic.messages.create({
  tools: tools.map(t => t.definition), // { name, description, input_schema }
})
const result = await tools.find(t => t.name === block.name)!.execute(block.input)

// OpenAI
const tools = await ormai.tools.openai(ctx)
await openai.chat.completions.create({
  tools: tools.map(t => t.definition), // { type: "function", function: {...} }
})

// Any other provider
const tools = await ormai.tools.format(ctx, (t) => ({
  name: t.name,
  description: t.description,
  schema: t.parameters,
}))
```

Tool errors are caught and returned as `{ error }` so the agent can recover rather than abort.

---

## Observability

```ts
const ormai = new ORMAI({
  onQuery: ({ toolName, resource, durationMs, error }) => {
    logger.info({ toolName, resource, durationMs })
    if (error) logger.error({ toolName, error: error.message })
  },
})
```

---

## Security properties

- Policy row filters are AND-ed server-side into every query. The LLM can send `{ tenant_id: "other-tenant" }` in a filter — it gets overwritten.
- `update` and `delete` run as `updateMany`/`deleteMany` with the full policy WHERE. A guessed cross-tenant ID affects 0 rows.
- `write: { tenant_id }` is injected into INSERT data **and** AND-ed into UPDATE/DELETE WHERE. There is no argument the LLM can pass to write to a different tenant.
- `false` on any operation means no tool is generated. Nothing to call.
- `@ormai:sensitive` fields are stripped before policy runs — they never appear in schemas, arguments, or results.
- `belongsTo` relation results enforce the related record's row filter post-fetch — no cross-tenant data through joins.
- If a required DB field is denied in a write policy and not force-injected, the `create_` tool is suppressed, not silently broken.

---

## Other ORMs

Prisma is the only built-in adapter today. Everything above it — policies, tool generation, the query IR, serialization — is ORM-agnostic. An adapter is two methods:

```ts
import type { ORMAIAdapter, SchemaMap, ResolvedQuery } from "ormai"

class MyOrmAdapter implements ORMAIAdapter {
  async introspect(): Promise<SchemaMap> { /* describe your schema */ }
  async execute(query: ResolvedQuery): Promise<unknown> { /* run the query */ }
}

const ormai = new ORMAI({ adapter: new MyOrmAdapter() })
```

`SchemaMap`, `ResolvedQuery`, and `FilterNode` are all exported. The [`PrismaAdapter`](src/adapters/prisma.ts) is a reference implementation.

---

## Example

[`examples/ecommerce/`](examples/ecommerce/) — a full working demo with three users (admin, support, cross-tenant) issuing the same prompts and getting back exactly what their context allows. Includes a stress-test suite that verifies tenant isolation, sensitive field exclusion, write policy enforcement, and role-based field denial.

---

## License

MIT
