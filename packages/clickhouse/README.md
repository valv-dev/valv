# @vistal/clickhouse

ClickHouse adapter for [vistal](https://github.com/vista-libs/vista) — row-level security and policy enforcement for AI agents querying ClickHouse.

## Install

```bash
npm install @vistal/clickhouse @vistal/core @clickhouse/client
```

## Usage

```ts
import { createClient } from "@clickhouse/client"
import { createVistal } from "@vistal/clickhouse"

const ch = createClient({ url: process.env.CLICKHOUSE_URL })

const vistal = createVistal(ch, {
  database: "analytics",
  defaultPolicy: "deny-all",
})

vistal.policy("events", (ctx) => ({
  read:      { tenant_id: ctx.tenant!.id },
  aggregate: { tenant_id: ctx.tenant!.id },
  write: false,
  delete: false,
}))

const tools = await vistal.tools.vercel(ctx)
// pass tools to generateText / streamText as usual
```

## Schema annotations

Vistal reads column and table comments to pick up schema metadata. Add them to your
`CREATE TABLE` statements:

```sql
CREATE TABLE orders
(
  id        UUID DEFAULT generateUUIDv4(),
  tenant_id String,
  status    Enum8('pending'=1, 'shipped'=2, 'delivered'=3)
              COMMENT '@vistal:description "Current order status"',
  total     Int64   COMMENT '@vistal:description "Order total in cents"',
  notes     Nullable(String) COMMENT '@vistal:sensitive'
)
ENGINE = MergeTree
ORDER BY (tenant_id, id)
COMMENT '@vistal:description "Customer orders"';
```

The `@vistal:sensitive` tag strips the field from every schema, argument, and result
the LLM sees — enforcement happens at introspection time, not in the prompt.

## The `id` column

The core builder routes `get_`, `update`, and `delete` tool calls through a filter
on the field literally named `id`. If your table uses a different primary key name
(e.g. `event_id`), those three operations will not match rows correctly. Name the
primary key `id`, or accept that only `query_` and `aggregate_` are useful on that
table.

## Relations

ClickHouse has no foreign-key metadata, so introspection produces no relations.
The `include` parameter and relation policies are unavailable. For cross-table
joins, run an aggregate on each table separately and correlate in the agent.

## Writes: ALTER … UPDATE and lightweight DELETE

ClickHouse is an append-optimised OLAP engine. Updates and deletes are implemented
as:

| operation | SQL | behavior |
|---|---|---|
| `create` | `INSERT INTO … FORMAT JSONEachRow` | immediate |
| `update` | `ALTER TABLE … UPDATE … WHERE …` | synchronous (`mutations_sync=2`); returns `{ ok: true }` |
| `delete` | `DELETE FROM … WHERE …` | lightweight delete; returns `{ ok: true }` |

Both `update` and `delete` require a WHERE clause — the adapter throws if the
resolved query carries no filters. Since the policy engine always injects the row
filter before the adapter sees it, a `deny-all`-default setup with no explicit `read`
predicate will throw rather than silently mutate the whole table.

`mutations_sync: 2` makes `ALTER … UPDATE` wait for the mutation to complete before
returning. On large tables this may be slow; consider setting `update: false` in
policies for high-cardinality tables and relying on INSERT for time-series append
patterns instead.

## Options

```ts
createVistal(client, {
  database: "analytics",   // defaults to currentDatabase()
  defaultPolicy: "deny-all",
  onQuery: ({ toolName, resource, durationMs, error }) => { ... },
})
```

## Exporting the adapter directly

If you need to wire the adapter into an existing `Vistal` instance:

```ts
import { ClickHouseAdapter } from "@vistal/clickhouse"
import { Vistal } from "@vistal/core"

const vistal = new Vistal({
  adapter: new ClickHouseAdapter(ch, { database: "analytics" }),
  defaultPolicy: "deny-all",
})
```
