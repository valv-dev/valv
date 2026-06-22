import type { ClickHouseClient } from "@valv/clickhouse"
import type { DefaultContext, FieldSchema } from "@valv/core"

export type QueryCall = {
  query: string
  query_params?: Record<string, unknown>
  clickhouse_settings?: Record<string, unknown>
}

export type FakeClient = ClickHouseClient & {
  /** Every query the adapter issued, in order — assert SQL/params against these. */
  calls: QueryCall[]
  /** Structured inserts captured from `insert()`. */
  inserts: { table: string; values: unknown[] }[]
}

/**
 * A fully-typed in-memory ClickHouse double. `rows` is what `query().json()`
 * resolves to — a fixed array or a function of the call (throw from it to
 * simulate a database error).
 */
export function fakeClient(rows: unknown[] | ((call: QueryCall) => unknown[]) = []): FakeClient {
  const calls: QueryCall[] = []
  const inserts: { table: string; values: unknown[] }[] = []
  return {
    calls,
    inserts,
    async query(params) {
      const call: QueryCall = {
        query: params.query,
        query_params: params.query_params,
        clickhouse_settings: params.clickhouse_settings,
      }
      calls.push(call)
      const data = typeof rows === "function" ? rows(call) : rows
      return { json: async () => data }
    },
    async insert(params) {
      inserts.push({ table: params.table, values: params.values })
      return {}
    },
  }
}

/** A `DefaultContext` for a member user, optionally tenant-scoped. */
export const memberCtx = (tenant?: string): DefaultContext => ({
  user: { id: "u1", role: "member" },
  ...(tenant ? { tenant: { id: tenant } } : {}),
})

/** Build a `FieldSchema`, defaulting the boilerplate flags. */
export const field = (
  name: string,
  type: FieldSchema["type"],
  nativeType: string,
  extra: Partial<FieldSchema> = {},
): FieldSchema => ({ name, type, nativeType, isNullable: false, isId: false, ...extra })
