import type { Query } from "./ast"
import type { EvaluatedPolicy } from "./evaluate"

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
