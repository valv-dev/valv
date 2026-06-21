export { Valv } from "./valv"
export type {
  LLMTool,
  GetToolsOptions,
  QueryEvent,
  ResourceDescriptor,
  ResourceField,
  ResourceRelation,
  ValvConfig,
} from "./valv"
export type { ValvAdapter, CompiledQuery, BoundParam } from "./adapter"
export { QuerySchema, ExprSchema } from "./ast"
export type { Query, Expr, SelectItem, ColumnSelect, FnSelect, OrderBy, CmpOp } from "./ast"
export { emit } from "./emit"
export type { Dialect } from "./dialect"
export { BASE_FUNCTIONS } from "./functions"
export type { FnDef, ArgSpec, FnReturn } from "./functions"
export { resultSchema } from "./result-schema"
export type { ResultColumn } from "./result-schema"
export type { DiscoveryToggle } from "./tools"

export type {
  SchemaMap,
  ResourceSchema,
  FieldSchema,
  FieldType,
  RelationSchema,
  InferResources,
} from "./catalog"
export type { PolicyFn, PolicyResult, PolicyRule, FieldPolicy, DefaultContext } from "./policy"

export { serializeResult } from "./serializer"
export { PolicyViolationError, ValidationError } from "./errors"

// Tool formatters — turn a provider-neutral tool into a provider-specific shape.
export * as formats from "./formatters"
export { anthropic, openai, gemini } from "./formatters"
export type {
  ToolFormatter,
  NeutralTool,
  AnthropicTool,
  OpenAITool,
  GeminiTool,
} from "./formatters"
