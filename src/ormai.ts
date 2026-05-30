import { SchemaMap, PolicyFn, PolicyResult, DefaultContext } from "./types"
import { ResolvedQuery } from "./ir/types"
import { buildResolvedQuery } from "./ir/builder"
import { generateTools } from "./tools/generator"
import { serializeResult } from "./serializer"

export interface ORMAIConfig<TContext = DefaultContext, TResources extends string = string> {
  adapter: ORMAIAdapter
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
}

export interface LLMTool {
  name: string
  description: string
  input_schema: object
}

export interface ExecutableTool extends LLMTool {
  execute: (args: unknown) => Promise<unknown>
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

export interface ORMAIAdapter {
  introspect(): Promise<SchemaMap>
  execute(query: ResolvedQuery): Promise<unknown>
}

export class ORMAI<TContext = DefaultContext, TResources extends string = string> {
  private adapter: ORMAIAdapter
  private defaultPolicy: "deny-all" | "allow-all"
  private policies: Record<string, PolicyFn<TContext>> = {}
  private schemaCache: SchemaMap | null = null
  private strictPolicyKeys: boolean
  private resolvePolicyFn?: (resource: TResources, ctx: TContext) => PolicyResult
  private onQueryFn?: (event: QueryEvent<TContext, TResources>) => void

  constructor(config: ORMAIConfig<TContext, TResources>) {
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

  async getTools(ctx: TContext, options?: GetToolsOptions<TResources>): Promise<LLMTool[]> {
    const schema = await this.loadSchema()
    this.validatePolicyKeys(schema)
    return generateTools(schema, this.buildEffectivePolicies(schema), ctx, this.defaultPolicy, options)
  }

  /** Returns tools with execute() attached and result serialization (Decimal/Date/BigInt) built in. */
  async executableTools(ctx: TContext, options?: GetToolsOptions<TResources>): Promise<ExecutableTool[]> {
    const llmTools = await this.getTools(ctx, options)
    return llmTools.map(t => ({
      ...t,
      execute: async (args: unknown) => {
        const result = await this.executeTool(t.name, args, ctx)
        return serializeResult(result)
      },
    }))
  }

  async executeTool(toolName: string, input: unknown, ctx: TContext): Promise<unknown> {
    const start = Date.now()
    let caughtError: Error | undefined

    try {
      const schema = await this.loadSchema()
      const query = buildResolvedQuery(
        toolName,
        input,
        schema,
        this.buildEffectivePolicies(schema),
        ctx,
        this.defaultPolicy
      )
      return await this.adapter.execute(query)
    } catch (e) {
      caughtError = e as Error
      throw e
    } finally {
      if (this.onQueryFn) {
        const underscoreIdx = toolName.indexOf("_")
        const operation = underscoreIdx === -1 ? toolName : toolName.slice(0, underscoreIdx)
        const resource = underscoreIdx === -1 ? toolName : toolName.slice(underscoreIdx + 1)
        this.onQueryFn({
          toolName,
          resource: resource as TResources,
          operation,
          ctx,
          durationMs: Date.now() - start,
          error: caughtError,
        })
      }
    }
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
    return Object.values(schema.resources).map(r => ({
      name: r.name,
      fields: Object.values(r.fields).map(f => ({
        name: f.name,
        type: f.type,
        isId: f.isId,
        isNullable: f.isNullable,
        hasDefaultValue: f.hasDefaultValue ?? false,
        sensitive: f.sensitive ?? false,
      })),
      relations: Object.values(r.relations).map(rel => ({
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
        const msg = `[ormai] policy() called with unknown resource "${key}". Known resources: ${[...resourceNames].join(", ")}. Use await ormai.describe() to list them.`
        if (this.strictPolicyKeys) throw new Error(msg)
        else console.warn(msg)
      }
    }
  }
}

function buildPolicyStub(resourceName: string): string {
  return [
    `ormai.policy("${resourceName}", (ctx) => ({`,
    `  read: true,    // or false, or { field: ctx.value } for row-level filter`,
    `  write: false,  // or true, or { field: ctx.value } to auto-inject forced fields`,
    `  delete: false,`,
    `  // fields: { deny: ["sensitive_field"] },`,
    `  // relations: { relName: false },`,
    `}))`,
  ].join("\n")
}
