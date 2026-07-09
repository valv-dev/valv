import { z } from "zod"
import { QuerySchema, InsertSchema, UpdateSchema, DeleteSchema } from "../ast"
import type { ArgSpec, FnDef } from "../functions"

let base: object | null = null
let mutationSchemas: Record<"create" | "update" | "delete", object> | null = null

// JSON Schema for a write tool's input. No catalog specialization — the columns
// are free strings (validated downstream), the `where` reuses the shared Expr.
// io: "input" like the query schema — the Expr `where` accepts the bare column
// shorthand, so the model-facing schema must show the pre-transform shape.
export function mutationSchema(op: "create" | "update" | "delete"): object {
  mutationSchemas ??= {
    create: z.toJSONSchema(InsertSchema, { io: "input" }) as object,
    update: z.toJSONSchema(UpdateSchema, { io: "input" }) as object,
    delete: z.toJSONSchema(DeleteSchema, { io: "input" }) as object,
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
// "Functions with fixed-value arguments: dateTrunc(column, minute|hour|day|month|year)."
// The full positional signature is spelled out — not just the enum values — so the
// argument *order* is unambiguous (the model can't otherwise tell the unit comes
// after the column, only by trying one and reading the error). Returns undefined
// when no function has an enum arg.
function enumArgHint(functions: Record<string, FnDef>): string | undefined {
  const parts: string[] = []
  for (const [name, def] of Object.entries(functions)) {
    if (!def.args.some((a) => a.kind === "enum")) continue
    const args = def.args.map(renderArg).join(", ")
    parts.push(`${name}(${args})`)
  }
  return parts.length ? `Functions with fixed-value arguments: ${parts.join("; ")}.` : undefined
}

// One positional argument, spelled the way it appears in a call so order reads off
// the signature: the enum's allowed values, or the arg's kind as a placeholder.
function renderArg(a: ArgSpec): string {
  switch (a.kind) {
    case "enum":
      return a.values.join("|")
    case "column":
      return a.optional ? "column?" : "column"
    case "number":
      return "number"
    case "predicate":
      return "predicate"
  }
}

// A loose shape for walking the generated JSON Schema to the `fn` field. JSON
// Schema is inherently untyped here; this names the path we touch.
interface JsonSchemaNode {
  properties?: {
    select?: { items?: { anyOf?: Array<{ properties?: Record<string, unknown> }> } }
  }
}
