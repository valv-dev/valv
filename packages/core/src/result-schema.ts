import type { Query, FnSelect } from "./ast"
import type { SchemaMap, ResourceSchema, FieldType } from "./catalog"
import { lookupFunction, type FnDef, type FnReturn } from "./functions"
import { ValidationError } from "./errors"
import { resolveJoins, aliasForPath, ROOT_ALIAS } from "./joins"

// One output column of a query: its result key and coarse type. Derived from the
// select list + catalog without executing — reliable because the AST *is* the
// projection. Types are coarse (number/string/date/…), which is what dashboards
// need; exact native types are runtime/engine semantics we don't predict.
export interface ResultColumn {
  name: string
  type: FieldType
}

type ResourceFor = (rel: string[] | undefined) => ResourceSchema | undefined

export function resultSchema(
  query: Query,
  catalog: SchemaMap,
  functions: Record<string, FnDef>,
): ResultColumn[] {
  const resource = catalog.resources[query.from]
  if (!resource) throw new ValidationError(`Unknown resource "${query.from}".`)

  // Map each in-scope table's alias to its resource, so a qualified column's
  // type resolves against the table it belongs to (mirrors emit's aliasing).
  const byAlias = new Map<string, ResourceSchema>([[ROOT_ALIAS, resource]])
  for (const node of resolveJoins(query, catalog)) byAlias.set(node.alias, node.resource)
  const resourceFor: ResourceFor = (rel) =>
    byAlias.get(rel?.length ? aliasForPath(rel) : ROOT_ALIAS)

  return query.select.map((item) => {
    if ("fn" in item) {
      const def = lookupFunction(functions, item.fn)
      return { name: item.as ?? item.fn, type: fnType(def.returns, item, resourceFor) }
    }
    // A joined column with no alias takes emit's deterministic key.
    const name = item.as ?? (item.rel?.length ? `${item.rel.join("_")}_${item.col}` : item.col)
    return { name, type: columnType(item.rel, item.col, resourceFor) }
  })
}

function fnType(returns: FnReturn, item: FnSelect, resourceFor: ResourceFor): FieldType {
  if (typeof returns === "string") return returns
  // "same as arg N" — resolve the type of that column argument (max/min).
  const arg = item.args[returns.fromArg]
  return arg && arg.kind === "col" ? columnType(arg.rel, arg.name, resourceFor) : "string"
}

function columnType(rel: string[] | undefined, name: string, resourceFor: ResourceFor): FieldType {
  // A best-effort metadata helper, not a gate (run() validates) — an unknown
  // column or table falls back rather than throwing.
  const resource = resourceFor(rel)
  return resource && Object.prototype.hasOwnProperty.call(resource.fields, name)
    ? resource.fields[name].type
    : "string"
}
