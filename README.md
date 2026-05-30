# ormai

Give an LLM agent access to your database. Control exactly what it can see and do.

ormai sits between your agent and your ORM. It reads your schema, you write access policies, it generates the tools. The LLM never touches SQL — it only calls what you've explicitly allowed, filtered down to what the current user is permitted to see.

It's **ORM-agnostic** (Prisma is the built-in adapter today; the adapter contract is small enough to wrap any ORM — see [Other ORMs](#other-orms)) and **provider-agnostic** — the same tools come out shaped for Anthropic, OpenAI, Google Gemini, or the Vercel AI SDK (see [Tool formats](#tool-formats--providers)).

```ts
const ormai = new ORMAI<DefaultContext, InferResources<typeof prisma>>({
  adapter: new PrismaAdapter(prisma, "./prisma/schema.prisma"),
  defaultPolicy: "deny-all",
})

ormai.policy("order", (ctx) => ({
  read: { tenant_id: ctx.tenant.id },   // row-level filter, always injected
  write: { tenant_id: ctx.tenant.id },  // forced into data, guards updates too
  delete: false,
  fields: {
    deny: ctx.user.role === "support" ? ["user_id"] : [],
  },
  relations: {
    customer: ctx.user.role === "admin",
    items: true,
  },
}))

const tools = await ormai.executableTools(ctx)
// hand `tools` to your LLM framework of choice
```

---

## How it works

1. **Introspection** — on first call, ormai parses your `schema.prisma` using `@prisma/internals`. No DB connection needed.
2. **Policy evaluation** — for the current request context, it evaluates each resource policy and determines which operations, fields, and relations are accessible.
3. **Tool generation** — it generates provider-neutral JSON Schema tool definitions shaped by the evaluated policy, then formats them for your LLM provider (Anthropic, OpenAI, Gemini, Vercel AI SDK, or a custom formatter). A resource with `read: false` produces no tools at all.
4. **Execution** — when the LLM calls a tool, ormai validates the input, re-evaluates policy, builds an IR with policy filters already merged, and executes via the adapter. The LLM cannot produce a query that escapes the policy filters.

---

## Installation

```bash
npm install ormai @prisma/client
npm install -D @prisma/internals
```

ormai requires Prisma 5+.

---

## Setup

```ts
import { ORMAI, PrismaAdapter, InferResources } from "ormai"
import type { DefaultContext } from "ormai"
import { PrismaClient } from "@prisma/client"

const prisma = new PrismaClient()

const ormai = new ORMAI<DefaultContext, InferResources<typeof prisma>>({
  adapter: new PrismaAdapter(prisma, "./prisma/schema.prisma"),
  defaultPolicy: "deny-all",
})
```

`InferResources<typeof prisma>` is a type-level transform that converts your Prisma client's model keys (`orderItem`) to ormai resource names (`order_item`). It gives you autocomplete and type errors on policy keys — no manual type declarations needed.

---

## Schema annotations

Annotate your Prisma schema with `///` doc comments to give the LLM better context, and mark fields that should never leave the server:

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

  customer  User        @relation(fields: [user_id], references: [id])
  items     OrderItem[]
}
```

---

## Policies

A policy function receives the current context and returns what's allowed for that resource. Here's a realistic multi-resource setup:

```ts
// Baseline: every resource scoped to the caller's tenant.
// With defaultPolicy: "deny-all", anything without a policy produces zero tools.
ormai.policy("*", (ctx) => ({
  read:   { tenant_id: ctx.tenant.id },
  write:  { tenant_id: ctx.tenant.id }, // injected into INSERT data; AND-ed into UPDATE WHERE
  delete: false,
}))

// order — role-dependent field access and relation expansion on top of the base
ormai.policy("order", (ctx) => ({
  read:   { tenant_id: ctx.tenant.id },
  write:  { tenant_id: ctx.tenant.id },
  delete: false,
  fields: {
    deny: ctx.user.role === "support" ? ["user_id"] : [],
  },
  relations: {
    customer: ctx.user.role === "admin", // support can't expand to the full user record
    items: true,
  },
}))

// user — read-only; no create_user / update_user tools generated at all
ormai.policy("user", (ctx) => ({
  read:   { tenant_id: ctx.tenant.id },
  write:  false,
  delete: false,
}))

// order_item — not directly queryable; only reachable as an order relation
ormai.policy("order_item", () => ({ read: false }))
```

**`read`, `write`, `delete`** accept:

- `true` — allow
- `false` — deny (`false` on an operation means no tool for it is generated — there's nothing for the LLM to call)
- `{ field: value }` — for `read`/`delete`: row-level WHERE filter always AND-ed with the query; for `write`: forced fields merged into data AND used as a WHERE guard on updates

The policy filter cannot be overridden. The LLM can pass `{ tenant_id: "other-tenant" }` in a filter — ormai's AND overwrites it.

**Fields** marked `@ormai:sensitive` are stripped at introspection time — they don't appear in tool schemas, arguments, or results, regardless of what the policy says.

For more control than the wildcard, use `resolvePolicy` in the config:

```ts
new ORMAI({
  resolvePolicy: (resource, ctx) => ({
    read: { tenant_id: ctx.tenant.id },
    write: false,
    delete: false,
  }),
})
```

---

## Tool formats / providers

`ormai.tools.<provider>(ctx)` returns the tools formatted for that provider. Built-in: `anthropic`, `openai`, `gemini`, `vercel`.

**Vercel AI SDK** is the simplest — it returns a ready-to-use `ToolSet` that drops straight into `generateText`:

```ts
const tools = await ormai.tools.vercel(ctx)

const { text } = await generateText({ model, tools, maxSteps: 5, prompt })
```

Tool errors are caught and returned as `{ error }` so the agent can recover rather than abort. Requires `npm install ai`.

**Every other provider** follows the same pattern: `.definition` is the provider-specific shape; `.execute(args)` runs the call with policy enforced and results serialized (`Decimal` → number, `Date` → ISO string, `BigInt` → string):

```ts
// Anthropic
const tools = await ormai.tools.anthropic(ctx)
await anthropic.messages.create({
  model: "claude-opus-4-8",
  messages,
  tools: tools.map(t => t.definition), // { name, description, input_schema }
})
// dispatch a tool_use block:
const result = await tools.find(t => t.name === block.name)!.execute(block.input)

// OpenAI
const tools = await ormai.tools.openai(ctx)
await openai.chat.completions.create({
  model: "gpt-4o",
  messages,
  tools: tools.map(t => t.definition), // { type: "function", function: {...} }
})
// dispatch:
const result = await tools.find(t => t.name === call.function.name)!
  .execute(JSON.parse(call.function.arguments))

// Gemini: t.definition is a function declaration
const tools = await ormai.tools.gemini(ctx)
// wrap as: { functionDeclarations: tools.map(t => t.definition) }
```

**Any other provider** — pass a formatter:

```ts
const tools = await ormai.tools.format(ctx, (t) => ({
  // t: NeutralTool { name, description, parameters }
  name: t.name,
  description: t.description,
  schema: t.parameters,
}))
```

> The original flat helpers are still available: `ormai.getTools(ctx)` (Anthropic `input_schema` shape) and `ormai.executableTools(ctx)` (same, with `execute()` attached).

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

Fields with database defaults (`@default(now())`, `@default(uuid())`) are not required in create tools. The LLM doesn't need to supply them.

---

## Observability

```ts
const ormai = new ORMAI({
  // ...
  onQuery: ({ toolName, resource, operation, ctx, durationMs, error }) => {
    logger.info({ toolName, resource, operation, durationMs, userId: ctx.user.id })
    if (error) logger.error({ toolName, error: error.message })
  },
})
```

---

## Discovering resource names

Resource names are derived from Prisma model names: `PascalCase` → `singular_snake_case` (`OrderItem` → `order_item`). If you typo a policy key, ormai warns you at runtime with the list of valid names.

To see all resources and their fields programmatically:

```ts
const info = await ormai.describe()
// Returns: name, fields, relations, and a ready-to-paste policy stub for each resource
```

---

## Security properties

- Policy row filters are merged server-side and AND-ed into every query. The LLM can request `{ tenant_id: "other-tenant" }` — it gets overwritten.
- `update` and `delete` run as `updateMany`/`deleteMany` with the full policy WHERE. A guessed cross-tenant ID affects 0 rows.
- `write: { tenant_id }` is injected into INSERT data **and** AND-ed into UPDATE/DELETE WHERE clauses. There's no argument the LLM can pass to write to a different tenant.
- `false` on any operation means no tool is generated. There's nothing to call.
- `@ormai:sensitive` fields are stripped before policy runs — they never appear in tool schemas, call arguments, or results.
- `belongsTo` relation includes enforce the related record's row filter post-fetch — no cross-tenant data through joins.

---

## Other ORMs

Prisma is the only built-in adapter today, but ormai is not tied to it. Everything above the adapter — policies, tool generation, the query IR, serialization — is ORM-agnostic. An adapter is just two methods:

```ts
import type { ORMAIAdapter, SchemaMap, ResolvedQuery } from "ormai"

class MyOrmAdapter implements ORMAIAdapter {
  // Describe your schema as resources, fields, and relations.
  async introspect(): Promise<SchemaMap> { /* ... */ }

  // Run a resolved, policy-checked query. Filters are already merged in.
  async execute(query: ResolvedQuery): Promise<unknown> { /* ... */ }
}

const ormai = new ORMAI({ adapter: new MyOrmAdapter() })
```

`SchemaMap`, `ResolvedQuery`, and `FilterNode` are all exported so an adapter can map ormai's neutral query into its own ORM's calls. The `PrismaAdapter` in [`src/adapters/prisma.ts`](src/adapters/prisma.ts) is a reference implementation.

---

## Example

See [`examples/ecommerce/`](examples/ecommerce/) for a full working demo: three users (admin, support, cross-tenant) asking the same question, getting back different data based on their context.

---

## License

MIT
