import { Valv } from "@valv/core"
import type { DefaultContext, ValvConfig } from "@valv/core"
import { ClickHouseAdapter, type ClickHouseAdapterOptions } from "./adapter"
import type { ClickHouseClient } from "./introspection"

type CreateConfig<TContext> = Omit<ValvConfig<TContext, string>, "adapter"> &
  ClickHouseAdapterOptions

export function createValv<TContext = DefaultContext>(
  client: ClickHouseClient,
  config?: CreateConfig<TContext>,
): Valv<TContext, string> {
  const { database, schema, ...rest } = config ?? {}
  return new Valv<TContext, string>({
    ...rest,
    adapter: new ClickHouseAdapter(client, { database, schema }),
  })
}
