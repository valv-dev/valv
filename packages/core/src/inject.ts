import type { Query, Expr, Insert, Update, Delete, InjectedMutation } from "./ast"
import type { EvaluatedWrite, WriteOp } from "./evaluate"

// A policy scope to inject: a row predicate and the relation path of the table
// it scopes (empty for the root). The predicate's columns are qualified to that
// table so a joined resource gets filtered on ITS own alias, not the root's.
export interface PolicyScope {
  rel: string[]
  predicate?: Expr
}

// AND every in-scope policy predicate (root + each joined table) into the query
// and always bound the limit. Predicates are policy-authored (trusted), injected
// after validation. Each joined predicate is qualified to its table's `rel` path
// so its tenant scope can't be confused with the root's.
export function injectPolicy(
  query: Query,
  scopes: PolicyScope[],
  defaultLimit: number,
  maxLimit: number,
): Query {
  const preds: Expr[] = []
  if (query.where) preds.push(query.where)
  for (const scope of scopes) {
    if (scope.predicate) preds.push(qualify(scope.predicate, scope.rel))
  }
  const where: Expr | undefined =
    preds.length === 0 ? undefined : preds.length === 1 ? preds[0] : { kind: "and", args: preds }
  const limit = Math.min(query.limit ?? defaultLimit, maxLimit)
  return { ...query, where, limit }
}

// Tag every column in a policy predicate with the table's relation path, so it
// emits qualified to that table's alias. Policy predicates never set `rel`
// themselves, so this just stamps the owning table onto each column.
function qualify(expr: Expr, rel: string[]): Expr {
  if (rel.length === 0) return expr
  switch (expr.kind) {
    case "col":
      return { ...expr, rel }
    case "value":
      return expr
    case "cmp":
      return { ...expr, left: qualify(expr.left, rel), right: qualify(expr.right, rel) }
    case "null":
      return { ...expr, expr: qualify(expr.expr, rel) }
    case "and":
      return { kind: "and", args: expr.args.map((a) => qualify(a, rel)) }
    case "or":
      return { kind: "or", args: expr.args.map((a) => qualify(a, rel)) }
    case "not":
      return { kind: "not", arg: qualify(expr.arg, rel) }
  }
}

// Bake policy into a mutation: force server-owned values onto an insert, and AND
// the scope predicate into an update/delete WHERE. The result is what the
// adapter runs — it can no longer be widened by the model.
export function injectMutation(
  op: WriteOp,
  mutation: Insert | Update | Delete,
  write: EvaluatedWrite,
): InjectedMutation {
  if (op === "create") {
    const insert = mutation as Insert
    return { op: "insert", from: insert.from, values: { ...insert.values, ...write.forced } }
  }
  if (op === "update") {
    const update = mutation as Update
    return {
      op: "update",
      from: update.from,
      set: update.set,
      where: andWhere(update.where, write.predicate),
    }
  }
  const del = mutation as Delete
  return { op: "delete", from: del.from, where: andWhere(del.where, write.predicate) }
}

function andWhere(where: Expr, predicate: Expr | undefined): Expr {
  return predicate ? { kind: "and", args: [where, predicate] } : where
}
