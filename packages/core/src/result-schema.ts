import type { Query, FnSelect } from "./ast"
import type { SchemaMap, ResourceSchema, FieldType } from "./catalog"
import { lookupFunction, type FnDef, type FnReturn } from "./functions"
import { ValidationError } from "./errors"

// One output column of a query: its result key and coarse type. Derived from the
// select list + catalog without executing — reliable because the AST *is* the
// projection. Types are coarse (number/string/date/…), which is what dashboards
// need; exact native types are runtime/engine semantics we don't predict.
export interface ResultColumn {
  name: string
  type: FieldType
}

export function resultSchema(
  query: Query,
  catalog: SchemaMap,
  functions: Record<string, FnDef>,
): ResultColumn[] {
  const resource = catalog.resources[query.from]
  if (!resource) throw new ValidationError(`Unknown resource "${query.from}".`)

  return query.select.map((item) => {
    if ("fn" in item) {
      const def = lookupFunction(functions, item.fn)
      return { name: item.as ?? item.fn, type: fnType(def.returns, item, resource) }
    }
    return { name: item.as ?? item.col, type: columnType(item.col, resource) }
  })
}

function fnType(returns: FnReturn, item: FnSelect, resource: ResourceSchema): FieldType {
  if (typeof returns === "string") return returns
  // "same as arg N" — resolve the type of that column argument (max/min).
  const arg = item.args[returns.fromArg]
  return arg && arg.kind === "col" ? columnType(arg.name, resource) : "string"
}

function columnType(name: string, resource: ResourceSchema): FieldType {
  // A best-effort metadata helper, not a gate (run() validates) — an unknown
  // column falls back rather than throwing.
  return Object.prototype.hasOwnProperty.call(resource.fields, name)
    ? resource.fields[name].type
    : "string"
}
