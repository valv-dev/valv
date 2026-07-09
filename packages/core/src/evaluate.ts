import type { PolicyFn, PolicyResult, FieldPolicy } from "./policy"
import type { ResourceSchema } from "./catalog"
import { ExprSchema, type Expr, type Scalar } from "./ast"
import { PolicyViolationError } from "./errors"

// A predicate rule is either an Expr node (has `kind`) or the scalar-equality
// shorthand record. `kind` is reserved as the Expr discriminator, so a column
// literally named "kind" must use the Expr form.
const isExpr = (rule: Record<string, unknown>): boolean => typeof rule.kind === "string"

export type WriteOp = "create" | "update" | "delete"

// What a policy resolves to for one operation: whether it's allowed, the row
// predicate to inject, and which fields the caller may touch. (v1: read only;
// the create/update/delete outputs come with writes.)
export interface EvaluatedPolicy {
  allowed: boolean
  predicate?: Expr
  allowedFields: string[]
  // Per-relation join gate from the policy — `{ rel: false }` blocks traversing
  // that relation even when the target is independently readable.
  relations?: Record<string, boolean>
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

  const relations = result.relations

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

  return { allowed, predicate, allowedFields, relations }
}

// Turn a policy row rule into the predicate Expr injected into the WHERE. Two
// forms:
//   • an Expr — passed through after structural validation, so a policy has the
//     full operator/AND/OR/NOT vocabulary the query grammar already supports. It
//     must be a boolean-valued node (cmp/and/or/not), not a bare col/value.
//   • the scalar-equality shorthand { field: value, … } — each pair becomes
//     `col = value`, AND-ed together (the common tenant-scoping case).
//
// A shorthand value that resolves to undefined/null means the policy couldn't
// compute its scope (e.g. a missing context field). We FAIL CLOSED rather than
// emit a meaningless `field = NULL` filter that would silently drop the scoping.
function ruleToExpr(rule: Record<string, unknown>): Expr {
  if (isExpr(rule)) {
    const parsed = ExprSchema.safeParse(rule)
    if (!parsed.success) {
      throw new PolicyViolationError(`Policy predicate is not a valid expression: ${parsed.error.message}`)
    }
    const expr = parsed.data
    if (expr.kind === "col" || expr.kind === "value") {
      throw new PolicyViolationError(
        `Policy predicate must be a boolean expression (cmp/and/or/not), got a bare "${expr.kind}".`,
      )
    }
    return expr
  }

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

// What a write policy resolves to: whether it's allowed, the fields to force
// onto the row (create) or the scope predicate to AND into the WHERE
// (update/delete), and which columns the model may set.
export interface EvaluatedWrite {
  allowed: boolean
  forced?: Record<string, Scalar> // create: server-owned values, injected into the row
  predicate?: Expr // update/delete: AND-ed into the WHERE
  writableFields: string[]
}

export function evaluateWrite<TContext>(
  policy: PolicyFn<TContext> | undefined,
  ctx: TContext,
  resource: ResourceSchema,
  op: WriteOp,
  defaultPolicy: "deny-all" | "allow-all",
): EvaluatedWrite {
  const result: PolicyResult = policy ? policy(ctx) : {}
  const rule =
    op === "create"
      ? (result.create ?? result.write)
      : op === "update"
        ? (result.update ?? result.write)
        : result.delete

  let allowed: boolean
  let forced: Record<string, Scalar> | undefined
  let predicate: Expr | undefined
  const scopeColumns: string[] = []

  if (rule === undefined) allowed = defaultPolicy === "allow-all"
  else if (typeof rule === "boolean") allowed = rule
  else {
    allowed = true
    // A create rule forces values onto the row; an update/delete rule scopes the
    // WHERE. Either way the scoped columns become server-owned so the model can't
    // set them to escape its scope — derived from the actual predicate, not the
    // raw keys (which are meaningless for an Expr rule).
    if (op === "create") {
      forced = resolveForced(rule)
      scopeColumns.push(...Object.keys(forced))
    } else {
      predicate = ruleToExpr(rule)
      scopeColumns.push(...columnsInExpr(predicate))
    }
  }
  if (!allowed) return { allowed: false, writableFields: [] }

  return {
    allowed,
    forced,
    predicate,
    writableFields: writableFields(resource, result.fields, scopeColumns),
  }
}

// Server-owned create values. Fails closed on undefined/null exactly like the
// read scope — we never write an unscoped row because a context field was missing.
function resolveForced(rule: Record<string, unknown>): Record<string, Scalar> {
  // A create rule forces scalar values onto the row; a comparison predicate has
  // no meaning here (you can't insert "total > 100"). Use the scalar shorthand.
  if (isExpr(rule)) {
    throw new PolicyViolationError(
      "A create policy must use the scalar { field: value } form, not a predicate expression.",
    )
  }
  const out: Record<string, Scalar> = {}
  for (const [field, value] of Object.entries(rule)) {
    if (value === undefined || value === null) {
      throw new PolicyViolationError(
        `Policy forced value for "${field}" resolved to ${value === undefined ? "undefined" : "null"}; refusing to write an unscoped row.`,
      )
    }
    out[field] = value as Scalar
  }
  return out
}

// Every column a predicate references, so the write path can mark them
// server-owned (the model can't set a column its scope depends on).
function columnsInExpr(expr: Expr): string[] {
  switch (expr.kind) {
    case "col":
      return [expr.name]
    case "value":
      return []
    case "cmp":
      return [...columnsInExpr(expr.left), ...columnsInExpr(expr.right)]
    case "and":
    case "or":
      return expr.args.flatMap(columnsInExpr)
    case "not":
      return columnsInExpr(expr.arg)
  }
}

// Columns the model may set: visible fields, minus sensitive, denied, read-only,
// and the scope/forced columns (those are server-owned — the model can't set
// tenant_id to escape its scope).
function writableFields(
  resource: ResourceSchema,
  fieldPolicy: FieldPolicy | undefined,
  scopeColumns: string[],
): string[] {
  const all = Object.keys(resource.fields)
  const sensitive = new Set(
    Object.values(resource.fields)
      .filter((f) => f.sensitive)
      .map((f) => f.name),
  )
  const scope = new Set(scopeColumns)
  const readOnly = new Set(fieldPolicy?.readOnly ?? [])

  let base: string[]
  if (fieldPolicy?.allow) base = fieldPolicy.allow.filter((f) => !sensitive.has(f))
  else if (fieldPolicy?.deny) {
    const denied = new Set([...fieldPolicy.deny, ...sensitive])
    base = all.filter((f) => !denied.has(f))
  } else base = all.filter((f) => !sensitive.has(f))

  return base.filter((f) => !readOnly.has(f) && !scope.has(f))
}
