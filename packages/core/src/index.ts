export { Vistal } from "./vistal"
export type {
  LLMTool,
  ExecutableTool,
  FormattedTool,
  GetToolsOptions,
  QueryEvent,
  ResourceDescriptor,
  ResourceField,
  ResourceRelation,
  VistalAdapter,
  VistalConfig,
  PaginationConfig,
} from "./vistal"
export { serializeResult } from "./serializer"
export { encodeCursor, decodeCursor } from "./ir/cursor"
export type { CursorKeyset } from "./ir/cursor"

// Tool formatters — turn a provider-neutral tool into a provider-specific shape.
// Built-ins are also reachable via `vistal.tools.<provider>(ctx)`.
export * as formats from "./formatters"
export { anthropic, openai, gemini } from "./formatters"
export type {
  ToolFormatter,
  AnthropicTool,
  OpenAITool,
  GeminiTool,
} from "./formatters"
export type { NeutralTool } from "./tools/generator"
export type {
  PolicyFn,
  PolicyResult,
  PolicyRule,
  FieldPolicy,
  DefaultContext,
  SchemaMap,
  ResourceSchema,
  FieldSchema,
  FieldType,
  RelationSchema,
  InferResources,
} from "./types"
export type { ResolvedQuery, FilterNode, ResolvedInclude, PaginationClause } from "./ir/types"
export { PolicyViolationError, ValidationError } from "./errors"
