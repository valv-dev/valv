import { z } from "zod"
import { QuerySchema } from "../ast"

let base: object | null = null

// JSON Schema for the query tool's input, derived from QuerySchema with `fn`
// constrained to the available function names. Resources and columns stay
// generic strings — they're resource-dependent and discovered via the tools,
// and the validator is the real backstop (a bad name is rejected at run time).
// Only `fn` is enumerated: it's a small fixed set, so it always helps and never
// bloats the schema.
export function buildQuerySchema(functionNames: string[]): object {
  base ??= z.toJSONSchema(QuerySchema) as object
  const schema = structuredClone(base) as JsonSchemaNode
  const variants = schema.properties?.select?.items?.anyOf
  const fnVariant = Array.isArray(variants) ? variants.find((v) => v?.properties?.fn) : undefined
  if (fnVariant?.properties) {
    fnVariant.properties.fn = { type: "string", enum: functionNames }
  }
  return schema
}

// A loose shape for walking the generated JSON Schema to the `fn` field. JSON
// Schema is inherently untyped here; this names the path we touch.
interface JsonSchemaNode {
  properties?: {
    select?: { items?: { anyOf?: Array<{ properties?: Record<string, unknown> }> } }
  }
}
