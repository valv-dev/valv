import type { NeutralTool } from "../formatters"
import type { FnDef } from "../functions"
import { ValidationError } from "../errors"
import { buildQuerySchema, mutationSchema } from "./query-schema"
import { listResources, searchResources, describeResource, type VisibleResource } from "./discovery"

// Which tools to expose. `query` is always present; the three discovery tools
// default ON (set false to drop); the three write tools default OFF (set true to
// add) since writes are opt-in.
export interface ToolToggle {
  list?: boolean
  search?: boolean
  describe?: boolean
  create?: boolean
  update?: boolean
  delete?: boolean
}

export interface BuildToolsArgs<TContext> {
  ctx: TContext
  visible: VisibleResource[]
  functions: Record<string, FnDef>
  run: (query: unknown, ctx: TContext) => Promise<unknown>
  write?: {
    create: (input: unknown) => Promise<unknown>
    update: (input: unknown) => Promise<unknown>
    delete: (input: unknown) => Promise<unknown>
  }
  toggle?: ToolToggle
}

const QUERY_DESCRIPTION =
  "Run a structured analytics query rooted at one resource (`from`). Provide `select` (columns " +
  "and/or aggregate functions) and optionally `where`, `groupBy`, `orderBy`, and `limit`. A column " +
  'is written `{ "col": "name" }`, both as a select item and inside a function\'s `args` — e.g. ' +
  '`{ "fn": "sum", "args": [{ "col": "amount" }], "as": "total" }`. `count` over all rows takes no ' +
  'args: `{ "fn": "count", "args": [], "as": "n" }`. Group or order by a select alias to bucket ' +
  "over time or rank by an aggregate. To read columns from a related resource, set `rel` to the " +
  'relation path from the root, e.g. `{ "col": "name", "rel": ["customer"] }` or, multiple hops, ' +
  '`{ "col": "name", "rel": ["order", "customer"] }`. The join is built automatically from the ' +
  "schema's relations — only declared relations are joinable. Use describe_resource to learn a " +
  "resource's exact columns and relations before querying.\n\n" +
  '`where` is an Expr tree, not a raw string: a comparison is `{ "kind": "cmp", "op": ">=", ' +
  '"left": { "col": "amount" }, "right": 100 }` — operands are Exprs, a column as `{ "col": ' +
  '"name" }` and a literal as a bare scalar — composable with `{ "kind": "and"/"or", "args": ' +
  '[...] }` and `{ "kind": "not", "arg": ... }`. For pattern matching use `op` "like" ' +
  '(case-sensitive) or "ilike" (case-insensitive) with a string pattern, where % matches any ' +
  'run of characters and _ matches one — e.g. `{ "kind": "cmp", "op": "ilike", "left": { "col": ' +
  '"name" }, "right": "%acme%" }`; wrap in a "not" node to exclude.\n' +
  "Example — total revenue per paid day, busiest first:\n" +
  '`{ "from": "order", "select": [' +
  '{ "fn": "dateTrunc", "args": [{ "col": "created_at" }, "day"], "as": "day" }, ' +
  '{ "fn": "sum", "args": [{ "col": "amount" }], "as": "revenue" }], ' +
  '"where": { "kind": "cmp", "op": "=", "left": { "col": "status" }, "right": "paid" }, ' +
  '"groupBy": ["day"], "orderBy": [{ "col": "revenue", "dir": "desc" }] }`'

const LIST_DESCRIPTION = "List the resources you can query, each with a short description."

const SEARCH_DESCRIPTION =
  "Search resources by keyword across their names, columns, and descriptions. Use this to find " +
  "the right resource when there are many."

const DESCRIBE_DESCRIPTION =
  "Describe a resource: its columns and types, and its relations to other resources. Call this " +
  'before querying to learn the exact column names — each is referenced as `{ "col": "name" }`.'

const CREATE_DESCRIPTION =
  "Insert a row into a resource. Provide `from` and `values` (column → value). Server-owned " +
  "fields are set automatically; you can't set columns you aren't allowed to write."

const UPDATE_DESCRIPTION =
  "Update rows. Provide `from`, `set` (column → value), and a `where` filter (required). `where` " +
  "is the same Expr tree the query tool uses, e.g. " +
  '`{ "kind": "cmp", "op": "=", "left": { "col": "id" }, "right": 42 }`. Only rows within your ' +
  "access are affected, regardless of the filter."

const DELETE_DESCRIPTION =
  "Delete rows matching a required `where` filter (the same Expr tree the query tool uses). Only " +
  "rows within your access are affected."

// A drop-in system-prompt block explaining how to drive the valv tools. The
// tool schemas already carry the query grammar; this is the workflow around
// them. `Valv.instructions(ctx)` appends the caller's visible resources.
export const AGENT_INSTRUCTIONS =
  "You answer questions by querying a set of resources through the provided tools. Access is " +
  "enforced server-side: every query is scoped to what the current caller may read, so you never " +
  "need to add tenant/owner/permission filters yourself — a query returns only permitted rows.\n\n" +
  "Workflow:\n" +
  "1. Find the resource: use list_resources / search_resources; you often already have the list " +
  "below.\n" +
  "2. Before querying an unfamiliar resource, call describe_resource to get its exact column names, " +
  "types, and relations. Don't guess column names.\n" +
  "3. Query with the `query` tool. Do the work in the query — filter with `where`, aggregate with " +
  "functions, `groupBy`, `orderBy`, `limit` — rather than pulling raw rows and reducing yourself.\n" +
  "4. Read a joined resource's columns by setting `rel` to its relation path from the root; only " +
  "declared relations join.\n\n" +
  "Grammar reminders (the tool schemas have the full shapes): a column is always `{ \"col\": " +
  '"name" }` — never a bare string — everywhere it appears (select, function `args`, `where`). ' +
  "`where` is an Expr tree of `cmp`/`and`/`or`/`not` nodes over columns and literal values, not a " +
  "raw string. A `cmp` op is one of =, !=, >, <, >=, <=, or \"like\"/\"ilike\" for pattern matching " +
  "(% = any run, _ = one char; \"ilike\" is case-insensitive).\n\n" +
  "If a call is rejected, read the error and fix the query — don't retry the same shape."

const NO_INPUT = { type: "object", properties: {}, additionalProperties: false } as const

export function buildTools<TContext>(args: BuildToolsArgs<TContext>): NeutralTool[] {
  const { ctx, visible, functions, run, write, toggle } = args
  const visibleNames = new Set(visible.map((v) => v.resource.name))
  const tools: NeutralTool[] = []

  if (toggle?.list !== false) {
    tools.push({
      name: "list_resources",
      description: LIST_DESCRIPTION,
      parameters: NO_INPUT,
      execute: async () => listResources(visible),
    })
  }

  if (toggle?.search !== false) {
    tools.push({
      name: "search_resources",
      description: SEARCH_DESCRIPTION,
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
      execute: async (input) => searchResources(readString(input, "query"), visible),
    })
  }

  if (toggle?.describe !== false) {
    tools.push({
      name: "describe_resource",
      description: DESCRIBE_DESCRIPTION,
      parameters: {
        type: "object",
        properties: { resource: { type: "string" } },
        required: ["resource"],
        additionalProperties: false,
      },
      execute: async (input) => {
        const name = readString(input, "resource")
        const match = visible.find((v) => v.resource.name === name)
        if (!match) throw new ValidationError(`Resource "${name}" is not accessible.`)
        return describeResource(match, visibleNames)
      },
    })
  }

  tools.push({
    name: "query",
    description: QUERY_DESCRIPTION,
    parameters: buildQuerySchema(functions),
    execute: (input) => run(input, ctx),
  })

  // Write tools — opt-in (default off).
  if (toggle?.create && write) {
    tools.push({
      name: "create",
      description: CREATE_DESCRIPTION,
      parameters: mutationSchema("create"),
      execute: write.create,
    })
  }
  if (toggle?.update && write) {
    tools.push({
      name: "update",
      description: UPDATE_DESCRIPTION,
      parameters: mutationSchema("update"),
      execute: write.update,
    })
  }
  if (toggle?.delete && write) {
    tools.push({
      name: "delete",
      description: DELETE_DESCRIPTION,
      parameters: mutationSchema("delete"),
      execute: write.delete,
    })
  }

  return tools
}

function readString(input: unknown, key: string): string {
  if (typeof input === "object" && input !== null && key in input) {
    const value = (input as Record<string, unknown>)[key]
    if (typeof value === "string") return value
  }
  throw new ValidationError(`Tool input must include a string "${key}".`)
}
