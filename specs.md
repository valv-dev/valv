# ORMAI — Spec v0.2
## ORM + Access Control Layer for AI Agents (Prisma)

---

## What it does

A TypeScript library that sits between an LLM agent and a Prisma database. It:

1. Introspects a Prisma schema automatically (no codegen step)
2. Lets the developer define per-resource access control policies
3. Generates typed LLM tools from the schema + policies
4. Accepts tool calls from the LLM, enforces policy, builds a safe IR, executes via Prisma

The LLM never writes SQL. It never sees the raw schema. It only sees the tools ORMAI generates for it, shaped by the current user's policy context.

---

## Project structure

```
ormai/
├── src/
│   ├── index.ts                  # public API exports
│   ├── ormai.ts                  # ORMAI core class
│   ├── types.ts                  # shared types, InferResources helper
│   ├── serializer.ts             # Decimal/Date/BigInt → JSON-safe values
│   ├── errors.ts                 # PolicyViolationError, ValidationError
│   ├── ir/
│   │   ├── types.ts              # IR node type definitions
│   │   └── builder.ts            # builds ResolvedQuery from tool call + policy
│   ├── policy/
│   │   └── engine.ts             # evaluates policy, merges filters, strips fields
│   ├── introspection/
│   │   └── prisma.ts             # parses schema.prisma into SchemaMap
│   ├── tools/
│   │   └── generator.ts          # generates LLM tool definitions from SchemaMap + policy
│   └── adapters/
│       └── prisma.ts             # translates ResolvedQuery → Prisma client calls
├── tests/
│   ├── policy.test.ts
│   ├── ir.test.ts
│   ├── tools.test.ts
│   └── prisma-adapter.test.ts
├── examples/
│   └── ecommerce/                # end-to-end demo with real Postgres
├── package.json
└── tsconfig.json
```

---

## Types (`src/types.ts`)

```ts
export interface SchemaMap {
  resources: Record<string, ResourceSchema>
}

export interface ResourceSchema {
  name: string           // "order_item" (snake_case, derived from Prisma model name)
  tableName: string      // "OrderItem" (original Prisma model name)
  fields: Record<string, FieldSchema>
  relations: Record<string, RelationSchema>
  description?: string   // from /// @ormai:description annotations
}

export interface FieldSchema {
  name: string
  type: FieldType
  isNullable: boolean
  isId: boolean
  hasDefaultValue?: boolean  // true for @default(now()), @default(uuid()), etc.
  enumValues?: string[]      // populated when type is "enum"
  description?: string       // from /// @ormai:description annotations
  sensitive?: boolean        // from /// @ormai:sensitive annotations
}

export type FieldType =
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "enum"
  | "uuid"
  | "json"

export interface RelationSchema {
  name: string
  targetResource: string
  type: "belongsTo" | "hasMany" | "manyToMany"
  foreignKey: string
  junctionTable?: string
}

export type PolicyFn<TContext = DefaultContext> =
  (ctx: TContext) => PolicyResult

export interface PolicyResult {
  read?:   boolean | Record<string, unknown>  // true=allow, false=deny, object=row filter
  write?:  boolean | Record<string, unknown>  // object=forced write fields + update guard
  delete?: boolean | Record<string, unknown>
  fields?: FieldPolicy
  relations?: Record<string, boolean>
}

export interface FieldPolicy {
  allow?: string[]  // whitelist
  deny?: string[]   // blacklist
}

export interface DefaultContext {
  user: { id: string; role: string; [key: string]: unknown }
  tenant?: { id: string; [key: string]: unknown }
  [key: string]: unknown
}

// Derives ormai resource names from a Prisma client type.
// Converts camelCase model accessors to snake_case resource names.
// Usage: new ORMAI<DefaultContext, InferResources<typeof prisma>>({ ... })
export type InferResources<TClient> = _CamelToSnake<
  Exclude<keyof TClient, `$${string}` | symbol | number> & string
>
```

---

## IR Types (`src/ir/types.ts`)

The IR is the internal representation of a query after policy has been applied. Adapters receive this and translate it to ORM calls. Policy is never re-evaluated after this point.

```ts
export interface ResolvedQuery {
  resource: string
  operation: "find" | "findOne" | "create" | "update" | "delete" | "aggregate"
  filters?: FilterNode       // merged: policy row filter AND(ed) with LLM filter
  fields: string[]           // already stripped by field policy
  include?: Record<string, ResolvedInclude>
  sort?: SortClause
  pagination?: PaginationClause
  aggregations?: AggregationClause[]
  groupBy?: string[]
  having?: FilterNode
  data?: Record<string, unknown>  // for create/update; forced write fields already merged
}

export interface ResolvedInclude {
  resource: string
  type: "belongsTo" | "hasMany" | "manyToMany"
  foreignKey: string
  fields: string[]
  filters?: FilterNode  // related resource's own policy filters
}

export type FilterNode =
  | EqFilter | InFilter | RangeFilter | LikeFilter
  | NullFilter | AndFilter | OrFilter | NotFilter

// ... filter types as before
```

---

## Core class API (`src/ormai.ts`)

```ts
export interface ORMAIConfig<TContext = DefaultContext, TResources extends string = string> {
  adapter: ORMAIAdapter
  defaultPolicy?: "deny-all" | "allow-all"    // default: "deny-all"
  strictPolicyKeys?: boolean                   // throw (true) or warn (false) on unknown keys
  resolvePolicy?: (resource: TResources, ctx: TContext) => PolicyResult
  onQuery?: (event: QueryEvent<TContext, TResources>) => void
}

export interface QueryEvent<TContext, TResources extends string = string> {
  toolName: string
  resource: TResources
  operation: string
  ctx: TContext
  durationMs: number
  error?: Error
}

export class ORMAI<TContext = DefaultContext, TResources extends string = string> {
  constructor(config: ORMAIConfig<TContext, TResources>)

  // Register a policy for a resource. "*" acts as a wildcard fallback.
  policy(resource: TResources | "*", fn: PolicyFn<TContext>): this

  // Generate LLM tool definitions shaped by the current context's policy.
  // Auto-loads and caches the schema on first call.
  async getTools(ctx: TContext, options?: GetToolsOptions<TResources>): Promise<LLMTool[]>

  // Like getTools() but with execute() attached and result serialization built in.
  async executableTools(ctx: TContext, options?: GetToolsOptions<TResources>): Promise<ExecutableTool[]>

  // Execute a tool call: validate → enforce policy → build IR → execute via adapter.
  async executeTool(toolName: string, input: unknown, ctx: TContext): Promise<unknown>

  // Warm up schema cache explicitly (optional — getTools/executeTool auto-load).
  async loadSchema(): Promise<SchemaMap>

  // Discovery API — useful during development to find resource names.
  async resources(): Promise<TResources[]>
  async describe(): Promise<ResourceDescriptor[]>  // includes policy stubs
}

export interface GetToolsOptions<TResources extends string = string> {
  resources?: TResources[]
  maxTools?: number
}

export interface LLMTool {
  name: string
  description: string
  input_schema: object  // JSON Schema, Anthropic-compatible
}

export interface ExecutableTool extends LLMTool {
  execute: (args: unknown) => Promise<unknown>
}
```

---

## Policy engine (`src/policy/engine.ts`)

```ts
export interface EvaluatedPolicy {
  allowed: boolean
  rowFilter?: FilterNode          // injected into every query for this resource
  allowedFields: string[]         // fields the LLM can see and query on
  allowedRelations: string[]      // relation names allowed to include
  forcedWriteFields?: Record<string, unknown>  // merged into data on create/update
}
```

**Policy result semantics:**

| Value | Meaning |
|---|---|
| `read: true` | Allow all rows |
| `read: false` | Deny entirely — resource excluded from tools |
| `read: { tenant_id: "abc" }` | Inject `WHERE tenant_id = 'abc'` into every query |
| `write: true` | Allow writes |
| `write: { tenant_id: "abc" }` | Allow writes AND force `tenant_id` into data AND guard updates with `WHERE tenant_id = 'abc'` |
| `fields.deny: ["col"]` | Strip from returned data AND from tool input schema |
| `fields.allow: ["id", "status"]` | Only these fields visible |
| `relations: { customer: false }` | Remove from `include` options in tool schema |

`@ormai:sensitive` fields in the schema are excluded from all tools and results regardless of policy.

Policy row filters are AND-ed with LLM-supplied filters. The LLM cannot override or omit a policy filter.

---

## Tool generator (`src/tools/generator.ts`)

**Generated tool names:**
```
query_{resource}      → findMany with filters/sort/pagination/include
get_{resource}        → findOne by id
create_{resource}     → insert one row
update_{resource}     → update by id
delete_{resource}     → delete by id
aggregate_{resource}  → count/sum/avg/min/max with optional groupBy
```

**Generation rules:**
- `read: false` → no tools generated for this resource
- `write` denied → no create/update tools
- `delete` denied → no delete tool
- Aggregate tool generated only if there are numeric fields in the read policy
- Fields with `hasDefaultValue: true` are excluded from `create` required list
- ID field type is inferred from schema (not hardcoded as string)
- Sensitive fields never appear in any tool schema

---

## IR builder (`src/ir/builder.ts`)

1. Parse tool name → extract `operation` and `resource`
2. Validate resource exists in schema
3. Evaluate policy for this ctx + operation
4. If not allowed → throw `PolicyViolationError`
5. Parse and validate LLM filters (enum values checked against schema)
6. Merge policy row filter AND LLM filter
7. Resolve includes — evaluate each related resource's policy independently
8. Strip denied fields
9. Merge `forcedWriteFields` into `data` (policy wins over LLM input)
10. For update: add forced write fields as WHERE guard
11. Return complete `ResolvedQuery`

**Validation errors** (always thrown, never silently ignored):
- Unknown field in filters → `ValidationError`
- Invalid enum value → `ValidationError`
- Unknown relation in include → `ValidationError`
- Operation not permitted → `PolicyViolationError`
- Invalid filter value type → `ValidationError`

---

## Prisma adapter (`src/adapters/prisma.ts`)

**Key implementation decisions:**

- Resource name → Prisma client key: snake_case → camelCase (`order_item` → `prisma.orderItem`)
- `update` uses `updateMany` with the full `where` (id + policy row filter) — ensures the row belongs to the caller's tenant before mutating. Returns `{ count: N }`.
- `delete` uses `deleteMany` with the full `where` for the same reason. Returns `{ count: N }`.
- `belongsTo` includes: Prisma doesn't support `where` on toOne relations, so the related resource's row filter is enforced post-fetch by nulling out mismatched records in memory.
- Relations are merged into Prisma's `select` (not `include`) so field selection works at all levels.

**FilterNode → Prisma where mapping:**
```
EqFilter    → { [field]: value }
InFilter    → { [field]: { in: values } }
RangeFilter → { [field]: { gte, lte, gt, lt } }
LikeFilter  → { [field]: { contains/startsWith/endsWith: value, mode: "insensitive" } }
NullFilter  → { [field]: null } or { [field]: { not: null } }
AndFilter   → { AND: [...] }
OrFilter    → { OR: [...] }
NotFilter   → { NOT: ... }
```

---

## Serializer (`src/serializer.ts`)

`serializeResult(value)` makes Prisma query results safe to send to an LLM:

- `Decimal` → `number` (duck-typed via `.toNumber()` — works even when minified)
- `Date` → ISO 8601 string
- `BigInt` → string
- Arrays and nested objects are recursed

Used automatically by `executableTools()`. Export it for use with raw `executeTool()` calls.

---

## Prisma schema annotations

```
/// @ormai:description "Human readable description for LLM tools"
/// @ormai:sensitive     → excluded from all tools and results, regardless of policy
/// @ormai:searchable    → parsed, reserved for future use
```

---

## Introspection (`src/introspection/prisma.ts`)

Uses `@prisma/internals` → `getDMMF()` to parse `schema.prisma` without a running DB.

**Prisma type mapping:**
```
String         → "string"
Int/Float/Decimal → "number"
Boolean        → "boolean"
DateTime       → "date"
Json           → "json"
Enum           → "enum" (only when type is actually in the enum map)
@id field      → isId: true
@default(...)  → hasDefaultValue: true
```

**Resource naming:** Prisma model names (PascalCase) → ormai resource names (singular snake_case):
`Order` → `order`, `OrderItem` → `order_item`

---

## Public API (`src/index.ts`)

```ts
export { ORMAI } from "./ormai"
export type { LLMTool, ExecutableTool, GetToolsOptions, QueryEvent,
              ResourceDescriptor, ORMAIAdapter, ORMAIConfig } from "./ormai"
export { PrismaAdapter } from "./adapters/prisma"
export { serializeResult } from "./serializer"
export type { PolicyFn, PolicyResult, DefaultContext, SchemaMap,
              ResourceSchema, FieldSchema, InferResources } from "./types"
export type { ResolvedQuery, FilterNode } from "./ir/types"
export { PolicyViolationError, ValidationError } from "./errors"
```

---

## Usage

```ts
import { ORMAI, PrismaAdapter, InferResources } from "ormai"
import type { DefaultContext } from "ormai"
import { PrismaClient } from "@prisma/client"

const prisma = new PrismaClient()

// InferResources derives resource names from the Prisma client type.
// policy() keys and getTools() options are type-checked against it.
const ormai = new ORMAI<DefaultContext, InferResources<typeof prisma>>({
  adapter: new PrismaAdapter(prisma, "./prisma/schema.prisma"),
  defaultPolicy: "deny-all",
  onQuery: ({ toolName, durationMs, error }) => {
    console.log(`[audit] ${toolName} (${durationMs}ms)${error ? " ERROR" : ""}`)
  },
})

ormai.policy("order", (ctx) => ({
  read: { tenant_id: ctx.tenant!.id },
  write: { tenant_id: ctx.tenant!.id },  // forces tenant_id into data, guards updates
  delete: false,
  fields: {
    deny: ctx.user.role === "support" ? ["user_id"] : [],
  },
  relations: {
    customer: ctx.user.role === "admin",
    items: true,
  },
}))

// In your API handler / agent session:
const ctx = { user: req.user, tenant: req.tenant }

// executableTools() auto-loads schema, attaches execute(), serializes results
const tools = await ormai.executableTools(ctx)

// Connect to your LLM framework:
const llmTools = Object.fromEntries(tools.map(t => [t.name, {
  description: t.description,
  parameters: t.input_schema,
  execute: t.execute,
}]))
```

---

## What's out of scope

- Adapters other than Prisma
- Cursor-based pagination (offset only)
- Natural language / JQL interfaces
- Multi-language ports
- Nested includes beyond one level deep
- GraphQL / REST exposure

---

## Definition of done

- [x] `ormai.getTools(ctx)` returns valid Anthropic-compatible tool definitions shaped by policy
- [x] `ormai.executeTool(name, input, ctx)` executes correctly against Prisma + Postgres
- [x] Policy row filters always injected — cannot be bypassed by LLM input
- [x] Denied fields never appear in tool schemas or query results
- [x] `write: { field: value }` forces fields into create data and guards updates
- [x] `update`/`delete` enforce policy row filter via `updateMany`/`deleteMany`
- [x] `belongsTo` includes enforce related resource's row filter post-fetch
- [x] Multi-word models work (`OrderItem` → `prisma.orderItem`)
- [x] Fields with DB defaults not required in create tools
- [x] Enum filter values validated against schema
- [x] `InferResources<typeof prisma>` derives type-safe resource names from Prisma client
- [x] `executableTools()` returns tools with execute() and serialization built in
- [x] `policy("*", fn)` wildcard and `resolvePolicy` config for broad coverage
- [x] `onQuery` audit hook
- [x] `aggregate_*` tools with Prisma groupBy support
- [x] All 66 unit tests pass
- [x] Ecommerce example works end-to-end against real Postgres
