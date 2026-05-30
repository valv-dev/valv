import { SchemaMap, PolicyFn, FieldSchema } from "../types"
import { ResolvedQuery, ResolvedInclude, FilterNode } from "./types"
import { evaluatePolicy, mergeFilters, rowFilterFromObject } from "../policy/engine"
import { PolicyViolationError, ValidationError } from "../errors"

type OperationType = "find" | "findOne" | "create" | "update" | "delete" | "aggregate"

function parseToolName(toolName: string): { operation: OperationType; resource: string } {
  const prefixes: Array<[string, OperationType]> = [
    ["query_", "find"],
    ["get_", "findOne"],
    ["create_", "create"],
    ["update_", "update"],
    ["delete_", "delete"],
    ["aggregate_", "aggregate"],
  ]

  for (const [prefix, operation] of prefixes) {
    if (toolName.startsWith(prefix)) {
      return { operation, resource: toolName.slice(prefix.length) }
    }
  }

  throw new ValidationError(`Unknown tool name format: ${toolName}`)
}

function operationToPolicy(op: OperationType): "read" | "write" | "delete" {
  if (op === "find" || op === "findOne" || op === "aggregate") return "read"
  if (op === "delete") return "delete"
  return "write"
}

export function buildResolvedQuery<TContext>(
  toolName: string,
  input: unknown,
  schema: SchemaMap,
  policies: Record<string, PolicyFn<TContext>>,
  ctx: TContext,
  defaultPolicy: "deny-all" | "allow-all"
): ResolvedQuery {
  const { operation, resource } = parseToolName(toolName)

  const resourceSchema = schema.resources[resource]
  if (!resourceSchema) {
    throw new ValidationError(`Unknown resource: ${resource}`)
  }

  const policyOp = operationToPolicy(operation)
  const evaluated = evaluatePolicy(policies[resource], ctx, policyOp, defaultPolicy, resourceSchema)

  if (!evaluated.allowed) {
    throw new PolicyViolationError(
      `Operation "${operation}" on "${resource}" is not permitted by policy`
    )
  }

  const inp = (input ?? {}) as Record<string, unknown>

  // Parse filters from LLM input
  let llmFilter: FilterNode | undefined
  if (inp.filters && typeof inp.filters === "object") {
    llmFilter = parseFilters(inp.filters as Record<string, unknown>, evaluated.allowedFields, resource, resourceSchema.fields)
  }

  // Merge policy row filter + forced write fields (for update guard) + LLM filter
  let baseFilter = mergeFilters(evaluated.rowFilter, llmFilter)

  // Resolve includes
  let include: Record<string, ResolvedInclude> | undefined
  if (inp.include && Array.isArray(inp.include)) {
    include = {}
    for (const relationName of inp.include as string[]) {
      if (!evaluated.allowedRelations.includes(relationName)) {
        throw new ValidationError(`Relation "${relationName}" is not allowed`)
      }
      const relation = resourceSchema.relations[relationName]
      if (!relation) {
        throw new ValidationError(`Unknown relation "${relationName}" on resource "${resource}"`)
      }

      const relatedSchema = schema.resources[relation.targetResource]
      const relatedEvaluated = evaluatePolicy(policies[relation.targetResource], ctx, "read", defaultPolicy, relatedSchema)

      const relatedFields = relatedEvaluated.allowed
        ? relatedEvaluated.allowedFields
        : relatedSchema
          ? Object.values(relatedSchema.fields).filter(f => !f.sensitive).map(f => f.name)
          : []

      include[relationName] = {
        resource: relation.targetResource,
        type: relation.type,
        foreignKey: relation.foreignKey,
        fields: relatedFields,
        filters: relatedEvaluated.rowFilter,
      }
    }
  }

  const fields = evaluated.allowedFields

  const query: ResolvedQuery = {
    resource,
    operation,
    filters: baseFilter,
    fields,
    include,
  }

  // Sort
  if (inp.sort && typeof inp.sort === "object") {
    const sort = inp.sort as Record<string, unknown>
    const sortField = sort.field as string
    if (!evaluated.allowedFields.includes(sortField)) {
      throw new ValidationError(`Sort field "${sortField}" is not allowed`)
    }
    query.sort = {
      field: sortField,
      direction: (sort.direction as "asc" | "desc") ?? "asc",
    }
  }

  // Pagination
  if (inp.limit !== undefined || inp.offset !== undefined) {
    query.pagination = {
      limit: typeof inp.limit === "number" ? Math.min(inp.limit, 100) : undefined,
      offset: typeof inp.offset === "number" ? Math.max(0, inp.offset) : undefined,
    }
  }

  // Aggregations
  if (operation === "aggregate") {
    if (inp.aggregations && Array.isArray(inp.aggregations)) {
      query.aggregations = inp.aggregations as typeof query.aggregations
    }
    if (inp.groupBy && Array.isArray(inp.groupBy)) {
      const disallowed = (inp.groupBy as string[]).filter(f => !evaluated.allowedFields.includes(f))
      if (disallowed.length > 0) {
        throw new ValidationError(`groupBy fields not allowed: ${disallowed.join(", ")}`)
      }
      query.groupBy = inp.groupBy as string[]
    }
  }

  // Data for create/update
  if (operation === "create" || operation === "update") {
    const data: Record<string, unknown> = {}

    if (operation === "update" && inp.id !== undefined) {
      const idFilter: FilterNode = { type: "eq", field: "id", value: inp.id }
      query.filters = mergeFilters(baseFilter, idFilter)
    }

    for (const [key, value] of Object.entries(inp)) {
      if (["id", "filters", "include", "sort", "limit", "offset"].includes(key)) continue
      if (!evaluated.allowedFields.includes(key)) {
        throw new ValidationError(`Field "${key}" is not allowed for write`)
      }
      data[key] = value
    }

    // Forced write fields override LLM input (policy wins)
    if (evaluated.forcedWriteFields) {
      Object.assign(data, evaluated.forcedWriteFields)
      // Also add as where guard for update so only owned rows can be updated
      if (operation === "update") {
        const guardFilter = rowFilterFromObject(evaluated.forcedWriteFields)
        query.filters = mergeFilters(query.filters, guardFilter)
      }
    }

    query.data = data
  }

  // For findOne, use id as eq filter merged with policy filter
  if (operation === "findOne" && inp.id !== undefined) {
    const idFilter: FilterNode = { type: "eq", field: "id", value: inp.id }
    query.filters = mergeFilters(evaluated.rowFilter, idFilter)
  }

  return query
}

function parseFilters(
  filtersObj: Record<string, unknown>,
  allowedFields: string[],
  resource: string,
  fieldSchemas: Record<string, FieldSchema>
): FilterNode | undefined {
  const nodes: FilterNode[] = []

  for (const [field, value] of Object.entries(filtersObj)) {
    if (!allowedFields.includes(field)) {
      throw new ValidationError(
        `Field "${field}" is not allowed for filtering on resource "${resource}"`
      )
    }

    const fieldSchema = fieldSchemas[field]

    if (value === null) {
      nodes.push({ type: "null", field, isNull: true })
      continue
    }

    if (typeof value === "object" && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>

      if ("gte" in obj || "lte" in obj || "gt" in obj || "lt" in obj) {
        nodes.push({ type: "range", field, ...obj })
        continue
      }

      if ("contains" in obj) {
        nodes.push({ type: "like", field, value: obj.contains as string, mode: "contains" })
        continue
      }
      if ("startsWith" in obj) {
        nodes.push({ type: "like", field, value: obj.startsWith as string, mode: "startsWith" })
        continue
      }
      if ("endsWith" in obj) {
        nodes.push({ type: "like", field, value: obj.endsWith as string, mode: "endsWith" })
        continue
      }

      if ("in" in obj && Array.isArray(obj.in)) {
        if (fieldSchema?.type === "enum" && fieldSchema.enumValues) {
          for (const v of obj.in as unknown[]) {
            if (!fieldSchema.enumValues.includes(v as string)) {
              throw new ValidationError(`Invalid enum value "${v}" for field "${field}"`)
            }
          }
        }
        nodes.push({ type: "in", field, values: obj.in })
        continue
      }
    }

    if (Array.isArray(value)) {
      if (fieldSchema?.type === "enum" && fieldSchema.enumValues) {
        for (const v of value) {
          if (!fieldSchema.enumValues.includes(v as string)) {
            throw new ValidationError(`Invalid enum value "${v}" for field "${field}"`)
          }
        }
      }
      nodes.push({ type: "in", field, values: value })
      continue
    }

    // Validate enum scalar
    if (fieldSchema?.type === "enum" && fieldSchema.enumValues) {
      if (!fieldSchema.enumValues.includes(value as string)) {
        throw new ValidationError(`Invalid enum value "${value}" for field "${field}"`)
      }
    }

    nodes.push({ type: "eq", field, value })
  }

  if (nodes.length === 0) return undefined
  if (nodes.length === 1) return nodes[0]
  return { type: "and", filters: nodes }
}
