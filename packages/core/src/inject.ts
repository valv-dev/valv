import type { Query, Expr, Insert, Update, Delete, InjectedMutation } from "./ast"
import type { EvaluatedPolicy, EvaluatedWrite, WriteOp } from "./evaluate"

// AND the policy's row predicate into the query and always bound the limit. The
// predicate is policy-authored (trusted), so it's injected after validation.
export function injectPolicy(
  query: Query,
  evaluated: EvaluatedPolicy,
  defaultLimit: number,
  maxLimit: number,
): Query {
  let where = query.where
  if (evaluated.predicate) {
    where = where ? { kind: "and", args: [where, evaluated.predicate] } : evaluated.predicate
  }
  const limit = Math.min(query.limit ?? defaultLimit, maxLimit)
  return { ...query, where, limit }
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
    return { op: "update", from: update.from, set: update.set, where: andWhere(update.where, write.predicate) }
  }
  const del = mutation as Delete
  return { op: "delete", from: del.from, where: andWhere(del.where, write.predicate) }
}

function andWhere(where: Expr, predicate: Expr | undefined): Expr {
  return predicate ? { kind: "and", args: [where, predicate] } : where
}
