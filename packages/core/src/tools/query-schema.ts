import { z } from "zod"
import { QuerySchema, InsertSchema, UpdateSchema, DeleteSchema } from "../ast"
import type { FnDef } from "../functions"

let base: object | null = null
let mutationSchemas: Record<"create" | "update" | "delete", object> | null = null

// JSON Schema for a write tool's input. No catalog specialization — the columns
// are free strings (validated downstream), the `where` reuses the shared Expr.
export function mutationSchema(op: "create" | "update" | "delete"): object {
  mutationSchemas ??= {
    create: z.toJSONSchema(InsertSchema) as object,
    update: z.toJSONSchema(UpdateSchema) as object,
    delete: z.toJSONSchema(DeleteSchema) as object,
  }
  return mutationSchemas[op]
}

// JSON Schema for the query tool's input, derived from QuerySchema with `fn`
// constrained to the available function names. Resources and columns stay
// generic strings — they're resource-dependent and discovered via the tools,
// and the validator is the real backstop (a bad name is rejected at run time).
// `fn` is enumerated (a small fixed set), and any fixed-value (enum) arguments a
// function takes are spelled out in its description — otherwise a model would
// only discover valid units by trying one and reading the error.
export function buildQuerySchema(functions: Record<string, FnDef>): object {
  // Describe the input the model produces (io: "input"): function args accept a
  // bare column shorthand that normalizes to a col Expr, so the schema must show
  // the pre-transform shape.
  base ??= z.toJSONSchema(QuerySchema, { io: "input" }) as object
  const schema = structuredClone(base) as JsonSchemaNode
  const variants = schema.properties?.select?.items?.anyOf
  const fnVariant = Array.isArray(variants) ? variants.find((v) => v?.properties?.fn) : undefined
  if (fnVariant?.properties) {
    const fn: Record<string, unknown> = { type: "string", enum: Object.keys(functions) }
    const hint = enumArgHint(functions)
    if (hint) fn.description = hint
    fnVariant.properties.fn = fn
  }
  return schema
}

// Document every function that takes a fixed-value argument, e.g.
// "Functions with fixed-value arguments: dateTrunc(minute|hour|day|month|year)."
// Returns undefined when no function has an enum arg.
function enumArgHint(functions: Record<string, FnDef>): string | undefined {
  const parts: string[] = []
  for (const [name, def] of Object.entries(functions)) {
    const enums = def.args.filter((a) => a.kind === "enum")
    if (enums.length) {
      const args = enums
        .map((a) => (a as { values: readonly string[] }).values.join("|"))
        .join(", ")
      parts.push(`${name}(${args})`)
    }
  }
  return parts.length ? `Functions with fixed-value arguments: ${parts.join("; ")}.` : undefined
}

// A loose shape for walking the generated JSON Schema to the `fn` field. JSON
// Schema is inherently untyped here; this names the path we touch.
interface JsonSchemaNode {
  properties?: {
    select?: { items?: { anyOf?: Array<{ properties?: Record<string, unknown> }> } }
  }
}
