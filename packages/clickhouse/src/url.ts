import type { Valv, DefaultContext, ValvConfig } from "@valv/core"
import { createValv } from "./create"
import type { ClickHouseClient } from "./introspection"
import type { ClickHouseAdapterOptions } from "./adapter"

export interface ValvFromUrl<TContext> {
  valv: Valv<TContext, string>
  /** Close the ClickHouse client connection. */
  stop: () => Promise<void>
}

type FromUrlConfig<TContext> = Omit<ValvConfig<TContext, string>, "adapter"> &
  ClickHouseAdapterOptions

/**
 * Build a policy-gated valv instance from just a ClickHouse URL — constructs the
 * client and introspects the live database. Use when the project has no
 * ClickHouse client wired up. Requires the `@clickhouse/client` peer dependency.
 *
 * Call `stop()` to close the connection.
 */
export async function createValvFromUrl<TContext = DefaultContext>(
  url: string,
  config?: FromUrlConfig<TContext>,
): Promise<ValvFromUrl<TContext>> {
  const { createClient } = await import("@clickhouse/client")
  const client = createClient({ url, database: config?.database })
  const stop = () => client.close()
  try {
    // strictPolicyKeys defaults to true: resources are introspected at runtime
    // and untyped, so a misspelled policy key would silently no-op otherwise.
    const valv = createValv<TContext>(client as unknown as ClickHouseClient, {
      strictPolicyKeys: true,
      ...config,
    })
    return { valv, stop }
  } catch (err) {
    await stop()
    throw err
  }
}
