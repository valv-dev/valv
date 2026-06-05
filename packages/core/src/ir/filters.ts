import { FieldSchema } from "../types"
import { FilterNode } from "./types"
import { ValidationError } from "../errors"

export interface FilterBuildOptions {
  // Called for every regular field key — the LLM path throws here for fields
  // outside the policy whitelist. Not invoked for boolean combinator keys.
  allowField?: (field: string) => void
  // Field schemas, used to validate enum values when present.
  fieldSchemas?: Record<string, FieldSchema>
  // Recognise OR / AND / NOT combinator keys. Enabled for policy-authored
  // filters; left off for LLM filters so their semantics stay unchanged.
  allowBoolean?: boolean
}

const BOOLEAN_KEYS = new Set(["OR", "AND", "NOT"])

/**
 * Converts a single `field: value` entry into a FilterNode, using the same
 * operator vocabulary the LLM-facing tool schemas expose
 * (`{ gte }`, `{ contains }`, `{ in }`, arrays, scalars, null).
 */
export function valueToFilterNode(
  field: string,
  value: unknown,
  fieldSchema?: FieldSchema
): FilterNode {
  if (value === null) {
    return { type: "null", field, isNull: true }
  }

  if (typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>

    // Equality aliases — the canonical form is a bare value, but models commonly
    // reach for `{ eq }` / `{ equals }`, so accept them rather than mangling the query.
    if ("eq" in obj) {
      validateEnum(field, [obj.eq], fieldSchema)
      return { type: "eq", field, value: obj.eq }
    }
    if ("equals" in obj) {
      validateEnum(field, [obj.equals], fieldSchema)
      return { type: "eq", field, value: obj.equals }
    }
    if ("ne" in obj) {
      return { type: "not", filter: { type: "eq", field, value: obj.ne } }
    }
    if ("gte" in obj || "lte" in obj || "gt" in obj || "lt" in obj) {
      return { type: "range", field, ...obj }
    }
    if ("contains" in obj) {
      return { type: "like", field, value: obj.contains as string, mode: "contains" }
    }
    if ("startsWith" in obj) {
      return { type: "like", field, value: obj.startsWith as string, mode: "startsWith" }
    }
    if ("endsWith" in obj) {
      return { type: "like", field, value: obj.endsWith as string, mode: "endsWith" }
    }
    if ("in" in obj && Array.isArray(obj.in)) {
      validateEnum(field, obj.in, fieldSchema)
      return { type: "in", field, values: obj.in }
    }

    // Unknown operator object — reject with an actionable message instead of
    // passing it through as an equality against a literal object (which would
    // produce a malformed adapter query).
    throw new ValidationError(
      `Unsupported filter for field "${field}": {${Object.keys(obj).join(", ")}}. ` +
      `Use a bare value for equality, or an operator object with one of: ` +
      `eq, ne, gt, gte, lt, lte, in, contains, startsWith, endsWith.`
    )
  }

  if (Array.isArray(value)) {
    validateEnum(field, value, fieldSchema)
    return { type: "in", field, values: value }
  }

  validateEnum(field, [value], fieldSchema)
  return { type: "eq", field, value }
}

/**
 * Builds a composite FilterNode from an object of field conditions. Multiple
 * keys are AND-ed. With `allowBoolean`, the reserved keys `OR`/`AND`/`NOT`
 * compose nested boolean nodes.
 */
export function objectToFilterNode(
  obj: Record<string, unknown>,
  opts: FilterBuildOptions = {}
): FilterNode | undefined {
  const nodes: FilterNode[] = []

  for (const [key, value] of Object.entries(obj)) {
    if (opts.allowBoolean && BOOLEAN_KEYS.has(key)) {
      if (key === "NOT") {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const inner = objectToFilterNode(value as Record<string, unknown>, opts)
          if (inner) nodes.push({ type: "not", filter: inner })
        }
        continue
      }
      if (Array.isArray(value)) {
        const sub = value
          .map(v => objectToFilterNode(v as Record<string, unknown>, opts))
          .filter((n): n is FilterNode => n !== undefined)
        if (sub.length > 0) {
          nodes.push({ type: key === "OR" ? "or" : "and", filters: sub })
        }
      }
      continue
    }

    opts.allowField?.(key)
    nodes.push(valueToFilterNode(key, value, opts.fieldSchemas?.[key]))
  }

  if (nodes.length === 0) return undefined
  if (nodes.length === 1) return nodes[0]
  return { type: "and", filters: nodes }
}

function validateEnum(field: string, values: unknown[], fieldSchema?: FieldSchema): void {
  if (fieldSchema?.type === "enum" && fieldSchema.enumValues) {
    for (const v of values) {
      if (!fieldSchema.enumValues.includes(v as string)) {
        throw new ValidationError(`Invalid enum value "${v}" for field "${field}"`)
      }
    }
  }
}
