import { z } from "zod"

// The query AST the model emits. One tree flows through every stage — validate,
// inject, emit — with no conversions. Supports single-table select + filter +
// aggregates (group/order/limit); joins and subqueries are added as new node
// variants later.

export type CmpOp = "=" | "!=" | ">" | "<" | ">=" | "<="

// A select entry is either a bare column or a function call. `as` names the
// output column. A function's args are Exprs interpreted positionally against
// its registry signature: a column (sum), a literal (quantileTiming(0.95)), an
// enum unit (toStartOfInterval(ts, INTERVAL 1 hour)), or a boolean predicate
// (countIf(status >= 500)).
export type ColumnSelect = { col: string; as?: string }
export type FnSelect = { fn: string; args: Expr[]; as?: string }
export type SelectItem = ColumnSelect | FnSelect

export type OrderBy = { col: string; dir: "asc" | "desc" }

export type Expr =
  | { kind: "col"; name: string }
  | { kind: "value"; value: unknown } // a caller value → bound param at emit
  | { kind: "cmp"; op: CmpOp; left: Expr; right: Expr }
  | { kind: "and"; args: Expr[] }
  | { kind: "or"; args: Expr[] }
  | { kind: "not"; arg: Expr }

const cmpOp = z.enum(["=", "!=", ">", "<", ">=", "<="])

// Recursive schema: annotate via cast, the idiomatic Zod pattern (the inferred
// output differs only in that z.unknown() makes `value` optional).
export const ExprSchema = z.lazy(() =>
  z.union([
    z.object({ kind: z.literal("col"), name: z.string() }),
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

const columnSelect = z.object({ col: z.string(), as: identifier.optional() })
const fnSelect = z.object({
  fn: identifier,
  args: z.array(ExprSchema).max(8),
  as: identifier.optional(),
})

export const QuerySchema = z.object({
  from: z.string(),
  select: z
    .array(z.union([fnSelect, columnSelect]))
    .min(1)
    .max(100),
  where: ExprSchema.optional(),
  groupBy: z.array(z.string()).max(100).optional(),
  orderBy: z
    .array(z.object({ col: z.string(), dir: z.enum(["asc", "desc"]) }))
    .max(100)
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
