import type { NeutralTool } from "../formatters"
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
  functionNames: string[]
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
  "and/or aggregate functions) and optionally `where`, `groupBy`, `orderBy`, and `limit`. Group " +
  "or order by a select alias to bucket over time or rank by an aggregate. To read columns from a " +
  "related resource, set `rel` to the relation path from the root, e.g. " +
  '`{ "col": "name", "rel": ["customer"] }` or, multiple hops, `{ "col": "name", "rel": ' +
  '["order", "customer"] }`. The join is built automatically from the schema\'s relations — only ' +
  "declared relations are joinable. Use describe_resource to learn a resource's exact columns and " +
  "relations before querying."

const LIST_DESCRIPTION = "List the resources you can query, each with a short description."

const SEARCH_DESCRIPTION =
  "Search resources by keyword across their names, columns, and descriptions. Use this to find " +
  "the right resource when there are many."

const DESCRIBE_DESCRIPTION =
  "Describe a resource: its columns and types, and its relations to other resources. Call this " +
  "before querying to learn the exact column names."

const CREATE_DESCRIPTION =
  "Insert a row into a resource. Provide `from` and `values` (column → value). Server-owned " +
  "fields are set automatically; you can't set columns you aren't allowed to write."

const UPDATE_DESCRIPTION =
  "Update rows. Provide `from`, `set` (column → value), and a `where` filter (required). Only " +
  "rows within your access are affected, regardless of the filter."

const DELETE_DESCRIPTION =
  "Delete rows matching a required `where` filter. Only rows within your access are affected."

const NO_INPUT = { type: "object", properties: {}, additionalProperties: false } as const

export function buildTools<TContext>(args: BuildToolsArgs<TContext>): NeutralTool[] {
  const { ctx, visible, functionNames, run, write, toggle } = args
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
    parameters: buildQuerySchema(functionNames),
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
