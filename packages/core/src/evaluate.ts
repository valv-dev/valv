import type { PolicyFn, PolicyResult } from "./policy"
import type { ResourceSchema } from "./catalog"
import type { Expr } from "./ast"
import { PolicyViolationError } from "./errors"

// What a policy resolves to for one operation: whether it's allowed, the row
// predicate to inject, and which fields the caller may touch. (v1: read only;
// the create/update/delete outputs come with writes.)
export interface EvaluatedPolicy {
  allowed: boolean
  predicate?: Expr
  allowedFields: string[]
}

export function evaluateRead<TContext>(
  policy: PolicyFn<TContext> | undefined,
  ctx: TContext,
  resource: ResourceSchema,
  defaultPolicy: "deny-all" | "allow-all",
): EvaluatedPolicy {
  const result: PolicyResult = policy ? policy(ctx) : {}
  const rule = result.read

  let allowed: boolean
  let predicate: Expr | undefined
  if (rule === undefined) allowed = defaultPolicy === "allow-all"
  else if (typeof rule === "boolean") allowed = rule
  else {
    allowed = true
    predicate = ruleToExpr(rule)
  }
  if (!allowed) return { allowed: false, allowedFields: [] }

  const all = Object.keys(resource.fields)
  const sensitive = Object.values(resource.fields)
    .filter((f) => f.sensitive)
    .map((f) => f.name)
  const fields = result.fields

  let allowedFields: string[]
  if (fields?.allow) {
    allowedFields = fields.allow.filter((f) => !sensitive.includes(f))
  } else if (fields?.deny) {
    const denied = new Set([...fields.deny, ...sensitive])
    allowedFields = all.filter((f) => !denied.has(f))
  } else {
    allowedFields = all.filter((f) => !sensitive.includes(f))
  }

  return { allowed, predicate, allowedFields }
}

// v1 supports scalar-equality predicates ({ tenant_id: "acme" }) — the common
// tenant-scoping case. Operator predicates ({ total: { lt: 1000 } }) come later.
//
// A value that resolves to undefined/null means the policy couldn't compute its
// scope (e.g. a missing context field). We FAIL CLOSED rather than emit a
// meaningless `field = NULL` filter that would silently drop the scoping.
function ruleToExpr(rule: Record<string, unknown>): Expr {
  const cmps: Expr[] = Object.entries(rule).map(([field, value]): Expr => {
    if (value === undefined || value === null) {
      throw new PolicyViolationError(
        `Policy filter for "${field}" resolved to ${value === undefined ? "undefined" : "null"}; refusing to run an unscoped query.`,
      )
    }
    return {
      kind: "cmp",
      op: "=",
      left: { kind: "col", name: field },
      right: { kind: "value", value },
    }
  })
  return cmps.length === 1 ? cmps[0] : { kind: "and", args: cmps }
}
