import { SchemaMap, PolicyFn, PolicyResult, DefaultContext } from "./types"
import { ValidationError } from "./errors"

export interface ValvConfig<TContext = DefaultContext, TResources extends string = string> {
  adapter: ValvAdapter
  defaultPolicy?: "deny-all" | "allow-all"
  /** Warn (false, default) or throw (true) when policy() is called with an unknown resource name */
  strictPolicyKeys?: boolean
  /** Fallback policy resolver for resources without an explicit policy() call */
  resolvePolicy?: (resource: TResources, ctx: TContext) => PolicyResult
  /** Called after every executeTool invocation, successful or not */
  onQuery?: (event: QueryEvent<TContext, TResources>) => void
}

export interface QueryEvent<TContext, TResources extends string = string> {
  toolName: string
  resource: TResources
  operation: string
  ctx: TContext
  durationMs: number
  error?: Error
}

export interface GetToolsOptions<TResources extends string = string> {
  resources?: TResources[]
  maxTools?: number
  mode?: "per-resource" | "consolidated"
}

export interface LLMTool {
  name: string
  description: string
  input_schema: object
}

export interface ResourceField {
  name: string
  type: string
  isId: boolean
  isNullable: boolean
  hasDefaultValue: boolean
  sensitive: boolean
}

export interface ResourceRelation {
  name: string
  target: string
  type: "belongsTo" | "hasMany" | "manyToMany"
}

export interface ResourceDescriptor {
  name: string
  fields: ResourceField[]
  relations: ResourceRelation[]
  policyStub: string
}

/**
 * Adapters expose the schema and run finished SQL. The query-construction layer
 * (JSON AST → policy injection → SQL compilation) is built on top of this; an
 * adapter never sees the AST, only the compiled, parameterized statement.
 */
export interface ValvAdapter {
  introspect(): Promise<SchemaMap>
  /**
   * Execute a compiled, parameterized SQL statement and return the result rows.
   * Parameters are positional; the SQL dialect decides the placeholder syntax.
   */
  execute(sql: string, parameters?: unknown[]): Promise<unknown[]>
}

export class Valv<TContext = DefaultContext, TResources extends string = string> {
  private adapter: ValvAdapter
  private defaultPolicy: "deny-all" | "allow-all"
  private policies: Record<string, PolicyFn<TContext>> = {}
  private schemaCache: SchemaMap | null = null
  private strictPolicyKeys: boolean
  private resolvePolicyFn?: (resource: TResources, ctx: TContext) => PolicyResult
  private onQueryFn?: (event: QueryEvent<TContext, TResources>) => void

  constructor(config: ValvConfig<TContext, TResources>) {
    this.adapter = config.adapter
    this.defaultPolicy = config.defaultPolicy ?? "deny-all"
    this.strictPolicyKeys = config.strictPolicyKeys ?? false
    this.resolvePolicyFn = config.resolvePolicy
    this.onQueryFn = config.onQuery
  }

  /** Register an access policy for a resource. Use "*" as a wildcard fallback. */
  policy(resource: TResources | "*", fn: PolicyFn<TContext>): this {
    this.policies[resource] = fn
    return this
  }

  /**
   * Generate the tool definitions exposed to the model.
   *
   * TODO(json-ast): emit the single AST query tool whose input schema is derived
   * from the catalog + evaluated policy. Returns [] until the new query path lands.
   */
  async getTools(_ctx: TContext, _options?: GetToolsOptions<TResources>): Promise<LLMTool[]> {
    const schema = await this.loadSchema()
    this.validatePolicyKeys(schema)
    // The effective policy set is resolved here so wildcard/resolver fallbacks
    // are validated even before any tool is generated.
    this.buildEffectivePolicies(schema)
    return []
  }

  /**
   * Execute a model tool call.
   *
   * TODO(json-ast): validate the AST → inject policy filters → compile to SQL
   * (Kysely) → adapter.execute(). Throws until the new query path lands.
   */
  async executeTool(toolName: string, _input: unknown, ctx: TContext): Promise<unknown> {
    const start = Date.now()
    const err = new ValidationError(
      "valv: the query execution path is being rebuilt on the JSON AST; executeTool() is not implemented yet.",
    )
    if (this.onQueryFn) {
      this.onQueryFn({
        toolName,
        resource: toolName as TResources,
        operation: toolName,
        ctx,
        durationMs: Date.now() - start,
        error: err,
      })
    }
    throw err
  }

  async loadSchema(): Promise<SchemaMap> {
    if (!this.schemaCache) {
      this.schemaCache = await this.adapter.introspect()
    }
    return this.schemaCache
  }

  /** Returns the list of resource names discovered from the schema. */
  async resources(): Promise<TResources[]> {
    const schema = await this.loadSchema()
    return Object.keys(schema.resources) as TResources[]
  }

  /** Returns schema info + policy stubs for all resources — useful for discovering resource names. */
  async describe(): Promise<ResourceDescriptor[]> {
    const schema = await this.loadSchema()
    return Object.values(schema.resources).map((r) => ({
      name: r.name,
      fields: Object.values(r.fields).map((f) => ({
        name: f.name,
        type: f.type,
        isId: f.isId,
        isNullable: f.isNullable,
        hasDefaultValue: f.hasDefaultValue ?? false,
        sensitive: f.sensitive ?? false,
      })),
      relations: Object.values(r.relations).map((rel) => ({
        name: rel.name,
        target: rel.targetResource,
        type: rel.type,
      })),
      policyStub: buildPolicyStub(r.name),
    }))
  }

  private buildEffectivePolicies(schema: SchemaMap): Record<string, PolicyFn<TContext>> {
    const wildcard = this.policies["*"]
    const resolver = this.resolvePolicyFn

    if (!wildcard && !resolver) return this.policies

    const effective: Record<string, PolicyFn<TContext>> = { ...this.policies }
    for (const resourceName of Object.keys(schema.resources)) {
      if (!effective[resourceName]) {
        if (wildcard) {
          effective[resourceName] = wildcard
        } else if (resolver) {
          const captured = resourceName as TResources
          effective[resourceName] = (ctx: TContext) => resolver(captured, ctx)
        }
      }
    }
    delete effective["*"]
    return effective
  }

  private validatePolicyKeys(schema: SchemaMap): void {
    const resourceNames = new Set(Object.keys(schema.resources))
    for (const key of Object.keys(this.policies)) {
      if (key === "*") continue
      if (!resourceNames.has(key)) {
        const msg = `[valv] policy() called with unknown resource "${key}". Known resources: ${[...resourceNames].join(", ")}. Use await valv.describe() to list them.`
        if (this.strictPolicyKeys) throw new Error(msg)
        else console.warn(msg)
      }
    }
  }
}

function buildPolicyStub(resourceName: string): string {
  return [
    `valv.policy("${resourceName}", (ctx) => ({`,
    `  read: true,    // or false, or { field: ctx.value } for row-level filter`,
    `  write: false,  // or true, or { field: ctx.value } to auto-inject forced fields`,
    `  delete: false,`,
    `  // fields: { deny: ["sensitive_field"] },`,
    `  // relations: { relName: false },`,
    `}))`,
  ].join("\n")
}
