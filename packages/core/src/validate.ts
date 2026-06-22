import type { Query, Expr, Insert, Update, Delete } from "./ast"
import type { ResourceSchema } from "./catalog"
import type { EvaluatedPolicy, EvaluatedWrite, WriteOp } from "./evaluate"
import { ValidationError } from "./errors"

// The semantic gate. Structural validity is already guaranteed by the AST
// schema; this rejects anything illegal against the catalog + policy. Every
// column reference, anywhere in the query, must exist and be on the allowlist —
// fail-closed.
export function validateQuery(
  query: Query,
  resource: ResourceSchema,
  evaluated: EvaluatedPolicy,
  maxLimit: number,
): void {
  const allowed = new Set(evaluated.allowedFields)
  // One message whether the column is unknown or merely denied — never reveal
  // which, so an attacker can't enumerate hidden (incl. sensitive) column names.
  const check = (name: string) => {
    if (!hasOwn(resource.fields, name) || !allowed.has(name)) {
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
      check(item.col)
    }
  }
  if (query.where) walkColumns(query.where, check)

  // GROUP BY / ORDER BY may reference a SELECT output alias (a time bucket, an
  // aggregate) as well as a catalog column — every dialect resolves output names
  // there. The aliased expression was already validated as a select item, so an
  // alias reference adds no column exposure.
  const aliases = new Set<string>()
  for (const item of query.select) if (item.as) aliases.add(item.as)
  const checkRef = (name: string) => {
    if (!aliases.has(name)) check(name)
  }
  query.groupBy?.forEach(checkRef)
  query.orderBy?.forEach((o) => checkRef(o.col))
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
  const checkReadable = (name: string) => {
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

function walkColumns(expr: Expr, visit: (name: string) => void): void {
  switch (expr.kind) {
    case "col":
      visit(expr.name)
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
