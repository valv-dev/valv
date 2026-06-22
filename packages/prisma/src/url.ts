import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, unlinkSync } from "node:fs"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import type { PrismaClient } from "@prisma/client"
import type { Valv, DefaultContext, ValvConfig } from "@valv/core"
import { createValv } from "./create"

export type Provider = "postgresql" | "mysql" | "sqlite" | "sqlserver" | "mongodb"

const PROVIDER_PATTERNS: [RegExp, Provider][] = [
  [/^postgres(ql)?:\/\//i, "postgresql"],
  [/^mysql:\/\//i, "mysql"],
  [/^sqlserver:\/\//i, "sqlserver"],
  [/^(file:|sqlite:)/i, "sqlite"],
  [/^mongodb(\+srv)?:\/\//i, "mongodb"],
]

/** Infer the Prisma datasource provider from a connection string. */
export function inferProvider(url: string): Provider {
  for (const [pattern, provider] of PROVIDER_PATTERNS) {
    if (pattern.test(url)) return provider
  }
  throw new Error(
    `Could not infer the database provider from the connection string. ` +
      `Pass { provider } explicitly: postgresql, mysql, sqlite, sqlserver, mongodb.`,
  )
}

// The real node_modules directory that holds @prisma/client + prisma. We don't
// write here (it may be read-only in production); we symlink it into the temp
// workdir so `prisma generate` can resolve prisma without an auto-install.
function nodeModulesDir(): string {
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
// pollutes any stdio channel a caller (e.g. the MCP) may be speaking on stdout.
function runPrisma(cliPath: string, args: string[], env: NodeJS.ProcessEnv): void {
  execFileSync(process.execPath, [cliPath, ...args], {
    env,
    stdio: ["ignore", 2, 2],
  })
}

/**
 * Introspect a live database into a throwaway Prisma schema + client, returning
 * a ready `PrismaClient`. This is what makes "zero-config" possible: no
 * `schema.prisma` and no generated client need to exist ahead of time.
 *
 * The throwaway schema + client are written under a **writable temp dir**
 * (`os.tmpdir()` by default, or `cacheDir`), never the app's `node_modules` —
 * so it works on read-only/immutable production filesystems and serverless
 * (e.g. Lambda's `/tmp`). Requires the `prisma` CLI installed (optional peer
 * dependency). Diagnostics go to stderr so stdout stays clean for stdio
 * transports.
 */
export async function prepareDatabase(
  databaseUrl: string,
  provider: Provider,
  options: { cacheDir?: string } = {},
): Promise<PreparedDatabase> {
  const base = options.cacheDir ?? tmpdir()
  mkdirSync(base, { recursive: true })
  const dir = mkdtempSync(join(base, "valv-url-"))
  const cleanup = () => {
    try {
      // Drop the node_modules symlink before removing the dir. rmSync doesn't
      // follow symlinks (it unlinks them), but be explicit so nothing can ever
      // recurse into the real node_modules.
      try {
        unlinkSync(join(dir, "node_modules"))
      } catch {
        // no symlink yet (failed before it was created)
      }
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort temp cleanup
    }
  }
  // Anything past the mkdtemp can fail (unreachable DB, bad credentials, generate
  // errors); remove the temp dir on the way out so a failed introspection doesn't
  // leave orphaned dirs behind.
  try {
    // `prisma generate` infers the project root from the schema's directory and
    // auto-installs prisma if it can't find it there. Anchor the temp workdir
    // with a package.json + a node_modules symlink to the real install so the
    // generator resolves without ever writing to the app's node_modules.
    writeFileSync(join(dir, "package.json"), '{"name":"valv-url","version":"0.0.0"}\n')
    symlinkSync(nodeModulesDir(), join(dir, "node_modules"), "junction")

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

    return { prisma, schemaPath, cleanup }
  } catch (err) {
    cleanup()
    throw err
  }
}

export interface ValvFromUrl<TContext> {
  valv: Valv<TContext, string>
  /** Disconnect the database and remove the generated temp client. */
  stop: () => Promise<void>
}

type FromUrlConfig<TContext> = Omit<ValvConfig<TContext, string>, "adapter"> & {
  /** Prisma datasource provider. Inferred from the URL when omitted. */
  provider?: Provider
  /** Writable dir for the generated throwaway client. Defaults to `os.tmpdir()`;
   *  point it at a mounted writable volume in locked-down environments. */
  cacheDir?: string
}

/**
 * Build a policy-gated valv instance from just a connection string — infers the
 * provider, introspects the live database, and returns a ready instance. Use
 * when the project has no ORM client/schema wired up.
 *
 * Call `stop()` to disconnect and clean up the generated temp client.
 */
export async function createValvFromUrl<TContext = DefaultContext>(
  url: string,
  config?: FromUrlConfig<TContext>,
): Promise<ValvFromUrl<TContext>> {
  const { provider, cacheDir, ...rest } = config ?? {}
  const prepared = await prepareDatabase(url, provider ?? inferProvider(url), { cacheDir })
  const stop = async () => {
    try {
      await prepared.prisma.$disconnect()
    } finally {
      prepared.cleanup()
    }
  }
  try {
    // strictPolicyKeys defaults to true here: resources are introspected at
    // runtime and untyped (`string`), so a misspelled policy key would silently
    // no-op without it. Callers can override via config.
    const valv = (await createValv<PrismaClient, TContext>(prepared.prisma, {
      strictPolicyKeys: true,
      ...rest,
      schemaPath: prepared.schemaPath,
    })) as Valv<TContext, string>
    return { valv, stop }
  } catch (err) {
    await stop()
    throw err
  }
}
