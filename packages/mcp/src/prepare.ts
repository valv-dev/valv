import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { join, dirname } from "node:path"
import type { PrismaClient } from "@prisma/client"
import type { Provider } from "./config"

// The node_modules directory that holds @prisma/client. We generate the throwaway
// client *inside* it so the generated runtime resolves @prisma/client normally —
// generating into an unrelated temp dir makes Prisma walk up to "/", fail to find
// the installed prisma, and attempt a detached auto-install.
function clientBaseDir(): string {
  const pkg = require.resolve("@prisma/client/package.json")
  return dirname(dirname(dirname(pkg))) // .../node_modules/@prisma/client/package.json → .../node_modules
}

export interface PreparedDatabase {
  prisma: PrismaClient
  schemaPath: string
  /** Remove the generated client + schema temp dir. */
  cleanup: () => void
}

// Resolve the locally-installed Prisma CLI entrypoint so we can run it with the
// current node binary — more reliable than relying on `npx` resolution.
function resolvePrismaCli(): string {
  const pkgJsonPath = require.resolve("prisma/package.json")
  const pkg = require("prisma/package.json") as { bin?: string | Record<string, string> }
  const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.prisma
  if (!binRel) throw new Error("Could not locate the Prisma CLI entrypoint.")
  return join(dirname(pkgJsonPath), binRel)
}

// Run a Prisma CLI command. Child stdout is routed to *our* stderr so it never
// pollutes the MCP stdio channel (which speaks JSON-RPC on stdout).
function runPrisma(cliPath: string, args: string[], env: NodeJS.ProcessEnv): void {
  execFileSync(process.execPath, [cliPath, ...args], {
    env,
    stdio: ["ignore", 2, 2],
  })
}

/**
 * Introspect a live database into a throwaway Prisma schema + client, returning
 * a ready `PrismaClient`. This is what makes the server "zero-config": no
 * `schema.prisma` and no generated client need to exist ahead of time.
 *
 * Diagnostics are written to stderr so stdout stays clean for the MCP transport.
 */
export async function prepareDatabase(
  databaseUrl: string,
  provider: Provider,
): Promise<PreparedDatabase> {
  const dir = mkdtempSync(join(clientBaseDir(), ".valv-mcp-"))
  const schemaPath = join(dir, "schema.prisma")
  const clientOutput = join(dir, "client")

  const schema = `generator client {
  provider = "prisma-client-js"
  output   = "${clientOutput.replace(/\\/g, "\\\\")}"
}

datasource db {
  provider = "${provider}"
  url      = env("DATABASE_URL")
}
`
  writeFileSync(schemaPath, schema)

  const env = { ...process.env, DATABASE_URL: databaseUrl }
  const cli = resolvePrismaCli()

  process.stderr.write("[valv] Introspecting database schema…\n")
  runPrisma(cli, ["db", "pull", "--schema", schemaPath], env)
  process.stderr.write("[valv] Generating client…\n")
  runPrisma(cli, ["generate", "--schema", schemaPath], env)

  const { PrismaClient: GeneratedClient } = require(clientOutput) as {
    PrismaClient: new (options?: { datasources?: { db?: { url?: string } } }) => PrismaClient
  }
  // Pass the URL straight to the client. The schema's datasource reads
  // env("DATABASE_URL"), which isn't set in this process — and this also avoids
  // ever writing the connection string to disk.
  const prisma = new GeneratedClient({ datasources: { db: { url: databaseUrl } } })

  return {
    prisma,
    schemaPath,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // best-effort temp cleanup
      }
    },
  }
}
