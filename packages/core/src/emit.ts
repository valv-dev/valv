import type { Query, Expr, SelectItem, FnSelect, Insert, Update, Delete } from "./ast"
import type { SchemaMap } from "./catalog"
import type { CompiledQuery, BoundParam } from "./adapter"
import type { Dialect } from "./dialect"
import { ValidationError } from "./errors"
import { BASE_FUNCTIONS, lookupFunction, requiredArgs, type ArgSpec, type FnDef } from "./functions"

// Turns a validated Query into dialect SQL + bound params. Two kinds of check
// live here, both needing the dialect's function registry (which validate.ts,
// running before compile, doesn't have): function-signature checks (arity, arg
// kinds, numeric ranges, enum membership). Policy/column checks already happened
// in validate.ts. Anything that reaches SQL as a literal does so only after one
// of those checks, never by string interpolation of attacker input.

interface EmitContext {
  fields: Record<string, { nativeType: string }>
  dialect: Dialect
  params: BoundParam[]
}

export function emit(
  query: Query,
  catalog: SchemaMap,
  dialect: Dialect,
  options: { database?: string } = {},
): CompiledQuery {
  const resource = catalog.resources[query.from]
  if (!resource) throw new Error(`[valv] unknown resource "${query.from}"`)

  const ctx: EmitContext = { fields: resource.fields, dialect, params: [] }
  const q = (id: string) => dialect.quoteId(id)
  // Null-prototype merge so an attacker-supplied fn name like "constructor" or
  // "toString" resolves to nothing rather than an inherited Object.prototype
  // member — only own entries exist, keeping the allowlist intact.
  const functions: Record<string, FnDef> = Object.assign(
    Object.create(null),
    BASE_FUNCTIONS,
    dialect.functions,
  )

  const table = options.database
    ? `${q(options.database)}.${q(resource.tableName)}`
    : q(resource.tableName)
  const select = query.select.map((item) => emitSelectItem(item, ctx, functions)).join(", ")

  let sql = `SELECT ${select} FROM ${table}`
  if (query.where) sql += ` WHERE ${emitExpr(query.where, ctx)}`
  if (query.groupBy?.length) sql += ` GROUP BY ${query.groupBy.map(q).join(", ")}`
  if (query.orderBy?.length) {
    sql += ` ORDER BY ${query.orderBy.map((o) => `${q(o.col)} ${o.dir.toUpperCase()}`).join(", ")}`
  }
  if (query.limit !== undefined) sql += ` LIMIT ${Math.trunc(query.limit)}`

  return { sql, params: ctx.params }
}

// ── Mutations ───────────────────────────────────────────────────────────────
// Emit INSERT / UPDATE / DELETE for an already-validated, policy-injected
// mutation. Values bind through the same `bind` as reads — never inlined — and
// the WHERE goes through the shared `emitExpr`.

export function emitInsert(insert: Insert, catalog: SchemaMap, dialect: Dialect): CompiledQuery {
  const ctx = mutationContext(insert.from, catalog, dialect)
  const q = (id: string) => dialect.quoteId(id)
  const cols = Object.keys(insert.values)
  const values = cols.map((c) => bind(ctx, insert.values[c], typeOf(ctx, c)))
  const sql = `INSERT INTO ${q(ctx.tableName)} (${cols.map(q).join(", ")}) VALUES (${values.join(", ")})`
  return { sql, params: ctx.params }
}

export function emitUpdate(update: Update, catalog: SchemaMap, dialect: Dialect): CompiledQuery {
  const ctx = mutationContext(update.from, catalog, dialect)
  const q = (id: string) => dialect.quoteId(id)
  // SET params bind before WHERE params — matching their placeholder order.
  const sets = Object.keys(update.set).map(
    (c) => `${q(c)} = ${bind(ctx, update.set[c], typeOf(ctx, c))}`,
  )
  const sql = `UPDATE ${q(ctx.tableName)} SET ${sets.join(", ")} WHERE ${emitExpr(update.where, ctx)}`
  return { sql, params: ctx.params }
}

export function emitDelete(del: Delete, catalog: SchemaMap, dialect: Dialect): CompiledQuery {
  const ctx = mutationContext(del.from, catalog, dialect)
  const q = (id: string) => dialect.quoteId(id)
  const sql = `DELETE FROM ${q(ctx.tableName)} WHERE ${emitExpr(del.where, ctx)}`
  return { sql, params: ctx.params }
}

function mutationContext(
  from: string,
  catalog: SchemaMap,
  dialect: Dialect,
): EmitContext & { tableName: string } {
  const resource = catalog.resources[from]
  if (!resource) throw new Error(`[valv] unknown resource "${from}"`)
  return { fields: resource.fields, dialect, params: [], tableName: resource.tableName }
}

function typeOf(ctx: EmitContext, col: string): string {
  return Object.prototype.hasOwnProperty.call(ctx.fields, col)
    ? ctx.fields[col].nativeType
    : "String"
}

// ── Select items & function calls ───────────────────────────────────────────

function emitSelectItem(
  item: SelectItem,
  ctx: EmitContext,
  functions: Record<string, FnDef>,
): string {
  const q = (id: string) => ctx.dialect.quoteId(id)
  const expr = "fn" in item ? emitFunction(item, ctx, functions) : q(item.col)
  return item.as ? `${expr} AS ${q(item.as)}` : expr
}

function emitFunction(item: FnSelect, ctx: EmitContext, functions: Record<string, FnDef>): string {
  const def = lookupFunction(functions, item.fn)
  const min = requiredArgs(def)
  const max = def.args.length
  if (item.args.length < min || item.args.length > max) {
    const want = min === max ? `${min}` : `${min}-${max}`
    throw new ValidationError(`Function "${item.fn}" expects ${want} argument(s).`)
  }
  // Render each positional arg per its spec; an omitted trailing optional column
  // (e.g. count → count(*)) maps to undefined.
  const parts = def.args.map((spec, i) =>
    i < item.args.length ? emitArg(item.fn, spec, item.args[i], ctx) : undefined,
  )
  return def.render(parts)
}

// Validate one function argument against its signature and render it to SQL.
// The kind decides both the check and how it reaches SQL: columns are quoted,
// numbers/enums are inlined after a value check, predicates go through the
// shared expression emitter (so their literals become bound params).
function emitArg(fn: string, spec: ArgSpec, arg: Expr, ctx: EmitContext): string {
  switch (spec.kind) {
    case "column":
      if (arg.kind !== "col")
        throw new ValidationError(`Function "${fn}" expects a column argument.`)
      return ctx.dialect.quoteId(arg.name)
    case "number":
      // Finite numbers stringify to digits/sign/dot/exponent only, so inlining
      // can't carry SQL; the range rejects nonsense (e.g. a quantile > 1).
      if (arg.kind !== "value" || typeof arg.value !== "number" || !Number.isFinite(arg.value)) {
        throw new ValidationError(`Function "${fn}" expects a numeric argument.`)
      }
      if (spec.range && (arg.value < spec.range[0] || arg.value > spec.range[1])) {
        throw new ValidationError(
          `Function "${fn}" argument must be within [${spec.range[0]}, ${spec.range[1]}].`,
        )
      }
      return String(arg.value)
    case "enum":
      // Membership-checked against a fixed allowlist → the literal is safe inlined.
      if (
        arg.kind !== "value" ||
        typeof arg.value !== "string" ||
        !spec.values.includes(arg.value)
      ) {
        throw new ValidationError(`Function "${fn}" expects one of: ${spec.values.join(", ")}.`)
      }
      return arg.value
    case "predicate":
      return emitExpr(arg, ctx)
  }
}

// ── Expressions ─────────────────────────────────────────────────────────────

function emitExpr(expr: Expr, ctx: EmitContext): string {
  switch (expr.kind) {
    case "col":
      return ctx.dialect.quoteId(expr.name)
    case "value":
      return bind(ctx, expr.value, "String")
    case "cmp": {
      const type = inferType(expr, ctx)
      return `(${emitOperand(expr.left, ctx, type)} ${expr.op} ${emitOperand(expr.right, ctx, type)})`
    }
    case "and":
      return `(${expr.args.map((a) => emitExpr(a, ctx)).join(" AND ")})`
    case "or":
      return `(${expr.args.map((a) => emitExpr(a, ctx)).join(" OR ")})`
    case "not":
      return `(NOT ${emitExpr(expr.arg, ctx)})`
  }
}

function emitOperand(expr: Expr, ctx: EmitContext, type: string): string {
  if (expr.kind === "col") return ctx.dialect.quoteId(expr.name)
  if (expr.kind === "value") return bind(ctx, expr.value, type)
  return emitExpr(expr, ctx)
}

// A bound value is typed by the column it's compared against, so typed-placeholder
// dialects (ClickHouse) get the right cast; defaults to String otherwise.
function inferType(cmp: Extract<Expr, { kind: "cmp" }>, ctx: EmitContext): string {
  const col = cmp.left.kind === "col" ? cmp.left : cmp.right.kind === "col" ? cmp.right : undefined
  if (col && Object.prototype.hasOwnProperty.call(ctx.fields, col.name)) {
    return ctx.fields[col.name].nativeType
  }
  return "String"
}

// ── Parameter binding ───────────────────────────────────────────────────────

// Append a value to the param list and return its placeholder. Every caller
// value reaches SQL only through here — there is no path that inlines one.
function bind(ctx: EmitContext, value: unknown, type: string): string {
  const i = ctx.params.length
  ctx.params.push({ value, type })
  return ctx.dialect.placeholder(i, type)
}
