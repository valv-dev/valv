# valv ecommerce example

Demonstrates valv's core value: the same LLM agent and the same question return
different data depending on who's asking. Policies are declared once in
[`valv.ts`](./valv.ts) and govern every surface — the in-process agent
([`index.ts`](./index.ts)), a saved-query dashboard ([`live-dashboard.ts`](./live-dashboard.ts)),
and an MCP server ([`mcp.ts`](./mcp.ts)).

The agent gets four tools — `list_resources`, `search_resources`,
`describe_resource`, and a single structured `query`. It discovers the schema
and emits JSON queries that valv validates, tenant-scopes, and compiles to SQL.
No SQL reaches the model, and `internal_notes` / `password_hash`
(`@valv:sensitive`) never appear regardless of role.

## Policies (`valv.ts`)

All reads are scoped to the caller's tenant; sensitive columns are denied per
role:

| Resource | Rule |
|---|---|
| `order` | tenant-scoped read; `internal_notes` always denied, `user_id` denied for `support` |
| `user` | tenant-scoped read; `password_hash` always denied, `email` denied for `support` |
| `product` | tenant-scoped read |
| `order_item` | not readable |

`index.ts` runs as `support` @ `tenant-alpha` — change `ctx` (role or tenant) to
watch the visible tools and results shift.

## Prerequisites

- Docker
- Node.js 20+
- An [OpenRouter](https://openrouter.ai) API key (optional — without it the demo
  prints the tools the agent would receive)

## Quick start

```bash
# From the repo root: build the library
npm install && npm run build

# Configure environment
cd examples/ecommerce
cp .env.example .env        # set OPENROUTER_API_KEY

# Start Postgres, push the schema, seed
npm run db:start
npm run db:push
npm run db:generate
npm run db:seed

# Run the agent
npm start
```

## Scripts

| Script | Description |
|--------|-------------|
| `npm start` | Run the in-process agent demo (`index.ts`) |
| `npm run dashboard` | Run the live saved-query dashboard (`live-dashboard.ts`) |
| `npm run mcp` | Start the MCP server (`mcp.ts`) |
| `npm run db:start` / `db:stop` / `db:reset` | Manage the Postgres container |
| `npm run db:push` / `db:migrate` | Apply the Prisma schema |
| `npm run db:generate` | Generate the Prisma client |
| `npm run db:seed` | Insert fixture data |
| `npm run db:studio` | Open Prisma Studio |

## Live dashboard (`live-dashboard.ts`)

Shows a **saved query**: the agent would build a query once, the app stores it
as plain data (`Query`) and owns it from there — no LLM in the loop. Each refresh
replays it through `valv.run(query, ctx)`, so the tenant filter and field rules
are re-applied live on the current context. `valv.resultSchema(query)` gives the
column shape up front to drive rendering. A background writer inserts orders
between refreshes while an ASCII bar chart redraws revenue by status.

```bash
npm run dashboard   # no API key needed — the query is fixed
```

## MCP server (`mcp.ts`)

Exposes the same policy-gated tools to a coding agent (e.g. Claude Code) over
stdio. See the header of [`mcp.ts`](./mcp.ts) for the client config.
