import { Valv } from "@valv/core"
import type { DefaultContext, ValvConfig, SchemaMap } from "@valv/core"
import { ClickHouseAdapter, type ClickHouseAdapterOptions } from "./adapter"
import type { ClickHouseClient } from "./introspection"

type CreateConfig<TContext> = Omit<ValvConfig<TContext, string>, "adapter"> &
  Omit<ClickHouseAdapterOptions, "schema"> & {
    /** `"introspect"` the live database, or supply a hand-defined schema. */
    schema: "introspect" | SchemaMap
  }

/**
 * Build a policy-gated valv instance over a ClickHouse client. Introspects the
 * schema on construction (or uses the supplied one), so the returned instance is
 * ready to use — `await` it once at startup.
 */
export async function createValv<TContext = DefaultContext>(
  client: ClickHouseClient,
  config: CreateConfig<TContext>,
): Promise<Valv<TContext, string>> {
  const { database, schema, ...rest } = config
  const valv = new Valv<TContext, string>({
    ...rest,
    adapter: new ClickHouseAdapter(client, {
      database,
      schema: schema === "introspect" ? undefined : schema,
    }),
  })
  await valv.loadSchema()
  return valv
}
