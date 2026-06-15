# valv × ClickHouse — analytics example

End-to-end demo of `@valv/clickhouse`: three users (admin, analyst, cross-tenant admin)
issuing the same prompts against a live ClickHouse database, plus a stress-test suite for
tenant isolation, sensitive field exclusion, write policy enforcement, and field denial.

## Prerequisites

- Docker (to run ClickHouse)
- An [OpenRouter](https://openrouter.ai) API key

## Quick start

```bash
cp .env.example .env
# Fill in OPENROUTER_API_KEY

npm install
npm run db:start    # starts clickhouse/clickhouse-server in Docker on port 8123
npm run db:seed     # creates tables and inserts sample data
npm start           # runs demos + stress tests
```

## Schema

Three tables with valv annotations in column COMMENTs:

| Table | Description |
|---|---|
| `users` | Platform users — `password_hash` is `@valv:sensitive` |
| `orders` | Purchase orders — `internal_notes` is `@valv:sensitive` |
| `events` | Analytics events — append-only, read-only policy |

## Policies

| Role | orders | users | events |
|---|---|---|---|
| `admin` | read/write/aggregate scoped to tenant | read scoped to tenant | read/aggregate scoped to tenant |
| `analyst` | same + `user_id` denied | same | same |

`delete: false` on all resources — no `delete_*` tools generated.

## Stress tests

| Test | What it checks |
|---|---|
| Sensitive field guard | `password_hash` and `internal_notes` never reach the LLM |
| Cross-tenant isolation | alice (tenant-alpha) cannot see tenant-beta rows |
| Write policy | `tenant_id` is force-injected on INSERT |
| Analyst field denial | `user_id` absent even when explicitly requested |
| Delete firewall | `delete_orders` tool not generated |
| Aggregation scoping | Revenue totals only reflect the caller's tenant |
| Consolidated mode | Agent discovers schema via `list_resources`/`describe_resource` |
