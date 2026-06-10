export type Provider = "postgresql" | "mysql" | "sqlite" | "sqlserver" | "mongodb"

export interface ServerConfig {
  /** Database connection string. */
  databaseUrl: string
  /** Prisma datasource provider. Inferred from the URL when omitted. */
  provider?: Provider
  /** Path to a policy module that takes full control of access (optional). */
  policyFile?: string
  /** Allow-list of resource (table) names. When set, only these are exposed. */
  tables?: string[]
  /** Deny-list of resource (table) names, applied after the allow-list. */
  exclude?: string[]
  /** Policy context object (JSON). Defaults to `{}`. */
  context?: unknown
  /** When set, serve over Streamable HTTP on this port instead of stdio. */
  httpPort?: number
}

const PROVIDER_PATTERNS: [RegExp, Provider][] = [
  [/^postgres(ql)?:\/\//i, "postgresql"],
  [/^mysql:\/\//i, "mysql"],
  [/^sqlserver:\/\//i, "sqlserver"],
  [/^(file:|sqlite:)/i, "sqlite"],
  [/^mongodb(\+srv)?:\/\//i, "mongodb"],
]

export function inferProvider(url: string): Provider {
  for (const [pattern, provider] of PROVIDER_PATTERNS) {
    if (pattern.test(url)) return provider
  }
  throw new Error(
    `Could not infer the database provider from the connection string. ` +
      `Set VISTAL_PROVIDER to one of: postgresql, mysql, sqlite, sqlserver, mongodb.`,
  )
}

function csv(value: string | undefined): string[] | undefined {
  if (!value) return undefined
  const items = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  return items.length > 0 ? items : undefined
}

/**
 * Build a {@link ServerConfig} from environment variables and CLI args.
 * The connection string comes from `DATABASE_URL` or the first positional arg.
 */
export function configFromEnv(env: NodeJS.ProcessEnv, argv: string[]): ServerConfig {
  const positional = argv.find((a) => !a.startsWith("-"))
  const databaseUrl = env.DATABASE_URL ?? positional
  if (!databaseUrl) {
    throw new Error(
      "No database connection string. Set DATABASE_URL (or pass it as the first argument).",
    )
  }

  const provider = env.VISTAL_PROVIDER
    ? (env.VISTAL_PROVIDER as Provider)
    : inferProvider(databaseUrl)

  let context: unknown = {}
  if (env.VISTAL_CONTEXT) {
    try {
      context = JSON.parse(env.VISTAL_CONTEXT)
    } catch {
      throw new Error("VISTAL_CONTEXT must be valid JSON.")
    }
  }

  const httpPort = env.VISTAL_HTTP_PORT ? Number(env.VISTAL_HTTP_PORT) : undefined
  if (httpPort !== undefined && Number.isNaN(httpPort)) {
    throw new Error("VISTAL_HTTP_PORT must be a number.")
  }

  return {
    databaseUrl,
    provider,
    policyFile: env.VISTAL_POLICY_FILE,
    tables: csv(env.VISTAL_TABLES),
    exclude: csv(env.VISTAL_EXCLUDE),
    context,
    httpPort,
  }
}
