import { readFileSync } from "node:fs"
import type { PrismaClient } from "@prisma/client"
import type { ValvAdapter, SchemaMap, Query, CompiledQuery, FnDef } from "@valv/core"
import { emit, BASE_FUNCTIONS } from "@valv/core"
import { introspectPrisma } from "./introspection"
import { dialectForProvider } from "./dialects"

export interface PrismaAdapterOptions {
  schemaPath?: string
  /** Datasource provider. Auto-detected from the schema's datasource when omitted. */
  provider?: string
}

const DEFAULT_SCHEMA = "./prisma/schema.prisma"

export class PrismaAdapter implements ValvAdapter {
  private prisma: PrismaClient
  private schemaPath: string
  private providerOverride?: string
  private provider: string | null = null

  constructor(prisma: PrismaClient, options?: string | PrismaAdapterOptions) {
    this.prisma = prisma
    const opts = typeof options === "string" ? { schemaPath: options } : (options ?? {})
    this.schemaPath = opts.schemaPath ?? DEFAULT_SCHEMA
    this.providerOverride = opts.provider
  }

  async introspect(): Promise<SchemaMap> {
    return introspectPrisma(this.schemaPath)
  }

  compile(query: Query, catalog: SchemaMap): CompiledQuery {
    return emit(query, catalog, dialectForProvider(this.resolveProvider()))
  }

  functions(): Record<string, FnDef> {
    return { ...BASE_FUNCTIONS, ...dialectForProvider(this.resolveProvider()).functions }
  }

  /**
   * Run a compiled, parameterized statement. Positional values bind to the
   * dialect's placeholders (`$1` Postgres, `?` MySQL/SQLite) via Prisma's raw
   * query interface.
   */
  async execute(sql: string, parameters: unknown[] = []): Promise<unknown[]> {
    const rows = await this.prisma.$queryRawUnsafe(sql, ...parameters)
    return rows as unknown[]
  }

  private resolveProvider(): string {
    this.provider ??= this.providerOverride ?? readProvider(this.schemaPath)
    return this.provider
  }
}

function readProvider(schemaPath: string): string {
  const content = readFileSync(schemaPath, "utf8")
  const match = content.match(/datasource\s+\w+\s*\{[^}]*?provider\s*=\s*"([^"]+)"/)
  if (!match) {
    throw new Error(`[valv/prisma] could not determine the datasource provider from ${schemaPath}`)
  }
  return match[1]
}
