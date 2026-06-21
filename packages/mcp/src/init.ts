import { writeFileSync, readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { inferProvider, type McpProvider, type ServerConfig } from "./config"
import { listDatabaseResources } from "./index"

type Clack = typeof import("@clack/prompts")

// @clack/prompts is ESM-only; load it via a real dynamic import so this
// CommonJS-compiled package doesn't downlevel the import to require().
async function loadClack(): Promise<Clack> {
  return (await (Function('return import("@clack/prompts")')() as Promise<Clack>)) as Clack
}

/** Interactive setup: probe a database, choose access, emit the MCP config. */
export async function runInit(): Promise<void> {
  const p = await loadClack()
  p.intro("valv · set up a database MCP server")

  const url = await p.text({
    message: "Database connection string",
    placeholder: "postgres://…   or   http://localhost:8123",
    initialValue: process.env.DATABASE_URL ?? "",
    validate: (v) => (v?.trim() ? undefined : "Required."),
  })
  if (p.isCancel(url)) return void p.cancel("Cancelled.")

  let detected: McpProvider = "postgresql"
  try {
    detected = inferProvider(url)
  } catch {
    // unrecognized scheme — fall back to the default and let the user pick
  }

  const provider = await p.select<McpProvider>({
    message: "Database type",
    initialValue: detected,
    options: [
      { value: "postgresql", label: "PostgreSQL" },
      { value: "mysql", label: "MySQL" },
      { value: "sqlite", label: "SQLite" },
      { value: "clickhouse", label: "ClickHouse" },
    ],
  })
  if (p.isCancel(provider)) return void p.cancel("Cancelled.")

  let database: string | undefined
  if (provider === "clickhouse") {
    const db = await p.text({ message: "ClickHouse database name", initialValue: "default" })
    if (p.isCancel(db)) return void p.cancel("Cancelled.")
    database = db.trim() || undefined
  }

  // Probe: actually connect + introspect before wiring anything up.
  const spin = p.spinner()
  spin.start("Connecting and introspecting…")
  let resources: string[]
  try {
    resources = await listDatabaseResources({ databaseUrl: url, provider, database })
  } catch (err) {
    spin.stop("Could not connect.")
    return void p.cancel(err instanceof Error ? err.message : String(err))
  }
  spin.stop(`Connected — found ${resources.length} table(s).`)
  if (resources.length) p.note(resources.join(", "), "Tables")

  const mode = await p.select<"all" | "pick" | "policy">({
    message: "Access",
    initialValue: "all",
    options: [
      { value: "all", label: "Read-only — all tables" },
      { value: "pick", label: "Read-only — choose tables" },
      { value: "policy", label: "Custom policy file (generate a stub to edit)" },
    ],
  })
  if (p.isCancel(mode)) return void p.cancel("Cancelled.")

  const env: Record<string, string> = { DATABASE_URL: url, VALV_PROVIDER: provider }
  if (database) env.VALV_DATABASE = database

  if (mode === "pick") {
    const chosen = await p.multiselect<string>({
      message: "Tables to expose",
      options: resources.map((r) => ({ value: r, label: r })),
      required: true,
    })
    if (p.isCancel(chosen)) return void p.cancel("Cancelled.")
    env.VALV_TABLES = chosen.join(",")
  } else if (mode === "policy") {
    writeFileSync(resolve("valv.policy.cjs"), policyStub(resources))
    env.VALV_POLICY_FILE = "./valv.policy.cjs"
    p.note("Wrote valv.policy.cjs — edit it to scope access per resource.", "Policy")
  }

  const tenant = await p.text({
    message: "Tenant id for the agent's context (optional)",
    placeholder: "blank to skip",
  })
  if (p.isCancel(tenant)) return void p.cancel("Cancelled.")
  if (tenant.trim()) env.VALV_CONTEXT = JSON.stringify({ tenant: { id: tenant.trim() } })

  const name = await p.text({ message: "Name this server", initialValue: defaultName(url, database) })
  if (p.isCancel(name)) return void p.cancel("Cancelled.")

  p.note(snippet(name, env), "Add to your MCP client config")

  const doWrite = await p.confirm({ message: "Write it to ./.mcp.json now?" })
  if (!p.isCancel(doWrite) && doWrite) {
    writeMcpJson(name, env)
    p.outro("Wrote .mcp.json — restart your MCP client to load it.")
  } else {
    p.outro("Copy the snippet above into your MCP client config.")
  }
}

function serverEntry(env: Record<string, string>) {
  return { command: "npx", args: ["-y", "@valv/mcp"], env }
}

function snippet(name: string, env: Record<string, string>): string {
  return JSON.stringify({ mcpServers: { [name]: serverEntry(env) } }, null, 2)
}

function writeMcpJson(name: string, env: Record<string, string>): void {
  const path = resolve(".mcp.json")
  let doc: { mcpServers?: Record<string, unknown> } = { mcpServers: {} }
  if (existsSync(path)) {
    try {
      doc = JSON.parse(readFileSync(path, "utf8"))
    } catch {
      // overwrite a malformed file rather than fail
    }
  }
  doc.mcpServers ??= {}
  doc.mcpServers[name] = serverEntry(env)
  writeFileSync(path, JSON.stringify(doc, null, 2) + "\n")
}

function defaultName(url: string, database?: string): string {
  if (database) return database
  const match = url.match(/\/([A-Za-z0-9_-]+)(?:\?|$)/)
  return match?.[1] || "database"
}

function policyStub(resources: string[]): string {
  const example = resources[0] ?? "orders"
  return [
    "// valv policy — full control over access. Receives the configured valv instance.",
    "// Context comes from VALV_CONTEXT (JSON). Resources without a policy are denied.",
    `// Discovered tables: ${resources.join(", ") || "(none)"}`,
    "module.exports = (valv) => {",
    `  valv.policy(${JSON.stringify(example)}, (ctx) => ({`,
    "    read: { tenant_id: ctx.tenant?.id }, // row filter: only this tenant's rows",
    "    fields: { deny: [] },                // column names to hide from the agent",
    "  }))",
    "}",
    "",
  ].join("\n")
}
