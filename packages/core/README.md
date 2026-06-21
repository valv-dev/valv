# @valv/core

The database-agnostic core of [valv](../../README.md): the query grammar an LLM emits, the validator that checks it against your schema and policy, the policy injector, the shared SQL emitter, and the tool layer.

[![npm](https://img.shields.io/npm/v/@valv/core)](https://www.npmjs.com/package/@valv/core) [![license](https://img.shields.io/npm/l/@valv/core)](../../LICENSE)

> **Most users install an adapter, not this package directly** — [`@valv/clickhouse`](../clickhouse) or [`@valv/prisma`](../prisma) wrap core with introspection and a dialect. See the [root README](../../README.md) for the full guide. Reach for `@valv/core` directly only to build a custom adapter.

## What this package exports

| Area | Exports |
|---|---|
| Orchestration | `Valv` (instantiated by adapters via `createValv`) |
| Query grammar | `QuerySchema`; types `Query`, `Expr`, `SelectItem` |
| Policy | `PolicyFn`, `PolicyResult`, `FieldPolicy`, `DefaultContext` |
| Emission | `emit`, the `Dialect` interface, `BASE_FUNCTIONS`, `FnDef`, `ArgSpec` |
| Output shape | `resultSchema`, `ResultColumn` |
| Tool formats | `anthropic`, `openai`, `gemini` formatters; `NeutralTool`, `DiscoveryToggle` |
| Adapter contract | `ValvAdapter`, `SchemaMap`, `CompiledQuery`, `BoundParam` |
| Errors | `ValidationError`, `PolicyViolationError`; `serializeResult` |

## Building an adapter

Everything above the database is shared, so a new adapter is three methods plus a small dialect. The shared `emit` does clause assembly, parenthesisation, and parameter ordering — your dialect only says how to quote identifiers and render placeholders.

```ts
import type { ValvAdapter, SchemaMap, Query, CompiledQuery, FnDef, Dialect } from "@valv/core"
import { emit, BASE_FUNCTIONS } from "@valv/core"

const myDialect: Dialect = {
  quoteId: (id) => `"${id.replace(/"/g, '""')}"`,
  placeholder: (i) => `$${i + 1}`,
  // functions: { ...dialect-specific aggregates }
}

class MyAdapter implements ValvAdapter {
  async introspect(): Promise<SchemaMap> {
    // describe your tables → resources, fields (with coarse `type` + `nativeType`), relations
  }
  compile(query: Query, catalog: SchemaMap): CompiledQuery {
    return emit(query, catalog, myDialect)
  }
  async execute(sql: string, params?: unknown[]): Promise<unknown[]> {
    // run the parameterized statement, return rows
  }
  functions(): Record<string, FnDef> {
    return { ...BASE_FUNCTIONS, ...myDialect.functions }
  }
}
```

Validation and policy injection never reach the adapter — security stays in core. A `Dialect` can also declare extra functions (`FnDef`: argument signature, return type, render), which become callable in the query grammar and are surfaced to the model through the `query` tool's enum.

## Type-safe resource names

`InferResources` derives resource names from a typed client, so a misspelled policy key is a compile error:

```ts
import type { InferResources } from "@valv/core"
const valv = await createValv<typeof prisma, Ctx>(prisma)  // policy keys autocomplete
```

## License

MIT
