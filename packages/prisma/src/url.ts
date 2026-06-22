import { execFileSync } from "node:child_process"
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs"
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

// `prisma db pull` can write an *invalid* schema when a scalar column and a
// FK-derived back-relation resolve to the same field name on a model — e.g. a
// `user.image` column alongside an `image` table that references `user`, which
// Prisma names `image image[]`. It only warns on this, so the file is written
// but `prisma generate` / `getDMMF` reject it (P1012: "Field already defined").
//
export interface FieldRename {
  model: string
  from: string
  to: string
}

// Rewrite a pulled schema so every field name within a `model`/`view` block is
// unique: the first occurrence wins (the scalar column, which `db pull` lists
// before relations), and any later collision is renamed `<name>_rel`,
// `<name>_rel2`, … The implicit relation is FK-derived, so renaming the field is
// safe — it stays in the catalog under the new name; the queryable column keeps
// its real name. Pure (string in, string out) so it can be tested without a DB.
export function sanitizeSchemaText(src: string): { text: string; renames: FieldRename[] } {
  const lines = src.split("\n")
  const renames: FieldRename[] = []

  const blockOpen = /^\s*(model|view)\s+(\w+)\s*\{/
  const blockClose = /^\s*\}/
  // A field line: leading indent, a name, whitespace, then its type/attributes.
  // Block attributes (`@@map`), comments (`//`) and the closing brace are skipped.
  const fieldLine = /^(\s*)(\w+)(\s+)(\S.*)$/

  const fieldAt = (i: number): RegExpExecArray | null => {
    const trimmed = lines[i].trim()
    if (trimmed === "" || trimmed.startsWith("@@") || trimmed.startsWith("//")) return null
    return fieldLine.exec(lines[i])
  }

  for (let i = 0; i < lines.length; i++) {
    const open = blockOpen.exec(lines[i])
    if (!open) continue
    const model = open[2]

    let end = i + 1
    while (end < lines.length && !blockClose.test(lines[end])) end++

    // Reserve every existing field name up front so a rename can't clobber a real
    // field that happens to appear *later* in the block (e.g. an `image_rel`
    // column sitting below the colliding relation).
    const reserved = new Set<string>()
    for (let j = i + 1; j < end; j++) {
      const f = fieldAt(j)
      if (f) reserved.add(f[2])
    }

    const kept = new Set<string>()
    for (let j = i + 1; j < end; j++) {
      const f = fieldAt(j)
      if (!f) continue
      const [, indent, name, gap, rest] = f
      if (!kept.has(name)) {
        kept.add(name) // first occurrence keeps its name
        continue
      }
      let to = `${name}_rel`
      for (let n = 2; reserved.has(to); n++) to = `${name}_rel${n}`
      reserved.add(to)
      lines[j] = `${indent}${to}${gap}${rest}`
      renames.push({ model, from: name, to })
    }

    i = end
  }

  return { text: lines.join("\n"), renames }
}

// Repair the pulled schema in place. `db pull` only warns on scalar/relation
// field-name collisions and writes an invalid file; fix it before anything
// parses it. Renames are logged to stderr rather than applied silently.
function sanitizePulledSchema(schemaPath: string): void {
  const { text, renames } = sanitizeSchemaText(readFileSync(schemaPath, "utf8"))
  for (const { model, from, to } of renames) {
    process.stderr.write(
      `[valv] Renamed colliding field ${model}.${from} → ${to} ` +
        `(Prisma introspection name collision)\n`,
    )
  }
  if (renames.length) writeFileSync(schemaPath, text)
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
    // `db pull` only warns on scalar/relation field-name collisions and writes an
    // invalid schema; repair it before anything tries to parse it.
    sanitizePulledSchema(schemaPath)
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
