// The raw schema discovered from Prisma
export interface SchemaMap {
  resources: Record<string, ResourceSchema>
}

export interface ResourceSchema {
  name: string // "orders"
  tableName: string // "Order" (Prisma model name)
  fields: Record<string, FieldSchema>
  relations: Record<string, RelationSchema>
  description?: string // from /// @valv:description annotations
}

export interface FieldSchema {
  name: string
  type: FieldType
  isNullable: boolean
  isId: boolean
  hasDefaultValue?: boolean // field has a DB/schema default (e.g. @default(now()), @default(uuid()))
  enumValues?: string[] // if type is "enum"
  description?: string // from /// @valv:description annotations
  sensitive?: boolean // from /// @valv:sensitive annotations
}

export type FieldType = "string" | "number" | "boolean" | "date" | "enum" | "uuid" | "json"

export interface RelationSchema {
  name: string
  targetResource: string
  type: "belongsTo" | "hasMany" | "manyToMany"
  foreignKey: string
  junctionTable?: string // for manyToMany
}

// Policy definition — what the developer writes
export type PolicyFn<TContext = DefaultContext> = (ctx: TContext) => PolicyResult

// An operation rule: `true` = allow, `false` = deny, or an object describing a
// predicate. Object values use the same operator vocabulary the LLM filter
// schema exposes — `{ total: { lt: 1000 } }`, `{ status: { in: [...] } }`,
// `{ owner_id: ctx.user.id }` — plus the boolean combinators `OR` / `AND` /
// `NOT` for disjunctive rules. For reads/deletes the predicate is AND-ed into
// the WHERE clause; for writes its scalar equalities are force-injected into the
// row and the full predicate guards UPDATE/DELETE.
export type PolicyRule = boolean | Record<string, unknown>

export interface PolicyResult {
  read?: PolicyRule
  write?: PolicyRule // shorthand: applies to both create and update
  create?: PolicyRule // overrides `write` for inserts
  update?: PolicyRule // overrides `write` for updates
  delete?: PolicyRule
  aggregate?: PolicyRule // overrides `read` for aggregations
  fields?: FieldPolicy
  relations?: Record<string, boolean>
}

export interface FieldPolicy {
  allow?: string[] // whitelist
  deny?: string[] // blacklist
  readOnly?: string[] // readable but never writable (e.g. id, created_at, status)
  writeOnly?: string[] // writable but never returned (e.g. a settable secret)
  // if none specified: all (non-sensitive) fields allowed for both read and write
}

export interface DefaultContext {
  user: {
    id: string
    role: string
    [key: string]: unknown
  }
  tenant?: {
    id: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

// ── Type-level camelCase → snake_case ────────────────────────────────────────

type _CamelToSnake<S extends string> = S extends `${infer Head}${infer Tail}`
  ? Head extends Uppercase<Head>
    ? Head extends Lowercase<Head> // digit or non-alpha — pass through
      ? `${Head}${_CamelToSnake<Tail>}`
      : `_${Lowercase<Head>}${_CamelToSnake<Tail>}`
    : `${Head}${_CamelToSnake<Tail>}`
  : S

/**
 * Derives valv resource names (snake_case) from a Prisma client type.
 *
 * @example
 * const valv = new Valv<DefaultContext, InferResources<typeof prisma>>({ ... })
 * // policy() and getTools() are now type-safe with autocomplete for resource names
 */
export type InferResources<TClient> = _CamelToSnake<
  Exclude<keyof TClient, `$${string}` | symbol | number> & string
>
