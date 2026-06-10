# @vistal/mcp

**Point it at a database URL. Claude talks to your data. No SQL, no code.**

A zero-config [MCP](https://modelcontextprotocol.io) server for any database
[vistal](https://github.com/vista-libs/vista) supports through Prisma
(PostgreSQL, MySQL, SQLite, SQL Server). Give it a `DATABASE_URL` and it:

1. introspects your live schema (`prisma db pull`) — no `schema.prisma` needed,
2. generates the typed tools an agent uses to query it,
3. serves them over MCP — **read-only by default**, scoped by your policies.

No SQL ever reaches the model, and it can only do what the policy allows.

## Quick start (Claude Code)

Add it to your `.mcp.json` — nothing to install or write:

```json
{
  "mcpServers": {
    "db": {
      "command": "npx",
      "args": ["-y", "@vistal/mcp"],
      "env": { "DATABASE_URL": "postgresql://user:pass@localhost:5432/mydb" }
    }
  }
}
```

That's it. Claude can now discover your tables (`list_resources`,
`describe_resource`) and read them (`query`, `get`, `aggregate`) — all
policy-gated, all without writing SQL.

You can also run it directly:

```bash
DATABASE_URL="postgresql://…" npx @vistal/mcp
# or pass the URL as the first argument
npx @vistal/mcp "postgresql://…"
```

## Defaults & safety

- **Read-only.** Out of the box only `query` / `get` / `aggregate` are exposed —
  never `create` / `update` / `delete`. Writes require a policy file (below).
- **All tables, opt-out.** Every table is exposed; narrow it with allow/deny lists.
- **No SQL, no leaks.** The model calls typed tools; vistal turns them into scoped
  queries server-side. Fields marked sensitive in your schema never reach it.

## Configuration

All via environment variables:

| Variable | Description |
| --- | --- |
| `DATABASE_URL` | Connection string (required; or pass as the first arg). |
| `VISTAL_PROVIDER` | `postgresql` \| `mysql` \| `sqlite` \| `sqlserver` \| `mongodb`. Inferred from the URL when omitted. |
| `VISTAL_TABLES` | Comma-separated allow-list. Only these tables are exposed. |
| `VISTAL_EXCLUDE` | Comma-separated deny-list, applied after the allow-list. |
| `VISTAL_POLICY_FILE` | Path to a policy module that takes full control (enables writes — see below). |
| `VISTAL_CONTEXT` | JSON policy context passed to your policy file. Defaults to `{}`. |
| `VISTAL_HTTP_PORT` | Serve over Streamable HTTP on this port instead of stdio. |

### Enabling writes / richer policies

For anything beyond read-only, point `VISTAL_POLICY_FILE` at a CommonJS module
that receives the configured vistal instance and declares
[policies](https://github.com/vista-libs/vista#policy-reference). It takes full
control of access (the allow/deny lists are then ignored):

```js
// db-policy.cjs
module.exports = (vistal) => {
  vistal.policy("orders", () => ({ read: true, write: true, delete: false }))
  vistal.policy("users", () => ({ read: true, write: false, delete: false }))
}
```

```json
{ "env": {
  "DATABASE_URL": "postgresql://…",
  "VISTAL_POLICY_FILE": "./db-policy.cjs"
} }
```

Use `VISTAL_CONTEXT` to feed runtime context (tenant, role, …) your policies read:
`"VISTAL_CONTEXT": "{\"tenant\":{\"id\":\"acme\"}}"`.

## How it works

```
Claude Code ─MCP─▶ @vistal/mcp
                     │  prisma db pull + generate  → live schema + typed client
                     │  @vistal/core               → policy engine (read-only default)
                     ▼
                  @vistal/prisma → PrismaClient → your database
```

The generated client lives in a temp directory and is removed on shutdown; your
project is never modified. Requires network access to the database and the
ability to run the bundled Prisma CLI.

## Need policies-in-code instead?

If you'd rather define your adapter and policies yourself and embed an MCP server
in your own app, use [`@vistal/mcp-sdk`](../mcp-sdk/README.md) directly.

## License

MIT
