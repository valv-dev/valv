# @valv/clickhouse

ClickHouse adapter for [valv](../../README.md) — let an LLM run analytics over ClickHouse, scoped by policies you write in code. The model emits a structured query; valv validates it, injects your tenant/row filter, and compiles it to ClickHouse SQL.

[![npm](https://img.shields.io/npm/v/@valv/clickhouse)](https://www.npmjs.com/package/@valv/clickhouse) [![license](https://img.shields.io/npm/l/@valv/clickhouse)](../../LICENSE)

## Install

```bash
npm i @valv/clickhouse @clickhouse/client
```

## Usage

```ts
import { createClient } from "@clickhouse/client"
import { createValv } from "@valv/clickhouse"

const ch = createClient({ url: process.env.CLICKHOUSE_URL })

// Introspects the live database on construction — call once at startup.
const valv = await createValv(ch, { schema: "introspect", database: "analytics", defaultPolicy: "deny-all" })

valv.policy("events", (ctx) => ({
  read:   { tenant_id: ctx.tenant.id },   // every read is scoped to this tenant
  fields: { deny: ["raw_payload"] },      // hide a column from the model
}))

const tools = await valv.tools.aisdk(ctx) // or .anthropic / .openai / .gemini / .neutral
```

See the [root README](../../README.md) for policies, the tool layer, and saved queries.

## ClickHouse functions

On top of the standard aggregates (`count`, `sum`, `avg`, `min`, `max`), this dialect adds ClickHouse-native functions the model can call:

| Function | Use |
|---|---|
| `quantileTiming(level)(col)` | percentiles, e.g. p95 latency |
| `toDate` / `toStartOfHour` / `toStartOfDay` | fixed-grain time buckets |
| `toStartOfInterval(col, n, unit)` | arbitrary-grain time buckets |
| `uniq` / `uniqExact` | distinct counts (DAU/MAU) |
| `countIf(pred)` / `sumIf(col, pred)` | conditional aggregation |

Each is type-checked, and any literal a function compares against becomes a bound parameter — never string-concatenated.

## Schema: introspect or hand-define

- **`schema: "introspect"`** queries `system.columns` to build the catalog (table → columns with native types, primary-key parts).
- **`schema: <SchemaMap>`** lets you declare the schema by hand — useful for per-tenant tables, or to add relations ClickHouse can't introspect. See [`examples/hand-schema`](../../examples/hand-schema).

ClickHouse has no schema-level notion of "sensitive", so mark hidden columns in your **policy** (`fields.deny`), not the schema.

## Safety caps

Every query runs with conservative ClickHouse settings — `max_execution_time`, `max_result_rows`/`bytes`, `result_overflow_mode: throw` — so a structurally-valid query can't run away on the server. Raise them per deployment if your analytics needs more headroom.

## Zero-config from a URL

No client wired up? `createValvFromUrl(url, { database })` builds the client and introspects for you. This is also what the [`@valv/mcp`](../mcp) CLI uses for ClickHouse.

## License

MIT
