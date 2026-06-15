import type { SchemaMap, ResourceSchema, FieldSchema, FieldType } from "@valv/core"

export interface ClickHouseClient {
  // json() is non-generic here so the interface is structurally compatible with
  // @clickhouse/client's ResultSet (whose json() returns a concrete union type
  // rather than the arbitrary T the generic would require).
  query(params: { query: string; format?: string }): Promise<{ json(): Promise<unknown> }>
}

interface SysColumn {
  table: string
  name: string
  type: string
  position: number
  default_kind: string
  is_in_primary_key: number
  comment: string
}

interface SysTable {
  name: string
  comment: string
}

export async function introspectClickHouse(
  client: ClickHouseClient,
  database?: string,
): Promise<SchemaMap> {
  const db = database ?? (await resolveDatabase(client))

  const [columns, tables] = await Promise.all([
    client
      .query({
        query: `
        SELECT table, name, type, position, default_kind, is_in_primary_key, comment
        FROM system.columns
        WHERE database = '${db}'
        ORDER BY table, position
      `,
        format: "JSONEachRow",
      })
      .then((r) => r.json() as Promise<SysColumn[]>),
    client
      .query({
        query: `
        SELECT name, comment
        FROM system.tables
        WHERE database = '${db}'
      `,
        format: "JSONEachRow",
      })
      .then((r) => r.json() as Promise<SysTable[]>),
  ])

  const tableComments: Record<string, string> = {}
  for (const t of tables) {
    tableComments[t.name] = t.comment ?? ""
  }

  // Group columns by table
  const byTable: Record<string, SysColumn[]> = {}
  for (const col of columns) {
    if (!byTable[col.table]) byTable[col.table] = []
    byTable[col.table].push(col)
  }

  const resources: Record<string, ResourceSchema> = {}

  for (const [tableName, cols] of Object.entries(byTable)) {
    const resourceName = tableName
    const fields: Record<string, FieldSchema> = {}

    // Determine the id column: prefer one literally named "id", else first primary key col
    const idColName =
      cols.find((c) => c.name === "id")?.name ??
      cols.find((c) => Number(c.is_in_primary_key) === 1)?.name

    for (const col of cols) {
      const { baseType, isNullable } = unwrapType(col.type)
      const fieldType = mapClickHouseType(baseType)
      if (!fieldType) continue

      const comment = col.comment ?? ""
      const fieldSchema: FieldSchema = {
        name: col.name,
        type: fieldType,
        isNullable,
        isId: col.name === idColName,
        hasDefaultValue: col.default_kind !== "",
        description: parseDescription(comment) ?? undefined,
        sensitive: parseSensitive(comment),
      }

      if (fieldType === "enum") {
        fieldSchema.enumValues = parseEnumValues(baseType)
      }

      fields[col.name] = fieldSchema
    }

    const tableComment = tableComments[tableName] ?? ""
    resources[resourceName] = {
      name: resourceName,
      tableName,
      fields,
      relations: {},
      description: parseDescription(tableComment) ?? undefined,
    }
  }

  return { resources }
}

async function resolveDatabase(client: ClickHouseClient): Promise<string> {
  const result = await client
    .query({
      query: "SELECT currentDatabase() AS db",
      format: "JSONEachRow",
    })
    .then((r) => r.json() as Promise<{ db: string }[]>)
  return result[0]?.db ?? "default"
}

function unwrapType(rawType: string): { baseType: string; isNullable: boolean } {
  let t = rawType.trim()
  let isNullable = false

  if (t.startsWith("Nullable(") && t.endsWith(")")) {
    isNullable = true
    t = t.slice("Nullable(".length, -1)
  }

  if (t.startsWith("LowCardinality(") && t.endsWith(")")) {
    t = t.slice("LowCardinality(".length, -1)
    // LowCardinality(Nullable(X)) is unusual but handle it
    if (t.startsWith("Nullable(") && t.endsWith(")")) {
      isNullable = true
      t = t.slice("Nullable(".length, -1)
    }
  }

  return { baseType: t, isNullable }
}

function mapClickHouseType(t: string): FieldType | null {
  if (t === "String" || t.startsWith("FixedString(")) return "string"
  if (
    t.startsWith("Int") ||
    t.startsWith("UInt") ||
    t.startsWith("Float") ||
    t.startsWith("Decimal")
  )
    return "number"
  if (t === "Bool" || t === "Boolean") return "boolean"
  if (t.startsWith("Date") || t.startsWith("DateTime")) return "date"
  if (t === "UUID") return "uuid"
  if (t.startsWith("Enum8(") || t.startsWith("Enum16(")) return "enum"
  if (
    t.startsWith("Array(") ||
    t.startsWith("Map(") ||
    t.startsWith("Tuple(") ||
    t.startsWith("Nested(") ||
    t === "JSON" ||
    t.startsWith("IPv") ||
    t === "Object('json')"
  )
    return "json"
  return null
}

function parseEnumValues(enumType: string): string[] {
  // Enum8('a' = 1, 'b' = 2) → ['a', 'b']
  const inner = enumType.replace(/^Enum\d+\(/, "").replace(/\)$/, "")
  const values: string[] = []
  for (const entry of inner.split(",")) {
    const match = entry.trim().match(/^'(.*?)'\s*=\s*\d+$/)
    if (match) values.push(match[1])
  }
  return values
}

function parseDescription(doc: string): string | null {
  const match = doc.match(/@valv:description\s+"([^"]+)"/)
  return match ? match[1] : null
}

function parseSensitive(doc: string): boolean {
  return /@valv:sensitive/.test(doc)
}
