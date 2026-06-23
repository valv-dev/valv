import type { Query, Expr, Insert, Update, Delete } from "./ast"
import type { ResourceSchema } from "./catalog"
import type { EvaluatedPolicy, EvaluatedWrite, WriteOp } from "./evaluate"
import { ValidationError } from "./errors"
import { ROOT_ALIAS, aliasForPath } from "./joins"

// One table in scope for a query: the resource and the fields this caller may
// read on it. Keyed by alias (the root, or a joined table's relation-path alias)
// so a column's `rel` path resolves to the right allowlist.
export interface ScopedTable {
  resource: ResourceSchema
  allowedFields: Set<string>
}

// The semantic gate. Structural validity is already guaranteed by the AST
// schema; this rejects anything illegal against the catalog + policy. Every
// column reference, anywhere in the query, must exist and be on the allowlist of
// the table it targets — fail-closed. With joins, each `rel`-qualified column is
// checked against ITS table, so a join can't reach a denied column on either side.
export function validateQuery(
  query: Query,
  tables: Map<string, ScopedTable>,
  maxLimit: number,
): void {
  // One message whether the column is unknown, denied, or on an unresolved table
  // — never reveal which, so an attacker can't enumerate hidden columns/tables.
  const check = (rel: string[] | undefined, name: string) => {
    const table = tables.get(rel?.length ? aliasForPath(rel) : ROOT_ALIAS)
    if (!table || !hasOwn(table.resource.fields, name) || !table.allowedFields.has(name)) {
      throw new ValidationError(`Column "${name}" is not accessible.`)
    }
  }

  // Every column reference — bare selects, function arguments (incl. columns
  // inside a predicate like countIf(salary > 0)), group/order keys, and filter
  // operands — runs through the same allowlist. An aggregate can't reach a
  // denied (or sensitive) column via avg(salary), countIf(...), or ORDER BY.
  for (const item of query.select) {
    if ("fn" in item) {
      item.args.forEach((a) => walkColumns(a, check))
    } else {
      check(item.rel, item.col)
    }
  }
  if (query.where) walkColumns(query.where, check)

  // GROUP BY / ORDER BY may reference a SELECT output alias (a time bucket, an
  // aggregate) as well as a catalog column — every dialect resolves output names
  // there. The aliased expression was already validated as a select item, so an
  // alias reference adds no column exposure. A `rel`-qualified key is always a
  // real column on that joined table, never an alias.
  const aliases = new Set<string>()
  for (const item of query.select) if (item.as) aliases.add(item.as)
  const checkRef = (rel: string[] | undefined, name: string) => {
    if (rel?.length || !aliases.has(name)) check(rel, name)
  }
  query.groupBy?.forEach((g) =>
    typeof g === "string" ? checkRef(undefined, g) : checkRef(g.rel, g.col),
  )
  query.orderBy?.forEach((o) => checkRef(o.rel, o.col))
  if (query.limit !== undefined && query.limit > maxLimit) {
    throw new ValidationError(`limit ${query.limit} exceeds the maximum of ${maxLimit}.`)
  }
}

// The write gate. `set`/`values` columns must be writable; `where` columns must
// be readable (the model can't filter rows by a column it can't see); an insert
// must provide every required column. Mirrors validateQuery, fail-closed.
export function validateMutation(
  op: WriteOp,
  mutation: Insert | Update | Delete,
  resource: ResourceSchema,
  write: EvaluatedWrite,
  read: EvaluatedPolicy,
): void {
  const writable = new Set(write.writableFields)
  const readable = new Set(read.allowedFields)

  const checkWritable = (name: string) => {
    if (!hasOwn(resource.fields, name) || !writable.has(name)) {
      throw new ValidationError(`Column "${name}" is not writable.`)
    }
  }
  // Writes are single-table — a `rel`-qualified column in a WHERE is rejected.
  const checkReadable = (rel: string[] | undefined, name: string) => {
    if (rel?.length) throw new ValidationError(`Joins are not supported in writes.`)
    if (!hasOwn(resource.fields, name) || !readable.has(name)) {
      throw new ValidationError(`Column "${name}" is not accessible.`)
    }
  }

  if (op === "create") {
    const insert = mutation as Insert
    for (const col of Object.keys(insert.values)) checkWritable(col)
    requireFields(resource, insert.values, write.forced)
  } else if (op === "update") {
    const update = mutation as Update
    for (const col of Object.keys(update.set)) checkWritable(col)
    walkColumns(update.where, checkReadable)
  } else {
    walkColumns((mutation as Delete).where, checkReadable)
  }
}

// Every NOT-NULL column without a default (and not auto-generated or forced by
// policy) must be supplied — caught here with a clear message, not at the DB.
function requireFields(
  resource: ResourceSchema,
  values: Record<string, unknown>,
  forced: Record<string, unknown> | undefined,
): void {
  for (const field of Object.values(resource.fields)) {
    const required = !field.isNullable && !field.hasDefaultValue && !field.isId
    if (!required) continue
    const provided = hasOwn(values, field.name) || (forced ? hasOwn(forced, field.name) : false)
    if (!provided) throw new ValidationError(`Column "${field.name}" is required.`)
  }
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

function walkColumns(expr: Expr, visit: (rel: string[] | undefined, name: string) => void): void {
  switch (expr.kind) {
    case "col":
      visit(expr.rel, expr.name)
      break
    case "value":
      break
    case "cmp":
      walkColumns(expr.left, visit)
      walkColumns(expr.right, visit)
      break
    case "and":
    case "or":
      expr.args.forEach((a) => walkColumns(a, visit))
      break
    case "not":
      walkColumns(expr.arg, visit)
      break
  }
}
