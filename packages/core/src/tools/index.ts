import type { NeutralTool } from "../formatters"
import { ValidationError } from "../errors"
import { buildQuerySchema } from "./query-schema"
import {
  listResources,
  searchResources,
  describeResource,
  type VisibleResource,
} from "./discovery"

// Which discovery tools to expose. `query` is always present; each of the three
// discovery tools is on by default and removed by setting it false.
export interface DiscoveryToggle {
  list?: boolean
  search?: boolean
  describe?: boolean
}

export interface BuildToolsArgs<TContext> {
  ctx: TContext
  visible: VisibleResource[]
  functionNames: string[]
  run: (query: unknown, ctx: TContext) => Promise<unknown>
  toggle?: DiscoveryToggle
}

const QUERY_DESCRIPTION =
  "Run a structured analytics query against one resource. Provide `from` (a resource name), " +
  "`select` (columns and/or aggregate functions), and optionally `where`, `groupBy`, `orderBy`, " +
  "and `limit`. Group or order by a select alias to bucket over time or rank by an aggregate. " +
  "Use describe_resource to learn a resource's exact columns before querying."

const LIST_DESCRIPTION = "List the resources you can query, each with a short description."

const SEARCH_DESCRIPTION =
  "Search resources by keyword across their names, columns, and descriptions. Use this to find " +
  "the right resource when there are many."

const DESCRIBE_DESCRIPTION =
  "Describe a resource: its columns and types, and its relations to other resources. Call this " +
  "before querying to learn the exact column names."

const NO_INPUT = { type: "object", properties: {}, additionalProperties: false } as const

export function buildTools<TContext>(args: BuildToolsArgs<TContext>): NeutralTool[] {
  const { ctx, visible, functionNames, run, toggle } = args
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

  return tools
}

function readString(input: unknown, key: string): string {
  if (typeof input === "object" && input !== null && key in input) {
    const value = (input as Record<string, unknown>)[key]
    if (typeof value === "string") return value
  }
  throw new ValidationError(`Tool input must include a string "${key}".`)
}
