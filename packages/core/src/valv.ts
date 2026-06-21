import type { SchemaMap } from "./catalog"
import type { PolicyFn, PolicyResult, DefaultContext } from "./policy"
import type { ValvAdapter } from "./adapter"
import { QuerySchema } from "./ast"
import { assertWithinLimits } from "./limits"
import { evaluateRead } from "./evaluate"
import { validateQuery } from "./validate"
import { injectPolicy } from "./inject"
import { serializeResult } from "./serializer"
import { resultSchema as deriveResultSchema, type ResultColumn } from "./result-schema"
import { buildTools, type DiscoveryToggle } from "./tools"
import { visibleResources } from "./tools/discovery"
import {
  anthropic,
  openai,
  gemini,
  type NeutralTool,
  type AnthropicTool,
  type OpenAITool,
  type GeminiTool,
} from "./formatters"
import { toAiSdk } from "./formatters/ai-sdk"
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
  /** Called after every run, successful or not. */
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
   * Run a query and return its serialized rows. The query is structurally
   * validated, semantically checked against the catalog + policy, policy-
   * injected, emitted to SQL, and executed. This is the single read primitive:
   * the query tool's handler calls it, and replaying a stored query is the same
   * call — so a saved query can never outrank or drift from a fresh one.
   */
  async run(query: unknown, ctx: TContext): Promise<unknown> {
    const start = Date.now()
    const resource = extractResource(query) as TResources
    let error: Error | undefined
    try {
      return await this.runQuery(query, ctx)
    } catch (e) {
      // Surface valv's own (safe, actionable) errors; replace anything else —
      // Zod, RangeError, raw driver errors — with a generic message so internal
      // details never reach the caller. The original is kept for onQuery.
      error = e as Error
      throw toSafeError(error)
    } finally {
      this.onQueryFn?.({ toolName: "query", resource, operation: "query", ctx, durationMs: Date.now() - start, error })
    }
  }

  /**
   * The output columns + coarse types a query will return, derived from its
   * select list + catalog without executing it. Drives dashboard rendering and
   * detects drift in a stored query. Requires the schema to be loaded (it is,
   * after createValv).
   */
  resultSchema(query: unknown): ResultColumn[] {
    const parsed = QuerySchema.parse(query)
    return deriveResultSchema(parsed, this.requireSchema(), this.adapter.functions())
  }

  /**
   * Tools for the model — `query` plus the discovery tools — formatted per
   * provider and bound to `ctx`. Each format takes an optional
   * `{ list, search, describe }` toggle to drop a discovery tool (`query` always
   * stays). Returned tools are policy-filtered: discovery only surfaces what this
   * caller may read.
   */
  get tools() {
    return {
      neutral: (ctx: TContext, toggle?: DiscoveryToggle): NeutralTool[] =>
        this.neutralTools(ctx, toggle),
      anthropic: (ctx: TContext, toggle?: DiscoveryToggle): AnthropicTool[] =>
        this.neutralTools(ctx, toggle).map(anthropic),
      openai: (ctx: TContext, toggle?: DiscoveryToggle): OpenAITool[] =>
        this.neutralTools(ctx, toggle).map(openai),
      gemini: (ctx: TContext, toggle?: DiscoveryToggle): GeminiTool[] =>
        this.neutralTools(ctx, toggle).map(gemini),
      // Vercel AI SDK tool set (async — imports the optional `ai` peer dep).
      aisdk: (ctx: TContext, toggle?: DiscoveryToggle) =>
        toAiSdk(this.neutralTools(ctx, toggle)),
    }
  }

  /**
   * Handle a model tool call by name, dispatching to `query` or a discovery tool
   * and returning its result. Used to drive a raw provider loop; framework
   * integrations call a tool's `execute` directly instead.
   */
  async runTool(name: string, input: unknown, ctx: TContext): Promise<unknown> {
    const tool = this.neutralTools(ctx).find((t) => t.name === name)
    if (!tool) throw new ValidationError(`Unknown tool "${name}".`)
    return tool.execute(input)
  }

  /** @deprecated Use {@link runTool}; kept until the MCP SDK migrates. */
  async executeTool(name: string, input: unknown, ctx: TContext): Promise<unknown> {
    return this.runTool(name, input, ctx)
  }

  private neutralTools(ctx: TContext, toggle?: DiscoveryToggle): NeutralTool[] {
    const catalog = this.requireSchema()
    const policies = this.buildEffectivePolicies(catalog)
    const visible = visibleResources(catalog, policies, this.defaultPolicy, ctx)
    return buildTools({
      ctx,
      visible,
      functionNames: Object.keys(this.adapter.functions()),
      run: (query, c) => this.run(query, c),
      toggle,
    })
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

  // The loaded schema, for the synchronous paths (resultSchema). createValv
  // primes the cache, so this is populated for factory-built instances.
  private requireSchema(): SchemaMap {
    if (!this.schemaCache) {
      throw new Error("[valv] schema not loaded — build the instance with createValv(), which introspects on construction.")
    }
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

// The resource a query targets, for the audit event — best-effort, since the
// input isn't validated yet when the event's resource is captured.
function extractResource(input: unknown): string {
  return typeof input === "object" && input !== null && "from" in input
    ? String((input as { from: unknown }).from)
    : "unknown"
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
