import type { ToolToggle } from "@valv/core"

/**
 * A policy context resolver: either a fixed value or a function (sync or async)
 * called per MCP request, so policy is always evaluated against fresh context.
 */
export type ContextResolver<TContext> = TContext | (() => TContext | Promise<TContext>)

export interface ValvMcpOptions<TContext> {
  /**
   * Context passed to valv's policy engine. A fixed value, or a resolver
   * called on every request — handy for sourcing identity from env vars
   * or, over HTTP, from request headers.
   */
  context: ContextResolver<TContext>
  /**
   * Which discovery tools to expose alongside `query`. All on by default; set a
   * tool false to drop it (e.g. `{ list: false }`).
   */
  discovery?: ToolToggle
  /** Advertised MCP server identity. Defaults to { name: "valv", version }. */
  serverInfo?: { name: string; version: string }
}
