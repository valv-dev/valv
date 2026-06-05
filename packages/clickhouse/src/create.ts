import { Vistal } from "@vistal/core"
import type { DefaultContext, VistalConfig } from "@vistal/core"
import { ClickHouseAdapter, type ClickHouseAdapterOptions } from "./adapter"
import type { ClickHouseClient } from "./introspection"

type CreateConfig<TContext> = Omit<VistalConfig<TContext, string>, "adapter"> &
  ClickHouseAdapterOptions

export function createVistal<TContext = DefaultContext>(
  client: ClickHouseClient,
  config?: CreateConfig<TContext>,
): Vistal<TContext, string> {
  const { database, ...rest } = config ?? {}
  return new Vistal<TContext, string>({
    ...rest,
    adapter: new ClickHouseAdapter(client, { database }),
  })
}
