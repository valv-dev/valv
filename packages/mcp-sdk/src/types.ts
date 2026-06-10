import type { GetToolsOptions } from "@vistal/core"

/**
 * A policy context resolver: either a fixed value or a function (sync or async)
 * called per MCP request, so policy is always evaluated against fresh context.
 */
export type ContextResolver<TContext> = TContext | (() => TContext | Promise<TContext>)

export interface VistalMcpOptions<TContext> {
  /**
   * Context passed to vistal's policy engine. A fixed value, or a resolver
   * called on every request — handy for sourcing identity from env vars
   * (e.g. VISTAL_ROLE / VISTAL_TENANT) or, over HTTP, from request headers.
   */
  context: ContextResolver<TContext>
  /**
   * Tool generation mode. Defaults to "consolidated" — a small fixed verb set
   * (list_resources, describe_resource, query, get, create, update, delete,
   * aggregate) that the agent uses to discover the schema at runtime. Best for
   * MCP because the tool count stays low and stable. "per-resource" emits one
   * tool per resource×operation instead.
   */
  mode?: "consolidated" | "per-resource"
  /** Forwarded to vistal — restrict to specific resources and/or cap tool count. */
  toolOptions?: Omit<GetToolsOptions, "mode">
  /** Advertised MCP server identity. Defaults to { name: "vistal", version }. */
  serverInfo?: { name: string; version: string }
}
