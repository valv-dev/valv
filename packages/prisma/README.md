# @valv/prisma

Prisma adapter for [valv](../../README.md) — let an LLM query your relational database (PostgreSQL, MySQL, SQLite, CockroachDB), scoped by policies you write in code. The model emits a structured query; valv validates it, injects your tenant/row filter, and compiles it to SQL.

[![npm](https://img.shields.io/npm/v/@valv/prisma)](https://www.npmjs.com/package/@valv/prisma) [![license](https://img.shields.io/npm/l/@valv/prisma)](../../LICENSE)

## Install

```bash
npm i @valv/prisma @prisma/client
npm i -D prisma
```

Requires Prisma 5+.

## Usage

```ts
import { PrismaClient } from "@prisma/client"
import { createValv } from "@valv/prisma"

const prisma = new PrismaClient()

// Reads the schema from your .prisma datasource on construction — call once.
const valv = await createValv(prisma, { defaultPolicy: "deny-all" })

valv.policy("order", (ctx) => ({
  read:   { tenant_id: ctx.tenant.id },   // every read is scoped to this tenant
  fields: { deny: ["internal_notes"] },   // hide a column from the model
}))

const tools = await valv.tools.aisdk(ctx) // or .anthropic / .openai / .gemini / .neutral
```

Resource names are inferred from your Prisma client type and converted to `snake_case` (`OrderItem` → `order_item`), so policy keys are **type-checked** — a typo is a compile error. Pass `schemaPath` if your schema isn't at `./prisma/schema.prisma`.

See the [root README](../../README.md) for policies, the tool layer, and saved queries.

## Databases

One adapter covers every provider Prisma can introspect — the right dialect (identifier quoting, `$1` vs `?` placeholders) is selected from your datasource:

| Provider | Quoting / placeholders |
|---|---|
| `postgresql`, `cockroachdb` | `"col"`, `$1` |
| `mysql` | `` `col` ``, `?` |
| `sqlite` | `"col"`, `?` |

Mark hidden columns in your **policy** (`fields.deny`); valv reads structure from Prisma's DMMF, which has no notion of "sensitive".

## Writes

All three operations, **off** until you allow them in policy and expose the tool:

```ts
valv.policy("order", (ctx) => ({
  read:   { tenant_id: ctx.tenant.id },
  create: { tenant_id: ctx.tenant.id },   // tenant_id force-set on insert
  update: { tenant_id: ctx.tenant.id },   // AND-injected into the WHERE
  delete: false,                          // never deletable
}))
const tools = await valv.tools.aisdk(ctx, { create: true, update: true })

await valv.create({ from: "order", values: { status: "pending", total: 1200 } }, ctx)
```

`create` force-injects owned fields; `update`/`delete` AND the scope predicate into a **required** `where`, and the model can only set writable columns. See [Writes](../../README.md#writes) in the root README.

## Zero-config from a URL

No client or generated schema? `createValvFromUrl(url, { provider? })` infers the provider, runs `prisma db pull` + `generate` into a throwaway client under a writable temp dir (`os.tmpdir()`, so it works on read-only/serverless filesystems), and introspects — all at startup. This is the path the [`@valv/mcp`](../mcp) CLI uses. Requires the `prisma` CLI available. Call `stop()` on shutdown.

```ts
import { createValvFromUrl } from "@valv/prisma"
const { valv, stop } = await createValvFromUrl("postgres://…", { defaultPolicy: "deny-all" })
```

## License

MIT
