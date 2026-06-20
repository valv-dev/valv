import type { PrismaClient } from "@prisma/client"
import type { ValvAdapter, SchemaMap } from "@valv/core"
import { introspectPrisma } from "./introspection"

export interface PrismaAdapterOptions {
  schemaPath?: string
}

export class PrismaAdapter implements ValvAdapter {
  private prisma: PrismaClient
  private schemaPath?: string

  constructor(prisma: PrismaClient, options?: string | PrismaAdapterOptions) {
    this.prisma = prisma
    const opts = typeof options === "string" ? { schemaPath: options } : (options ?? {})
    this.schemaPath = opts.schemaPath
  }

  async introspect(): Promise<SchemaMap> {
    const path = this.schemaPath ?? "./prisma/schema.prisma"
    return introspectPrisma(path)
  }

  /**
   * Run a compiled, parameterized SQL statement and return rows. Positional
   * parameters bind to the dialect's placeholders (`$1`, `$2`, … for Postgres;
   * `?` for MySQL/SQLite) via Prisma's raw query interface.
   */
  async execute(sql: string, parameters: unknown[] = []): Promise<unknown[]> {
    const rows = await this.prisma.$queryRawUnsafe(sql, ...parameters)
    return rows as unknown[]
  }
}
