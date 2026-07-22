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
  "Run a structured analytics query rooted at one resource (`from`), in a Prisma-like shape. " +
  "`select` is an object keyed by result name: `true` selects the column of that name, " +
  '{ "col": "path" } renames or reads a joined column, and { fn: args } aggregates or computes ' +
  "(the key names the output). Filter with `where`, and use `groupBy`, `orderBy`, and `take` — do " +
  "the work in the query rather than pulling raw rows and reducing yourself. Use describe_resource " +
  "to learn a resource's exact columns and relations before querying.\n\n" +
  "`where` is a Prisma filter: { field: value } is equality, { field: { gte: x, lt: y } } applies " +
  "operators (gt/gte/lt/lte, in, notIn, not, and contains/startsWith/endsWith for text, with " +
  '`mode: "insensitive"` for case-insensitive), and AND/OR/NOT combine sub-filters. Reach a joined ' +
  'column with a dotted key ("customer.region"); only declared relations join. Scope filters are ' +
  "enforced server-side — never add tenant/owner filters yourself.\n\n" +
  "Example — total revenue per paid day, busiest first:\n" +
  '{ "from": "order", ' +
  '"select": { "day": { "dateTrunc": ["created_at", "day"] }, "revenue": { "sum": "amount" } }, ' +
  '"where": { "status": "paid" }, "groupBy": ["day"], "orderBy": { "revenue": "desc" } }'

const LIST_DESCRIPTION = "List the resources you can query, each with a short description."

const SEARCH_DESCRIPTION =
  "Search resources by keyword across their names, columns, and descriptions. Use this to find " +
  "the right resource when there are many."

const DESCRIBE_DESCRIPTION =
  "Describe a resource: its columns and types, and its relations to other resources. Call this " +
  "before querying to learn the exact column names to use in `select` and `where`."

const CREATE_DESCRIPTION =
  "Insert a row into a resource. Provide `from` and `data` (column → value). Server-owned " +
  "fields are set automatically; you can't set columns you aren't allowed to write."

const UPDATE_DESCRIPTION =
  "Update rows. Provide `from`, `data` (column → value), and a `where` filter (required) — the " +
  'same Prisma filter the query tool uses, e.g. { "id": 42 }. Only rows within your access are ' +
  "affected, regardless of the filter."

const DELETE_DESCRIPTION =
  "Delete rows matching a required `where` filter (the same Prisma filter the query tool uses). " +
  "Only rows within your access are affected."

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
  "functions, `groupBy`, `orderBy`, `take` — rather than pulling raw rows and reducing yourself.\n" +
  "4. The grammar is Prisma-like. `select` is an object keyed by output name: `true` for a plain " +
  'column, { "col": "path" } to rename or reach a joined column, { fn: args } to aggregate (e.g. ' +
  '{ "revenue": { "sum": "amount" } }). `where` uses { field: value } for equality and ' +
  "{ field: { gte, lt, in, contains } } for operators, combined with AND/OR/NOT.\n" +
  '5. Read a joined resource\'s column with a dotted path from the root — "customer.name" — in a ' +
  "select `col` or a where key. A root column takes no dot; only declared relations join. If a " +
  'column comes back "not accessible", drop the relation prefix (it may be a root column) or call ' +
  "describe_resource to confirm where it lives — don't resubmit the same shape.\n\n" +
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
