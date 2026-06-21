import type { SchemaMap } from "./catalog"
import type { PolicyFn, PolicyResult, DefaultContext } from "./policy"
import type { ValvAdapter } from "./adapter"
import { QuerySchema } from "./ast"
import { assertWithinLimits } from "./limits"
import { evaluateRead } from "./evaluate"
import { validateQuery } from "./validate"
import { injectPolicy } from "./inject"
import { serializeResult } from "./serializer"
import { ValidationError, PolicyViolationError } from "./errors"

// Hardcoded query bounds — surfaced as config only if a real need appears.
const MAX_LIMIT = 1000
const DEFAULT_LIMIT = 100

export interface ValvConfig<TContext = DefaultContext, TResources extends string = string> {
  adapter: ValvAdapter
  defaultPolicy?: "deny-all" | "allow-all"
  /** Warn (false, default) or throw (true) when policy() names an unknown resource. */
  strictPolicyKeys?: boolean
  /** Fallback policy for resources without an explicit policy() call. */
  resolvePolicy?: (resource: TResources, ctx: TContext) => PolicyResult
  /** Called after every executeTool, successful or not. */
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
   * Tool definitions exposed to the model.
   *
   * TODO(json-ast): emit the single AST query tool, its input schema derived
   * from the Catalog + evaluated policy. Returns [] until the query path lands.
   */
  async getTools(_ctx: TContext, _options?: GetToolsOptions<TResources>): Promise<LLMTool[]> {
    const schema = await this.loadSchema()
    this.validatePolicyKeys(schema)
    this.buildEffectivePolicies(schema) // resolves wildcard/fallback so it's validated too
    return []
  }

  /**
   * Execute a model tool call. The only tool is "query": its input is a JSON
   * AST that is structurally validated, semantically checked against the catalog
   * + policy, policy-injected, emitted to SQL, and run.
   */
  async executeTool(toolName: string, input: unknown, ctx: TContext): Promise<unknown> {
    const start = Date.now()
    const resource = (
      typeof input === "object" && input !== null && "from" in input
        ? String((input as { from: unknown }).from)
        : toolName
    ) as TResources
    let error: Error | undefined
    try {
      if (toolName !== "query") throw new ValidationError(`Unknown tool "${toolName}".`)
      return await this.runQuery(input, ctx)
    } catch (e) {
      // Surface valv's own (safe, actionable) errors; replace anything else —
      // Zod, RangeError, raw driver errors — with a generic message so internal
      // details never reach the caller. The original is kept for onQuery.
      error = e as Error
      throw toSafeError(error)
    } finally {
      this.onQueryFn?.({
        toolName,
        resource,
        operation: "query",
        ctx,
        durationMs: Date.now() - start,
        error,
      })
    }
  }

  private async runQuery(input: unknown, ctx: TContext): Promise<unknown> {
    assertWithinLimits(input)
    const query = QuerySchema.parse(input)
    const catalog = await this.loadSchema()
    if (!hasOwn(catalog.resources, query.from)) {
      throw new ValidationError(`Unknown resource "${query.from}".`)
    }
    const resource = catalog.resources[query.from]

    const policies = this.buildEffectivePolicies(catalog)
    const policy = hasOwn(policies, query.from) ? policies[query.from] : undefined
    const evaluated = evaluateRead(policy, ctx, resource, this.defaultPolicy)
    if (!evaluated.allowed) throw new PolicyViolationError(`Read access to "${query.from}" is denied.`)

    validateQuery(query, resource, evaluated, MAX_LIMIT)
    const injected = injectPolicy(query, evaluated, DEFAULT_LIMIT, MAX_LIMIT)
    const compiled = this.adapter.compile(injected, catalog)
    const rows = await this.adapter.execute(
      compiled.sql,
      compiled.params.map((p) => p.value),
    )
    return serializeResult(rows)
  }

  /** Introspect the schema once and cache it. */
  async loadSchema(): Promise<SchemaMap> {
    this.schemaCache ??= await this.adapter.introspect()
    return this.schemaCache
  }

  /** Resource names discovered from the schema. */
  async resources(): Promise<TResources[]> {
    const schema = await this.loadSchema()
    return Object.keys(schema.resources) as TResources[]
  }

  /** Schema info + policy stubs for every resource — useful for discovering names. */
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

  // Expands the "*" wildcard and resolvePolicy fallback into a concrete
  // per-resource map. Pure given the schema, so callers can validate eagerly.
  private buildEffectivePolicies(schema: SchemaMap): Record<string, PolicyFn<TContext>> {
    const wildcard = this.policies["*"]
    const resolver = this.resolvePolicyFn
    if (!wildcard && !resolver) return this.policies

    const effective: Record<string, PolicyFn<TContext>> = { ...this.policies }
    for (const resourceName of Object.keys(schema.resources)) {
      if (effective[resourceName]) continue
      if (wildcard) {
        effective[resourceName] = wildcard
      } else if (resolver) {
        const captured = resourceName as TResources
        effective[resourceName] = (ctx: TContext) => resolver(captured, ctx)
      }
    }
    delete effective["*"]
    return effective
  }

  private validatePolicyKeys(schema: SchemaMap): void {
    const resourceNames = new Set(Object.keys(schema.resources))
    for (const key of Object.keys(this.policies)) {
      if (key === "*" || resourceNames.has(key)) continue
      const msg = `[valv] policy() named unknown resource "${key}". Known: ${[...resourceNames].join(", ")}. Use await valv.describe() to list them.`
      if (this.strictPolicyKeys) throw new Error(msg)
      console.warn(msg)
    }
  }
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

// valv's own errors are author-written and safe for the caller to act on; any
// other throwable may carry internal details (SQL, paths, schema), so it's
// replaced with a generic message.
function toSafeError(err: Error): Error {
  if (err instanceof ValidationError || err instanceof PolicyViolationError) return err
  return new ValidationError("The query could not be processed.")
}

function buildPolicyStub(resourceName: string): string {
  return [
    `valv.policy("${resourceName}", (ctx) => ({`,
    `  read: true,    // or false, or { field: ctx.value } for a row filter`,
    `  write: false,  // or true, or { field: ctx.value } to force fields`,
    `  delete: false,`,
    `  // fields: { deny: ["sensitive_field"] },`,
    `  // relations: { relName: false },`,
    `}))`,
  ].join("\n")
}
