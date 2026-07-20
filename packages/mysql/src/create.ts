import { Valv } from "@valv/core"
import type { DefaultContext, ValvConfig, SchemaMap } from "@valv/core"
import { MySqlAdapter } from "./adapter"
import type { MySqlClient } from "./introspection"

type CreateConfig<TContext> = Omit<ValvConfig<TContext, string>, "adapter"> & {
  /** `"introspect"` the live database, or supply a hand-defined schema. */
  schema: "introspect" | SchemaMap
  /** Database to introspect and qualify tables with. Defaults to the connection's current database. */
  database?: string
}

/**
 * Build a policy-gated valv instance over a mysql2/promise client. Loads the
 * schema on construction (introspecting, or using the supplied one), so the
 * returned instance is ready to use. The caller owns the client's connection
 * lifecycle — pass a dedicated connection, not a shared pool.
 */
export async function createValv<TContext = DefaultContext>(
  client: MySqlClient,
  config: CreateConfig<TContext>,
): Promise<Valv<TContext, string>> {
  const { schema, database, ...rest } = config
  const valv = new Valv<TContext, string>({
    ...rest,
    adapter: new MySqlAdapter(client, {
      schema: schema === "introspect" ? undefined : schema,
      database,
    }),
  })
  await valv.loadSchema()
  return valv
}
