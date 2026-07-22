import type { ArgSpec, FnDef } from "../functions"

// The model-facing JSON Schema for the query and write tools — the Prisma-
// idiomatic surface parsed by grammar.ts. Columns and resources stay generic
// strings (they're resource-dependent and discovered via describe_resource; the
// grammar + validator are the real backstop). Function names and their argument
// order are spelled out in the `select` description so the model doesn't have to
// probe for a signature by trial and error.

const scalar = { type: ["string", "number", "boolean", "null"] } as const

// A Prisma-style filter. Field keys are dynamic (any column path), so the object
// stays open; the operator vocabulary and shape live in the description.
const filterSchema = {
  type: "object",
  additionalProperties: true,
  description:
    "Prisma-style filter. { field: value } is equality; { field: { gte: x, lt: y } } applies " +
    "operators (equals, not, gt, gte, lt, lte, in, notIn, contains, startsWith, endsWith, mode: " +
    '"insensitive"). { field: null } tests IS NULL; { field: { not: null } } tests IS NOT NULL. ' +
    "Combine with AND / OR / NOT (arrays of filters). A dotted key reads a joined column: " +
    '{ "customer.region": "EU" }. Scope filters are added server-side — never add your own.',
} as const

const dataSchema = {
  type: "object",
  minProperties: 1,
  additionalProperties: scalar,
  description: "Column → value map.",
} as const

// Query tool input. `select` carries the function catalog in its description.
export function buildQuerySchema(functions: Record<string, FnDef>): object {
  return {
    type: "object",
    required: ["from", "select"],
    additionalProperties: false,
    properties: {
      from: { type: "string", description: "The resource to query." },
      where: filterSchema,
      select: {
        type: "object",
        minProperties: 1,
        additionalProperties: true,
        description:
          "Output columns keyed by result name: `true` selects the column of that name; " +
          '{ "col": "path" } renames or reads a joined column ({ "col": "customer.name" }); ' +
          "{ fn: args } computes/aggregates, where the key is the result name. Call a function " +
          "as { name: column } for one column, { name: true } for none (count), or { name: [args] } " +
          "positionally. Available functions (with argument order — `column` is a column name, " +
          "`predicate` a filter object): " +
          renderSignatures(functions) +
          ".",
      },
      groupBy: {
        type: "array",
        items: { type: "string" },
        description: "Column names or select aliases (e.g. a time bucket) to group by.",
      },
      orderBy: {
        description:
          '{ column: "asc" | "desc" } — column is a select alias or a column path. Use an array ' +
          "of these for multiple sort keys, in order.",
        oneOf: [orderBySchema(), { type: "array", items: orderBySchema() }],
      },
      take: { type: "integer", minimum: 1, description: "Maximum number of rows to return." },
    },
  }
}

export function mutationSchema(op: "create" | "update" | "delete"): object {
  const from = { type: "string", description: "The resource to write to." }
  if (op === "create") {
    return {
      type: "object",
      required: ["from", "data"],
      additionalProperties: false,
      properties: { from, data: dataSchema },
    }
  }
  if (op === "update") {
    return {
      type: "object",
      required: ["from", "where", "data"],
      additionalProperties: false,
      properties: { from, where: filterSchema, data: dataSchema },
    }
  }
  return {
    type: "object",
    required: ["from", "where"],
    additionalProperties: false,
    properties: { from, where: filterSchema },
  }
}

function orderBySchema(): object {
  return { type: "object", additionalProperties: { enum: ["asc", "desc"] } }
}

// "sum(column); count(column?); quantileTiming(number, column); toStartOfInterval(column, number,
// second|minute|...); countIf(predicate)" — the full signature so argument order and the fixed
// enum values read straight off the list.
function renderSignatures(functions: Record<string, FnDef>): string {
  return Object.entries(functions)
    .map(([name, def]) => `${name}(${def.args.map(renderArg).join(", ")})`)
    .join("; ")
}

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
