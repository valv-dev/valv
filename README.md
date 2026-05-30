# ormai

Give an LLM agent access to your database. Control exactly what it can see and do.

ormai sits between your agent and Prisma. It reads your schema, you write access policies, it generates the tools. The LLM never touches SQL — it only calls what you've explicitly allowed, filtered down to what the current user is permitted to see.

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
3. **Tool generation** — it generates JSON Schema tool definitions (Anthropic-compatible) shaped by the evaluated policy. A resource with `read: false` produces no tools at all.
4. **Execution** — when the LLM calls a tool, ormai validates the input, re-evaluates policy, builds an IR with policy filters already merged, and executes via Prisma. The LLM cannot produce a query that escapes the policy filters.

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

## Policies

A policy function receives the current context and returns what's allowed for that resource:

```ts
ormai.policy("order", (ctx) => ({
  read:   { tenant_id: ctx.tenant.id },  // WHERE clause always injected
  write:  { tenant_id: ctx.tenant.id },  // forced into INSERT/UPDATE data
  delete: false,
  fields: {
    deny: ["internal_notes"],            // never sent to LLM
  },
  relations: {
    items:    true,
    customer: ctx.user.role === "admin", // support users can't include customer data
  },
}))
```

**`read`, `write`, `delete`** accept:
- `true` — allow
- `false` — deny (no tools generated for this operation)
- `{ field: value }` — for `read`/`delete`: row-level WHERE filter; for `write`: forced fields merged into data AND used as a WHERE guard on updates

The policy filter is always AND-ed with whatever the LLM requests. It can't be overridden.

**Fields** marked `@ormai:sensitive` in the schema are excluded from all tools and query results regardless of what the policy says.

### Wildcard policy

For resources you want to cover without individual policies:

```ts
ormai.policy("*", (ctx) => ({
  read: { tenant_id: ctx.tenant.id },
  write: false,
  delete: false,
}))
```

Or use `resolvePolicy` in the config for more control:

```ts
new ORMAI({
  // ...
  resolvePolicy: (resource, ctx) => ({
    read: { tenant_id: ctx.tenant.id },
    write: false,
    delete: false,
  }),
})
```

---

## Connecting to an LLM framework

`executableTools()` returns tools with `execute()` attached. Results are automatically serialized (Prisma `Decimal` → number, `Date` → ISO string, `BigInt` → string).

**Vercel AI SDK:**
```ts
import { tool, jsonSchema } from "ai"

const execTools = await ormai.executableTools(ctx)
const tools = Object.fromEntries(
  execTools.map(t => [
    t.name,
    tool({
      description: t.description,
      parameters: jsonSchema(t.input_schema),
      execute: async (args) => {
        try { return await t.execute(args) }
        catch (err) { return { error: err.message } }
      },
    }),
  ])
)
```

**Anthropic SDK:**
```ts
const execTools = await ormai.executableTools(ctx)

// Pass to messages.create:
const anthropicTools = execTools.map(({ name, description, input_schema }) => ({
  name, description, input_schema,
}))

// On tool_use response:
const result = await execTools.find(t => t.name === toolUse.name)?.execute(toolUse.input)
```

---

## Schema annotations

Annotate your Prisma schema with `///` doc comments to give the LLM better descriptions:

```prisma
/// @ormai:description "A customer purchase order"
model Order {
  id     String      @id @default(uuid())
  status OrderStatus

  /// @ormai:description "Order total in cents"
  total  Decimal

  /// @ormai:sensitive
  internal_notes String?   // never exposed to LLM, regardless of policy
}
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

- The LLM never sees the raw schema or constructs queries directly
- Policy row filters are merged server-side and cannot be overridden by the LLM
- `update` and `delete` use `updateMany`/`deleteMany` with the full policy filter in the WHERE clause — guessing an ID from another tenant does nothing
- `write: { tenant_id }` forces the value into created/updated data — the LLM can't write to a different tenant even if it tries
- `belongsTo` includes enforce the related resource's row filter post-fetch
- Sensitive fields are stripped at introspection time, before policy evaluation

---

## Example

See [`examples/ecommerce/`](examples/ecommerce/) for a full working demo: three users (admin, support, cross-tenant) asking the same question, getting back different data based on their context.

---

## License

MIT
