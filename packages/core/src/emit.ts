import type { Query, Expr, SelectItem, FnSelect } from "./ast"
import type { SchemaMap } from "./catalog"
import type { CompiledQuery, BoundParam } from "./adapter"
import { ValidationError } from "./errors"
import { BASE_FUNCTIONS, lookupFunction, requiredArgs, type ArgSpec, type FnDef } from "./functions"

// A SQL dialect: how it quotes identifiers, renders a parameter placeholder, and
// which extra aggregate functions it adds on top of the standard set. Everything
// else about emission — clauses, parenthesisation, parameter order — is shared
// below, so adding a database is a few lines here, not a new emitter.
export interface Dialect {
  quoteId(id: string): string
  // Placeholder for parameter #index (0-based). `type` is the compared column's
  // native type — used by dialects with typed placeholders (ClickHouse), ignored
  // by those that bind positionally (Postgres `$1`, MySQL/SQLite `?`).
  placeholder(index: number, type: string): string
  // Dialect-only aggregates (e.g. ClickHouse quantileTiming) merged over the
  // standard count/sum/avg/min/max in BASE_FUNCTIONS.
  functions?: Record<string, FnDef>
}

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
  // Null-prototype so an attacker-supplied fn name like "constructor" or
  // "toString" can't resolve to an inherited Object.prototype member and slip
  // past the allowlist — only own entries exist.
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

function emitSelectItem(
  item: SelectItem,
  ctx: EmitContext,
  functions: Record<string, FnDef>,
): string {
  const q = ctx.dialect.quoteId
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
  // Render each arg per its spec; a missing trailing optional column → undefined.
  const parts = def.args.map((spec, i) =>
    i < item.args.length ? emitArg(item.fn, spec, item.args[i], ctx) : undefined,
  )
  return def.render(parts)
}

function emitArg(fn: string, spec: ArgSpec, arg: Expr, ctx: EmitContext): string {
  switch (spec.kind) {
    case "column":
      if (arg.kind !== "col") throw new ValidationError(`Function "${fn}" expects a column argument.`)
      return ctx.dialect.quoteId(arg.name)
    case "number":
      // Finite numbers only — they stringify to digits/sign/dot/exponent, so
      // inlining can't carry SQL. Range bounds reject nonsense like a quantile > 1.
      if (arg.kind !== "value" || typeof arg.value !== "number" || !Number.isFinite(arg.value)) {
        throw new ValidationError(`Function "${fn}" expects a numeric argument.`)
      }
      if (spec.range && (arg.value < spec.range[0] || arg.value > spec.range[1])) {
        throw new ValidationError(`Function "${fn}" argument must be within [${spec.range[0]}, ${spec.range[1]}].`)
      }
      return String(arg.value)
    case "enum":
      // Membership-checked against a fixed allowlist, so the literal is safe to inline.
      if (arg.kind !== "value" || typeof arg.value !== "string" || !spec.values.includes(arg.value)) {
        throw new ValidationError(`Function "${fn}" expects one of: ${spec.values.join(", ")}.`)
      }
      return arg.value
    case "predicate":
      // A boolean Expr — emitted through the shared emitter, so any literal it
      // compares against becomes a bound parameter, not inlined.
      return emitExpr(arg, ctx)
  }
}

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

// A value is typed by the column it's compared against.
function inferType(cmp: Extract<Expr, { kind: "cmp" }>, ctx: EmitContext): string {
  const col = cmp.left.kind === "col" ? cmp.left : cmp.right.kind === "col" ? cmp.right : undefined
  if (col && Object.prototype.hasOwnProperty.call(ctx.fields, col.name)) {
    return ctx.fields[col.name].nativeType
  }
  return "String"
}

function emitOperand(expr: Expr, ctx: EmitContext, type: string): string {
  if (expr.kind === "col") return ctx.dialect.quoteId(expr.name)
  if (expr.kind === "value") return bind(ctx, expr.value, type)
  return emitExpr(expr, ctx)
}

function bind(ctx: EmitContext, value: unknown, type: string): string {
  const i = ctx.params.length
  ctx.params.push({ value, type })
  return ctx.dialect.placeholder(i, type)
}
