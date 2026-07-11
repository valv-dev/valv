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
  .describe(
    'Relation path from the root resource to a joined table, e.g. ["order","customer"]. Only declared relations are joinable.',
  )

// Recursive schema: annotate via cast, the idiomatic Zod pattern (the inferred
// output differs only in that z.unknown() makes `value` optional).
export const ExprSchema = z.lazy(() =>
  z
    .union([
      z
        .object({ kind: z.literal("col"), name: z.string(), rel: relPath.optional() })
        .describe('A column reference: { "kind": "col", "name": "amount" }.'),
      z
        .object({
          kind: z.literal("value"),
          value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
        })
        .describe('A literal value: { "kind": "value", "value": 100 }.'),
      z
        .object({ kind: z.literal("cmp"), op: cmpOp, left: ExprSchema, right: ExprSchema })
        .describe(
          'Comparison: { "kind": "cmp", "op": ">=", "left": <Expr>, "right": <Expr> }. Both sides are Expr nodes, typically a col and a value.',
        ),
      z
        .object({ kind: z.literal("and"), args: z.array(ExprSchema).min(1).max(100) })
        .describe('All sub-expressions must hold: { "kind": "and", "args": [<Expr>, ...] }.'),
      z
        .object({ kind: z.literal("or"), args: z.array(ExprSchema).min(1).max(100) })
        .describe('Any sub-expression holds: { "kind": "or", "args": [<Expr>, ...] }.'),
      z
        .object({ kind: z.literal("not"), arg: ExprSchema })
        .describe('Negates one sub-expression: { "kind": "not", "arg": <Expr> }.'),
    ])
    .describe(
      "A boolean filter expression tree of tagged nodes (cmp/and/or/not over col/value), not a raw string.",
    ),
) as unknown as z.ZodType<Expr>

// `as`/`fn` are output/function names, constrained to safe characters here.
// Column references (`col`, and columns inside function args) are instead
// allowlist-checked against the catalog downstream, in validate.ts.
const identifier = z.string().regex(/^[A-Za-z0-9_]+$/)

const columnSelect = z
  .object({
    col: z.string().describe("Column name. A column is always this wrapper, never a bare string."),
    rel: relPath.optional(),
    as: identifier.optional(),
  })
  .describe('Select a column: { "col": "amount" }. `as` renames the output; `rel` reads a joined table.')
const fnSelect = z
  .object({
    fn: identifier,
    args: z
      .array(ExprSchema)
      .max(8)
      .describe(
        'Positional arguments, each an Expr node — a column is { "kind": "col", "name": "amount" } (not a bare string), a literal is { "kind": "value", "value": ... }.',
      ),
    as: identifier.optional(),
  })
  .describe(
    'A function call over columns: { "fn": "sum", "args": [{ "kind": "col", "name": "amount" }], "as": "total" }.',
  )

// A group key: a bare SELECT alias, or a (possibly joined) column.
const groupByItem = z
  .union([z.string(), z.object({ col: z.string(), rel: relPath.optional() })])
  .describe(
    'Group key: a bare SELECT alias string (e.g. "day") to bucket by a computed column, or { "col": "name" } for a raw column.',
  )

export const QuerySchema = z.object({
  from: z.string(),
  select: z
    .array(z.union([fnSelect, columnSelect]))
    .min(1)
    .max(32),
  where: ExprSchema.optional(),
  groupBy: z.array(groupByItem).max(32).optional(),
  orderBy: z
    .array(
      z
        .object({ col: z.string(), rel: relPath.optional(), dir: z.enum(["asc", "desc"]) })
        .describe(
          'Sort key: `col` is a SELECT alias (e.g. an aggregate like "revenue") or a raw column name; `dir` is "asc" or "desc".',
        ),
    )
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
