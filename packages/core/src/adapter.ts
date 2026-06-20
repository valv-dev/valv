import type { SchemaMap } from "./catalog"

/**
 * The database boundary. valv compiles and policy-checks queries; an adapter
 * only reflects the schema and runs finished SQL — it never sees the AST or the
 * policy. This keeps backends thin and the security logic in one place.
 */
export interface ValvAdapter {
  introspect(): Promise<SchemaMap>
  /**
   * Run a compiled, parameterized statement and return the rows. Parameters are
   * positional; the SQL dialect decides the placeholder syntax.
   */
  execute(sql: string, parameters?: unknown[]): Promise<unknown[]>
}
