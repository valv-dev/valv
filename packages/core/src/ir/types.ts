import type { CursorKeyset } from "./cursor"

export interface ResolvedQuery {
  resource: string
  operation: "find" | "findOne" | "create" | "update" | "delete" | "aggregate"

  // Filters — already merged with policy row filters
  filters?: FilterNode

  // Fields to return — already stripped by policy
  fields: string[]

  // Fields the builder added solely for cursor bookkeeping (primary key / sort
  // field). The adapter must SELECT them but strip them from returned rows.
  internalFields?: string[]

  // Relations to include — already filtered by policy
  include?: Record<string, ResolvedInclude>

  // For find operations
  sort?: SortClause
  pagination?: PaginationClause

  // For aggregate operations
  aggregations?: AggregationClause[]
  groupBy?: string[]
  having?: FilterNode

  // For create/update
  data?: Record<string, unknown>
}

export interface ResolvedInclude {
  resource: string
  type: "belongsTo" | "hasMany" | "manyToMany"
  foreignKey: string
  fields: string[]
  filters?: FilterNode   // relation's own policy filters injected here
}

// Filter nodes — composable
export type FilterNode =
  | EqFilter
  | InFilter
  | RangeFilter
  | LikeFilter
  | NullFilter
  | AndFilter
  | OrFilter
  | NotFilter

export interface EqFilter    { type: "eq";    field: string; value: unknown }
export interface InFilter    { type: "in";    field: string; values: unknown[] }
export interface RangeFilter { type: "range"; field: string; gte?: unknown; lte?: unknown; gt?: unknown; lt?: unknown }
export interface LikeFilter  { type: "like";  field: string; value: string; mode?: "contains" | "startsWith" | "endsWith" }
export interface NullFilter  { type: "null";  field: string; isNull: boolean }
export interface AndFilter   { type: "and";   filters: FilterNode[] }
export interface OrFilter    { type: "or";    filters: FilterNode[] }
export interface NotFilter   { type: "not";   filter: FilterNode }

export interface SortClause {
  field: string
  direction: "asc" | "desc"
}

export interface PaginationClause {
  limit?: number
  offset?: number
  cursor?: string            // raw token as received (reference/debug)
  keyset?: CursorKeyset      // decoded keyset when a valid cursor was supplied
  primaryKey: string         // pk field name — always set by the builder for finds
  cursorField: string        // field nextCursor is keyed on (the effective sort field)
}

export interface AggregationClause {
  fn: "count" | "sum" | "avg" | "min" | "max"
  field: string
  alias: string
}
