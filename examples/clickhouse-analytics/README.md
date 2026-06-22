# valv × ClickHouse — analytics example

LLM-driven analytics over a live ClickHouse database, gated by valv. An agent
(analyst @ `tenant-alpha`) discovers the schema and answers a question by
emitting a structured `query` — no SQL ever reaches the model, sensitive fields
are stripped, and every read is tenant-scoped.

## Prerequisites

- Docker (to run ClickHouse)
- An [OpenRouter](https://openrouter.ai) API key (optional — without it the demo
  just prints the tools the agent would receive)

## Quick start

```bash
cp .env.example .env
# set OPENROUTER_API_KEY (CLICKHOUSE_* already point at the Docker container)

npm install
npm run db:start    # ClickHouse in Docker on port 8123
npm run db:seed     # creates the tables and inserts sample data
npm start           # runs the agent (or lists its tools if no API key)
```

## Schema

Three tables, annotated in ClickHouse column `COMMENT`s (`@valv:sensitive`,
`@valv:description`) and introspected at startup:

| Table | Notes |
|---|---|
| `users` | Platform users — `password_hash` is `@valv:sensitive` |
| `orders` | Purchase orders — `internal_notes` is `@valv:sensitive` |
| `events` | Analytics events |

## Policies

All reads are scoped to the caller's `tenant_id`; the two sensitive columns are
denied on top (ClickHouse has no schema-level sensitivity, so the example names
them in the policy):

```ts
valv.policy("orders", (c) => ({ read: { tenant_id: c.tenant!.id }, fields: { deny: ["internal_notes"] } }))
valv.policy("users",  (c) => ({ read: { tenant_id: c.tenant!.id }, fields: { deny: ["password_hash"] } }))
valv.policy("events", (c) => ({ read: { tenant_id: c.tenant!.id } }))
```

## Tools

The agent receives four tools — `list_resources`, `search_resources`,
`describe_resource`, and the structured `query`. It discovers the schema, then
emits one grouped query that valv validates, tenant-scopes, and compiles to
ClickHouse SQL. Writes are not exposed (reads only).
