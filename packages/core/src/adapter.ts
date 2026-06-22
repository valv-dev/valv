import type { SchemaMap } from "./catalog"
import type { Query, InjectedMutation } from "./ast"
import type { FnDef } from "./functions"

export interface BoundParam {
  value: unknown
  type: string // dialect type used in the placeholder, e.g. "UInt32"
}

export interface CompiledQuery {
  sql: string
  params: BoundParam[]
}

export interface MutationResult {
  affected: number
}

/**
 * The database boundary. Core validates and policy-checks the AST, then hands it
 * to the adapter to emit dialect SQL (`compile`) and run it (`execute`). The
 * adapter never sees the policy — security logic stays in core.
 */
export interface ValvAdapter {
  introspect(): Promise<SchemaMap>
  /** Emit dialect SQL for a validated, policy-injected query. */
  compile(query: Query, catalog: SchemaMap): CompiledQuery
  /** Run a compiled statement. Parameters are positional values. */
  execute(sql: string, parameters?: unknown[]): Promise<unknown[]>
  /** The functions callable in this dialect (base ∪ dialect), for output-shape
   *  prediction and tool discovery. */
  functions(): Record<string, FnDef>
  /** Run a validated, policy-injected write. Optional — adapters without write
   *  support (or for unsupported ops) throw. */
  mutate?(mutation: InjectedMutation, catalog: SchemaMap): Promise<MutationResult>
}
