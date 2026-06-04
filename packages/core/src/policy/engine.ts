import { PolicyFn, PolicyResult, PolicyRule, ResourceSchema } from "../types"
import { FilterNode, AndFilter } from "../ir/types"
import { objectToFilterNode } from "../ir/filters"
import { ValidationError } from "../errors"

export type PolicyOperation = "read" | "write" | "create" | "update" | "delete" | "aggregate"

export interface EvaluatedPolicy {
  allowed: boolean
  rowFilter?: FilterNode
  allowedFields: string[]
  allowedRelations: string[]
  forcedWriteFields?: Record<string, unknown>  // injected into data on create/update
}

// Resolve the rule for an operation, applying the shorthand fallbacks:
// create/update fall back to `write`, aggregate falls back to `read`.
function resolveRule(result: PolicyResult, operation: PolicyOperation): PolicyRule | undefined {
  switch (operation) {
    case "create":    return result.create ?? result.write
    case "update":    return result.update ?? result.write
    case "write":     return result.write
    case "aggregate": return result.aggregate ?? result.read
    case "read":      return result.read
    case "delete":    return result.delete
  }
}

function isScalar(v: unknown): boolean {
  return v === null || ["string", "number", "boolean", "bigint"].includes(typeof v)
}

export function evaluatePolicy<TContext>(
  policy: PolicyFn<TContext> | undefined,
  ctx: TContext,
  operation: PolicyOperation,
  defaultPolicy: "deny-all" | "allow-all",
  schema?: ResourceSchema
): EvaluatedPolicy {
  let result: PolicyResult = {}

  if (policy) {
    result = policy(ctx)
  }

  const opValue = resolveRule(result, operation)
  const isWriteOp = operation === "create" || operation === "update" || operation === "write"

  let allowed: boolean
  let rowFilter: FilterNode | undefined
  let forcedWriteFields: Record<string, unknown> | undefined

  if (opValue === undefined) {
    allowed = defaultPolicy === "allow-all"
  } else if (opValue === true) {
    allowed = true
  } else if (opValue === false) {
    allowed = false
  } else {
    // Object value — a predicate.
    allowed = true
    const obj = opValue as Record<string, unknown>
    if (operation === "create") {
      // Inserts have no WHERE clause: only concrete scalar values can be forced
      // into the row. Operator/combinator entries are rejected (see helper).
      forcedWriteFields = extractForcedFields(obj, schema, true)
    } else if (isWriteOp) {
      // update (or the `write` shorthand): force scalar equalities into the row
      // AND use the full predicate as a WHERE guard.
      forcedWriteFields = extractForcedFields(obj, schema, false)
      rowFilter = objectToFilterNode(obj, { allowBoolean: true })
    } else {
      // read / delete / aggregate: predicate is a pure row filter.
      rowFilter = objectToFilterNode(obj, { allowBoolean: true })
    }
  }

  if (!allowed) {
    return { allowed: false, allowedFields: [], allowedRelations: [] }
  }

  const allFields = schema ? Object.keys(schema.fields) : []
  const sensitiveFields = schema
    ? Object.values(schema.fields).filter(f => f.sensitive).map(f => f.name)
    : []

  let allowedFields: string[]
  const fieldPolicy = result.fields

  if (fieldPolicy?.allow) {
    allowedFields = fieldPolicy.allow.filter(f => !sensitiveFields.includes(f))
  } else if (fieldPolicy?.deny) {
    const denySet = new Set([...fieldPolicy.deny, ...sensitiveFields])
    allowedFields = allFields.filter(f => !denySet.has(f))
  } else {
    allowedFields = allFields.filter(f => !sensitiveFields.includes(f))
  }

  // Operation-specific field visibility: read-only fields are dropped from the
  // write set, write-only fields are dropped from the read set.
  if (isWriteOp && fieldPolicy?.readOnly) {
    const readOnly = new Set(fieldPolicy.readOnly)
    allowedFields = allowedFields.filter(f => !readOnly.has(f))
  } else if (!isWriteOp && fieldPolicy?.writeOnly) {
    const writeOnly = new Set(fieldPolicy.writeOnly)
    allowedFields = allowedFields.filter(f => !writeOnly.has(f))
  }

  const allRelations = schema ? Object.keys(schema.relations) : []
  const relationsPolicy = result.relations

  let allowedRelations: string[]
  if (relationsPolicy) {
    allowedRelations = allRelations.filter(r => relationsPolicy[r] !== false)
  } else {
    allowedRelations = allRelations
  }

  return { allowed, rowFilter, allowedFields, allowedRelations, forcedWriteFields }
}

// Pulls the scalar equality pairs out of a write predicate — these are the only
// values that can be force-written into a row. For inserts (`strict`), an
// operator filter or combinator on a *required* field can never be satisfied,
// so we fail loudly rather than silently produce an unscoped insert.
function extractForcedFields(
  obj: Record<string, unknown>,
  schema: ResourceSchema | undefined,
  strict: boolean
): Record<string, unknown> {
  const forced: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(obj)) {
    if (field === "OR" || field === "AND" || field === "NOT") {
      if (strict) {
        throw new ValidationError(
          `create policy cannot use the "${field}" combinator — inserts only support forced field values`
        )
      }
      continue
    }
    if (isScalar(value)) {
      forced[field] = value
      continue
    }
    if (strict && isRequiredField(field, schema)) {
      throw new ValidationError(
        `create policy uses an operator filter on required field "${field}", which an insert cannot satisfy`
      )
    }
  }
  return forced
}

function isRequiredField(field: string, schema?: ResourceSchema): boolean {
  const f = schema?.fields[field]
  if (!f) return false
  return !f.isId && !f.isNullable && !f.hasDefaultValue
}

export function rowFilterFromObject(obj: Record<string, unknown>): FilterNode {
  const filters: FilterNode[] = Object.entries(obj).map(([field, value]) => ({
    type: "eq" as const,
    field,
    value,
  }))

  if (filters.length === 1) return filters[0]

  return { type: "and", filters } as AndFilter
}

export function mergeFilters(
  policyFilter: FilterNode | undefined,
  llmFilter: FilterNode | undefined
): FilterNode | undefined {
  if (!policyFilter && !llmFilter) return undefined
  if (!policyFilter) return llmFilter
  if (!llmFilter) return policyFilter

  return { type: "and", filters: [policyFilter, llmFilter] } as AndFilter
}
