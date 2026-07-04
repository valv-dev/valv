import { z } from "zod"

// The query AST the model emits. One tree flows through every stage — validate,
// inject, emit — with no conversions. Supports single-table select + filter +
// aggregates (group/order/limit); joins and subqueries are added as new node
// variants later.

export type CmpOp = "=" | "!=" | ">" | "<" | ">=" | "<="

// A relation path from the query's root resource to a joined table — e.g.
// ["order", "customer"] reaches `customer` via `order`. Each segment is a
// declared relation name; the path doubles as the joined table's alias. A column
// reference carries this to say which table it belongs to (absent = the root).
// Joins are *derived* from the set of paths referenced across the query, never
// declared separately, so they can't drift from the columns that use them.
export type RelPath = string[]

// A select entry is either a bare column or a function call. `as` names the
// output column. A function's args are Exprs interpreted positionally against
// its registry signature: a column (sum), a literal (quantileTiming(0.95)), an
// enum unit (toStartOfInterval(ts, INTERVAL 1 hour)), or a boolean predicate
// (countIf(status >= 500)).
export type ColumnSelect = { col: string; rel?: RelPath; as?: string }
export type FnSelect = { fn: string; args: Expr[]; as?: string }
export type SelectItem = ColumnSelect | FnSelect

export type OrderBy = { col: string; rel?: RelPath; dir: "asc" | "desc" }

// A group key is either a SELECT output alias (bare string) or a column —
// optionally on a joined table via `rel`.
export type GroupByItem = string | { col: string; rel?: RelPath }

export type Expr =
  | { kind: "col"; name: string; rel?: RelPath }
  | { kind: "value"; value: unknown } // a caller value → bound param at emit
  | { kind: "cmp"; op: CmpOp; left: Expr; right: Expr }
  | { kind: "and"; args: Expr[] }
  | { kind: "or"; args: Expr[] }
  | { kind: "not"; arg: Expr }

const cmpOp = z.enum(["=", "!=", ">", "<", ">=", "<="])

// Structural bound on a relation path — a sane ceiling so a pathological array
// can't reach the resolver. The real, friendly join-depth limit is enforced in
// joins.ts against MAX_JOIN_DEPTH.
const relPath = z
  .array(z.string().regex(/^[A-Za-z0-9_]+$/))
  .min(1)
  .max(8)

// Recursive schema: annotate via cast, the idiomatic Zod pattern (the inferred
// output differs only in that z.unknown() makes `value` optional).
export const ExprSchema = z.lazy(() =>
  z.union([
    z.object({ kind: z.literal("col"), name: z.string(), rel: relPath.optional() }),
    z.object({
      kind: z.literal("value"),
      value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    }),
    z.object({ kind: z.literal("cmp"), op: cmpOp, left: ExprSchema, right: ExprSchema }),
    z.object({ kind: z.literal("and"), args: z.array(ExprSchema).min(1).max(100) }),
    z.object({ kind: z.literal("or"), args: z.array(ExprSchema).min(1).max(100) }),
    z.object({ kind: z.literal("not"), arg: ExprSchema }),
  ]),
) as unknown as z.ZodType<Expr>

// `as`/`fn` are output/function names, constrained to safe characters here.
// Column references (`col`, and columns inside function args) are instead
// allowlist-checked against the catalog downstream, in validate.ts.
const identifier = z.string().regex(/^[A-Za-z0-9_]+$/)

const columnSelect = z.object({
  col: z.string(),
  rel: relPath.optional(),
  as: identifier.optional(),
})

// A function argument: any Expr, or the bare `{ col, rel? }` column shorthand —
// the same shape used in `select` — normalized to a col Expr so downstream stages
// (validate, inject, emit) only ever see the tagged form. This lets a column be
// written one way everywhere: `sum({ col: "amount" })` instead of the verbose
// `sum({ kind: "col", name: "amount" })`. The full Expr forms (value/cmp/boolean)
// still parse for functions that take literals or predicates.
const colShorthand = z
  .object({ col: z.string(), rel: relPath.optional() })
  .transform((c): Expr => (c.rel ? { kind: "col", name: c.col, rel: c.rel } : { kind: "col", name: c.col }))
const fnArg = z.union([ExprSchema, colShorthand]) as unknown as z.ZodType<Expr>

const fnSelect = z.object({
  fn: identifier,
  args: z.array(fnArg).max(8),
  as: identifier.optional(),
})

// A group key: a bare SELECT alias, or a (possibly joined) column.
const groupByItem = z.union([z.string(), z.object({ col: z.string(), rel: relPath.optional() })])

export const QuerySchema = z.object({
  from: z.string(),
  select: z
    .array(z.union([fnSelect, columnSelect]))
    .min(1)
    .max(32),
  where: ExprSchema.optional(),
  groupBy: z.array(groupByItem).max(32).optional(),
  orderBy: z
    .array(z.object({ col: z.string(), rel: relPath.optional(), dir: z.enum(["asc", "desc"]) }))
    .max(32)
    .optional(),
  limit: z.number().int().positive().optional(),
})

export type Query = z.infer<typeof QuerySchema>

// ── Mutations (write grammar) ────────────────────────────────────────────────
// Separate tools — create / update / delete — each its own shape. `from` is the
// resource (uniform with the query grammar). `values`/`set` map column → scalar;
// `where` reuses the Expr tree and is REQUIRED on update/delete (no implicit
// "all rows"). The tenant/row scope is still injected on top server-side.

export type Scalar = string | number | boolean | null

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()])
const columnValues = z
  .record(z.string(), scalar)
  .refine((o) => Object.keys(o).length > 0, "must set at least one column")

export type Insert = { from: string; values: Record<string, Scalar> }
export type Update = { from: string; set: Record<string, Scalar>; where: Expr }
export type Delete = { from: string; where: Expr }

export const InsertSchema = z.object({ from: z.string(), values: columnValues })
export const UpdateSchema = z.object({ from: z.string(), set: columnValues, where: ExprSchema })
export const DeleteSchema = z.object({ from: z.string(), where: ExprSchema })

// What reaches the adapter after policy injection: forced values merged in, the
// scope predicate AND-ed into WHERE. Tagged with `op` so the adapter can switch.
export type InjectedMutation =
  | { op: "insert"; from: string; values: Record<string, Scalar> }
  | { op: "update"; from: string; set: Record<string, Scalar>; where: Expr }
  | { op: "delete"; from: string; where: Expr }
