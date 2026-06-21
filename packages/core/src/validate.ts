import type { Query, Expr } from "./ast"
import type { ResourceSchema } from "./catalog"
import type { EvaluatedPolicy } from "./evaluate"
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
